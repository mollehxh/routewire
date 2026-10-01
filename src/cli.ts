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

  const runtime = await startSideband({
    cwd: process.cwd(),
    ...options,
  });

  process.stdout.write(`[sideband] project: ${runtime.cwd}\n`);
  process.stdout.write(`[sideband] model: ${runtime.model}\n`);
  process.stdout.write(`[sideband] MCP: ${runtime.mcpUrl}\n`);
  process.stdout.write(`[sideband] provider: ${runtime.providerBaseUrl}\n`);

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
