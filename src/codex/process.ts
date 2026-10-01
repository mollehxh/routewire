import spawn from "cross-spawn";

import { buildCodexArgs } from "./command.js";

export interface StartCodexProcessOptions {
  cwd: string;
  model: string;
  providerBaseUrl: string;
  dangerFullAccess?: boolean;
  quiet?: boolean;
  command?: string;
}

export interface CodexExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface CodexProcessHandle {
  exited: Promise<CodexExit>;
  terminate(): void;
}

export function startCodexProcess(options: StartCodexProcessOptions): CodexProcessHandle {
  const args = buildCodexArgs({
    model: options.model,
    providerBaseUrl: options.providerBaseUrl,
    dangerFullAccess: options.dangerFullAccess,
  });

  const child = spawn(options.command ?? "codex", args, {
    cwd: options.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  if (!options.quiet) {
    child.stdout?.on("data", chunk => process.stdout.write(`[codex stdout] ${String(chunk)}`));
    child.stderr?.on("data", chunk => process.stderr.write(`[codex stderr] ${String(chunk)}`));
  }

  child.stdin?.on("error", () => undefined);
  child.stdin?.end("Sideband bridge turn. Follow the model response.\n");

  const exited = new Promise<CodexExit>(resolve => {
    let settled = false;
    const finish = (value: CodexExit) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.once("error", error => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });

  return {
    exited,
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
