#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { parseCliOptions } from "./cli-options.js";
import { loadCodexModelCatalog } from "./model-catalog.js";
import { startSideband, type SidebandRuntime } from "./runtime.js";
import { RunwireTui } from "./tui.js";
import { apiKeyPath, hasStoredApiKey, type RunwireSettings } from "./tui-settings.js";

const HELP = `sideband

Expose the live Codex model-facing tool surface as a local MCP server.

Usage:
  sideband [options]

Options:
  --host <host>           Loopback bind address (default: 127.0.0.1)
  --port <port>           Local port, 0 chooses an available port (default: 0)
  --model <model>         Codex model identity (default: gpt-5.6-sol)
  --codex-home <path>     Override CODEX_HOME for the child Codex process
  --tunnel-id <id>        OpenAI Secure MCP Tunnel ID (or SIDEBAND_TUNNEL_ID)
  --tunnel-api-key-file <path>
                           Runtime API key file (or SIDEBAND_TUNNEL_API_KEY_FILE)
  --tunnel-client <path>  Override the pinned auto-downloaded tunnel-client
  --danger-full-access    Start Codex with full filesystem access and no approvals
  -h, --help              Show this help
`;

let activeTui: RunwireTui | undefined;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }

  const options = parseCliOptions(args);
  if (process.stdout.isTTY) {
    await runInteractive(options);
    return;
  }
  await runHeadless(options);
}

export async function runInteractive(options: ReturnType<typeof parseCliOptions>): Promise<void> {
  const model = options.model ?? "gpt-5.6-sol";
  const tunnelId = options.tunnelId ?? process.env.SIDEBAND_TUNNEL_ID;
  const tunnelApiKeyFile = options.tunnelApiKeyFile ?? process.env.SIDEBAND_TUNNEL_API_KEY_FILE;
  const tunnelClient = options.tunnelClient ?? process.env.SIDEBAND_TUNNEL_CLIENT;
  const externalApiKey = Boolean(process.env.CONTROL_PLANE_API_KEY || tunnelApiKeyFile);
  const modelCatalog = loadCodexModelCatalog(options.codexHome);

  let runtime: SidebandRuntime | undefined;
  let closingRuntime = false;
  let quitting = false;
  let quitResolve: (() => void) | undefined;
  let operation = Promise.resolve();
  let requestQuit = () => undefined;

  const tui = new RunwireTui({
    cwd: process.cwd(),
    model,
    modelCatalog,
    loadModelCatalog: () => loadCodexModelCatalog(options.codexHome),
    initialSettings: {
      ...(tunnelId ? { tunnelEnabled: true, tunnelId } : {}),
      ...(options.dangerFullAccess
        ? { sandboxMode: "danger-full-access" as const, approvalPolicy: "never" as const }
        : {}),
    },
    externalApiKey,
    onStart: settings => {
      operation = operation.then(() => launch(settings)).catch(error => {
        tui.setRuntimeState("error", errorMessage(error));
      });
    },
    onStop: () => {
      operation = operation.then(stopRuntime).catch(error => {
        tui.setRuntimeState("error", errorMessage(error));
      });
    },
    onQuit: () => requestQuit(),
  });
  activeTui = tui;
  tui.start();

  requestQuit = () => {
    if (quitting) return;
    quitting = true;
    operation = operation.then(async () => {
      try {
        await stopRuntime();
      } finally {
        tui.stop();
        activeTui = undefined;
        quitResolve?.();
      }
    }).catch(error => process.stderr.write(`[sideband] ${errorMessage(error)}\n`)).then(() => undefined);
  };

  async function launch(settings: RunwireSettings): Promise<void> {
    validateLaunchSettings(settings, tunnelApiKeyFile);
    if (runtime) await stopRuntime();
    tui.setRuntimeState("starting");
    closingRuntime = false;

    const storedKeyFile = !externalApiKey && hasStoredApiKey() ? apiKeyPath() : undefined;
    const currentModelCatalog = loadCodexModelCatalog(options.codexHome);
    const next = await startSideband({
      cwd: process.cwd(),
      host: options.host,
      port: options.port,
      model,
      codexHome: options.codexHome,
      sandboxMode: settings.sandboxMode,
      approvalPolicy: "never",
      fastMode: settings.fastMode,
      allowedSubagentModels: settings.allowedSubagentModels,
      modelCatalog: currentModelCatalog,
      quietCodex: true,
      onEvent: event => tui.handle(event),
      tunnel: settings.tunnelEnabled
        ? {
            tunnelId: settings.tunnelId,
            apiKeyFile: tunnelApiKeyFile ?? storedKeyFile,
            command: tunnelClient,
            quiet: true,
          }
        : undefined,
    });
    runtime = next;
    tui.setRuntimeState("running");

    void next.codexExited.then(exit => {
      if (runtime !== next || closingRuntime) return;
      operation = operation.then(async () => {
        if (runtime !== next) return;
        await stopRuntime();
        const message = exit.error?.message ?? `Codex exited (code=${String(exit.code)})`;
        tui.setRuntimeState(exit.code === 0 ? "stopped" : "error", exit.code === 0 ? "" : message);
      }).catch(error => tui.setRuntimeState("error", errorMessage(error)));
    });
  }

  async function stopRuntime(): Promise<void> {
    const current = runtime;
    if (!current) {
      tui.setRuntimeState("stopped");
      return;
    }
    closingRuntime = true;
    tui.setRuntimeState("stopping");
    try {
      await current.close();
      tui.setRuntimeState("stopped");
    } finally {
      if (runtime === current) runtime = undefined;
      closingRuntime = false;
    }
  }

  const restoreOnExit = () => tui.stop();
  process.once("exit", restoreOnExit);
  process.once("SIGINT", requestQuit);
  process.once("SIGTERM", requestQuit);

  await new Promise<void>(resolve => {
    quitResolve = resolve;
  });
  process.off("exit", restoreOnExit);
  process.off("SIGINT", requestQuit);
  process.off("SIGTERM", requestQuit);
}

