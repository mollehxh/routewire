import spawn from "cross-spawn";

import {
  forceTerminateProcessTree,
  shouldCreateProcessGroup,
  terminateProcessTree,
} from "../process-tree.js";
import { buildCodexArgs } from "./command.js";
import type { CodexApprovalPolicy, CodexSandboxMode } from "../tui-settings.js";

export interface StartCodexProcessOptions {
  cwd: string;
  model: string;
  providerBaseUrl: string;
  codexHome?: string;
  dangerFullAccess?: boolean;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  fastMode?: boolean;
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
  forceTerminate(): void;
}

export function startCodexProcess(options: StartCodexProcessOptions): CodexProcessHandle {
  const args = buildCodexArgs({
    model: options.model,
    providerBaseUrl: options.providerBaseUrl,
    dangerFullAccess: options.dangerFullAccess,
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    fastMode: options.fastMode,
  });

  const env = { ...process.env };
  if (options.codexHome) env.CODEX_HOME = options.codexHome;

  const child = spawn(options.command ?? "codex", args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: shouldCreateProcessGroup(),
  });

  // Quiet controls presentation, never consumption of the child's pipes.
  child.stdout?.on("data", chunk => {
    if (!options.quiet) process.stdout.write(`[codex stdout] ${String(chunk)}`);
  });
  child.stderr?.on("data", chunk => {
    if (!options.quiet) process.stderr.write(`[codex stderr] ${String(chunk)}`);
  });

  child.stdin?.on("error", () => undefined);
  child.stdin?.end("Routewire bridge turn. Follow the model response.\n");

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
      terminateProcessTree(child);
    },
    forceTerminate() {
      forceTerminateProcessTree(child);
    },
  };
}
