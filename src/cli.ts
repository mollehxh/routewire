#!/usr/bin/env node

import { parseCliOptions } from "./cli-options.js";
import { startSideband } from "./runtime.js";

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
  --danger-full-access    Pass Codex --dangerously-bypass-approvals-and-sandbox
  -h, --help              Show this help
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }

  const options = parseCliOptions(args);
  if (options.dangerFullAccess) {
    process.stderr.write(
      "[sideband] WARNING: --danger-full-access disables Codex approval prompts and sandboxing for native tool execution.\n",
    );
  }

  const tunnelId = options.tunnelId ?? process.env.SIDEBAND_TUNNEL_ID;
  const tunnelApiKeyFile =
    options.tunnelApiKeyFile ?? process.env.SIDEBAND_TUNNEL_API_KEY_FILE;
  const tunnelClient = options.tunnelClient ?? process.env.SIDEBAND_TUNNEL_CLIENT;

  const runtime = await startSideband({
    cwd: process.cwd(),
    host: options.host,
    port: options.port,
    model: options.model,
    codexHome: options.codexHome,
    dangerFullAccess: options.dangerFullAccess,
    tunnel: tunnelId
      ? {
          tunnelId,
          apiKeyFile: tunnelApiKeyFile,
          command: tunnelClient,
        }
      : undefined,
  });

  process.stdout.write(`[sideband] project: ${runtime.cwd}\n`);
  process.stdout.write(`[sideband] model: ${runtime.model}\n`);
  process.stdout.write(`[sideband] MCP: ${runtime.mcpUrl}\n`);
  process.stdout.write(`[sideband] provider: ${runtime.providerBaseUrl}\n`);
  if (runtime.tunnelHealthUrl) {
    process.stdout.write(`[sideband] Secure MCP Tunnel: ready (${runtime.tunnelHealthUrl})\n`);
  } else {
    process.stdout.write("[sideband] Secure MCP Tunnel: not configured\n");
  }

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
    if (exit.code !== 0) {
      throw new Error(
        `Codex exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)})`,
      );
    }
  }
}

main().catch(error => {
  process.stderr.write(`[sideband] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