async function runHeadless(options: ReturnType<typeof parseCliOptions>): Promise<void> {
  const tunnelId = options.tunnelId ?? process.env.SIDEBAND_TUNNEL_ID;
  const tunnelApiKeyFile = options.tunnelApiKeyFile ?? process.env.SIDEBAND_TUNNEL_API_KEY_FILE;
  const tunnelClient = options.tunnelClient ?? process.env.SIDEBAND_TUNNEL_CLIENT;
  const runtime = await startSideband({
    cwd: process.cwd(),
    host: options.host,
    port: options.port,
    model: options.model,
    codexHome: options.codexHome,
    dangerFullAccess: options.dangerFullAccess,
    quietCodex: false,
    tunnel: tunnelId
      ? { tunnelId, apiKeyFile: tunnelApiKeyFile, command: tunnelClient }
      : undefined,
  });

  process.stdout.write(`[sideband] project: ${runtime.cwd}\n`);
  process.stdout.write(`[sideband] model: ${runtime.model}\n`);
  process.stdout.write(`[sideband] MCP: ${runtime.mcpUrl}\n`);
  process.stdout.write(`[sideband] provider: ${runtime.providerBaseUrl}\n`);
  process.stdout.write(
    runtime.tunnelHealthUrl
      ? `[sideband] Secure MCP Tunnel: ready (${runtime.tunnelHealthUrl})\n`
      : "[sideband] Secure MCP Tunnel: not configured\n",
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  const exit = await runtime.codexExited;
  if (!stopping) {
    stopping = true;
    await runtime.close();
    if (exit.error) throw exit.error;
    if (exit.code !== 0) throw new Error(`Codex exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)})`);
  }
}

function validateLaunchSettings(settings: RunwireSettings, externalApiKeyFile?: string): void {
  if (!settings.tunnelEnabled) return;
  if (!/^tunnel_[A-Za-z0-9._-]+$/.test(settings.tunnelId)) {
    throw new Error("Set a valid Tunnel ID in Connection before starting");
  }
  if (!process.env.CONTROL_PLANE_API_KEY && !externalApiKeyFile && !hasStoredApiKey()) {
    throw new Error("Add the tunnel API key in Connection before starting");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(error => {
  activeTui?.stop();
  activeTui = undefined;
  process.stderr.write(`[sideband] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
