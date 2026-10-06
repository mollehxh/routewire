#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { parseCliOptions } from "./cli-options.js";
import { routewireEnv } from "./env.js";
import { ROUTEWIRE_VERSION } from "./meta.js";
import { loadCodexModelCatalog } from "./model-catalog.js";
import { startRoutewire, type RoutewireRuntime } from "./runtime.js";
import { RoutewireTui } from "./tui.js";
import { hasStoredApiKey, loadRoutewireSettings, storedApiKeyPath, type RoutewireSettings } from "./tui-settings.js";
import {checkForRoutewireUpdate, installRoutewireUpdate, type RoutewireUpdateInfo} from "./update.js";

const HELP = `routewire

Expose the live Codex model-facing tool surface as a local MCP server.

Usage:
  routewire [options]

Options:
  --host <host>           Loopback bind address (default: 127.0.0.1)
  --port <port>           Local port, 0 chooses an available port (default: 0)
  --model <model>         Codex model identity (default: gpt-5.6-sol)
  --codex-home <path>     Override CODEX_HOME for the child Codex process
  --tunnel-id <id>        OpenAI Secure MCP Tunnel ID (or ROUTEWIRE_TUNNEL_ID)
  --tunnel-api-key-file <path>
                           Runtime API key file (or ROUTEWIRE_TUNNEL_API_KEY_FILE)
  --tunnel-client <path>  Override the pinned auto-downloaded tunnel-client
  --danger-full-access    Start Codex with full filesystem access and no approvals
  -v, --version           Show the Routewire version
  -h, --help              Show this help
`;

let activeTui: RoutewireTui | undefined;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("-v") || args.includes("--version")) {
    process.stdout.write(`${ROUTEWIRE_VERSION}\n`);
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
  let availableUpdate: RoutewireUpdateInfo | undefined;
  const model = options.model ?? "gpt-5.6-sol";
  const tunnelId = options.tunnelId ?? routewireEnv("ROUTEWIRE_TUNNEL_ID", "SIDEBAND_TUNNEL_ID");
  const tunnelApiKeyFile =
    options.tunnelApiKeyFile ?? routewireEnv("ROUTEWIRE_TUNNEL_API_KEY_FILE", "SIDEBAND_TUNNEL_API_KEY_FILE");
  const tunnelClient =
    options.tunnelClient ?? routewireEnv("ROUTEWIRE_TUNNEL_CLIENT", "SIDEBAND_TUNNEL_CLIENT");
  const externalApiKey = Boolean(process.env.CONTROL_PLANE_API_KEY || tunnelApiKeyFile);
  const modelCatalog = loadCodexModelCatalog(options.codexHome);

  let runtime: RoutewireRuntime | undefined;
  let closingRuntime = false;
  let quitting = false;
  let updateAbort: AbortController | undefined;
  let quitResolve: (() => void) | undefined;
  let operation = Promise.resolve();
  let requestQuit = () => undefined;

  const tui = new RoutewireTui({
    cwd: process.cwd(),
    model,
    modelCatalog,
    loadModelCatalog: () => loadCodexModelCatalog(options.codexHome),
    initialSettings: {
      ...(tunnelId ? { tunnelId } : {}),
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
    checkingForUpdate: true,
    onUpdate: () => {
      const update = availableUpdate;
      if (!update) return;
      const abort = new AbortController();
      updateAbort = abort;
      operation = operation.then(async () => {
        try {
          await installRoutewireUpdate(update, {signal: abort.signal});
          quitting = true;
          tui.stop();
          activeTui = undefined;
          process.stdout.write(
            `[routewire] Updated to ${update.latestVersion}. Restart Routewire to use the new version.\n`,
          );
          quitResolve?.();
        } catch (error) {
          if (!quitting) tui.setUpdateError(errorMessage(error));
        } finally {
          if (updateAbort === abort) updateAbort = undefined;
        }
      });
    },
  });
  activeTui = tui;

  requestQuit = () => {
    if (quitting) return;
    quitting = true;
    updateAbort?.abort();
    operation = operation.then(async () => {
      try {
        await stopRuntime();
      } finally {
        tui.stop();
        activeTui = undefined;
        quitResolve?.();
      }
    }).catch(error => process.stderr.write(`[routewire] ${errorMessage(error)}\n`)).then(() => undefined);
  };
  tui.start();
  void checkForRoutewireUpdate().then(update => {
    if (quitting) return;
    availableUpdate = update;
    if (update) tui.showAvailableUpdate(update);
    else tui.finishUpdateCheck();
  }).catch(() => {
    if (!quitting) tui.finishUpdateCheck();
  });

  async function launch(settings: RoutewireSettings): Promise<void> {
    validateLaunchSettings(settings, tunnelApiKeyFile);
    if (runtime) await stopRuntime();
    tui.setRuntimeState("starting");
    closingRuntime = false;

    const storedKeyFile = !externalApiKey ? storedApiKeyPath() : undefined;
    const currentModelCatalog = loadCodexModelCatalog(options.codexHome);
    const next = await startRoutewire({
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
      tunnel: {
        tunnelId: settings.tunnelId,
        apiKeyFile: tunnelApiKeyFile ?? storedKeyFile,
        command: tunnelClient,
        quiet: true,
      },
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

export async function runHeadless(options: ReturnType<typeof parseCliOptions>): Promise<void> {
  const settings = loadRoutewireSettings();
  const tunnelId = options.tunnelId ?? routewireEnv("ROUTEWIRE_TUNNEL_ID", "SIDEBAND_TUNNEL_ID") ?? settings.tunnelId;
  const tunnelApiKeyFile =
    options.tunnelApiKeyFile ?? routewireEnv("ROUTEWIRE_TUNNEL_API_KEY_FILE", "SIDEBAND_TUNNEL_API_KEY_FILE");
  const tunnelClient =
    options.tunnelClient ?? routewireEnv("ROUTEWIRE_TUNNEL_CLIENT", "SIDEBAND_TUNNEL_CLIENT");
  validateLaunchSettings({ ...settings, tunnelId }, tunnelApiKeyFile);
  const runtime = await startRoutewire({
    cwd: process.cwd(),
    host: options.host,
    port: options.port,
    model: options.model,
    codexHome: options.codexHome,
    dangerFullAccess: options.dangerFullAccess,
    quietCodex: false,
    tunnel: {
      tunnelId,
      apiKeyFile: tunnelApiKeyFile ?? (!process.env.CONTROL_PLANE_API_KEY ? storedApiKeyPath() : undefined),
      command: tunnelClient,
    },
  });

  process.stdout.write(`[routewire] project: ${runtime.cwd}\n`);
  process.stdout.write(`[routewire] model: ${runtime.model}\n`);
  process.stdout.write(`[routewire] MCP: ${runtime.mcpUrl}\n`);
  process.stdout.write(`[routewire] provider: ${runtime.providerBaseUrl}\n`);
  process.stdout.write(`[routewire] Secure MCP Tunnel: ready (${runtime.tunnelHealthUrl})\n`);

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

function validateLaunchSettings(settings: RoutewireSettings, externalApiKeyFile?: string): void {
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
  process.stderr.write(`[routewire] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
