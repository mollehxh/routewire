import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import spawn from "cross-spawn";

import {
  forceTerminateProcessTree,
  shouldCreateProcessGroup,
  terminateProcessTree,
} from "../process-tree.js";
import { buildTunnelClientArgs } from "./command.js";

export interface TunnelClientExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface StartTunnelClientOptions {
  tunnelId: string;
  mcpUrl: string;
  apiKeyFile?: string;
  command?: string;
  commandPrefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  quiet?: boolean;
  healthCheckIntervalMs?: number;
  healthFailureThreshold?: number;
  maxControlPlanePollAgeSeconds?: number;
}

export interface TunnelClientHandle {
  readonly healthUrl: string;
  readonly exited: Promise<TunnelClientExit>;
  readonly unhealthy: Promise<Error>;
  close(): Promise<void>;
}

export async function startTunnelClient(
  options: StartTunnelClientOptions,
): Promise<TunnelClientHandle> {
  validateTunnelId(options.tunnelId);
  validateLoopbackMcpUrl(options.mcpUrl);

  const env = options.env ?? process.env;
  if (!options.apiKeyFile && !env.CONTROL_PLANE_API_KEY) {
    throw new Error(
      "OpenAI Secure MCP Tunnel requires CONTROL_PLANE_API_KEY or --tunnel-api-key-file",
    );
  }

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sideband-tunnel-"));
  const healthUrlFile = path.join(stateDir, "health.url");
  const args = [
    ...(options.commandPrefixArgs ?? []),
    ...buildTunnelClientArgs({
      tunnelId: options.tunnelId,
      mcpUrl: options.mcpUrl,
      healthUrlFile,
      apiKeyFile: options.apiKeyFile,
    }),
  ];

  let child: ChildProcess | undefined;
  try {
    child = spawn(options.command ?? "tunnel-client", args, {
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: shouldCreateProcessGroup(),
    });

    // Always drain both pipes. A quiet child that keeps writing logs will eventually
    // block once the OS pipe buffer fills if nobody reads from stdout/stderr. That
    // can leave tunnel-client alive and locally ready while it stops polling the
    // control plane. `quiet` controls presentation only, never consumption.
    child.stdout?.on("data", chunk => {
      if (!options.quiet) process.stdout.write(`[tunnel stdout] ${String(chunk)}`);
    });
    child.stderr?.on("data", chunk => {
      if (!options.quiet) process.stderr.write(`[tunnel stderr] ${String(chunk)}`);
    });

    const exited = observeExit(child);
    const healthUrl = await waitForReady({
      child,
      exited,
      healthUrlFile,
      timeoutMs: options.readyTimeoutMs ?? 30_000,
    });
    const healthMonitor = startHealthMonitor({
      healthUrl,
      intervalMs: options.healthCheckIntervalMs ?? 15_000,
      failureThreshold: options.healthFailureThreshold ?? 3,
      maxControlPlanePollAgeSeconds: options.maxControlPlanePollAgeSeconds ?? 90,
    });

    let closed = false;
    return {
      healthUrl,
      exited,
      unhealthy: healthMonitor.failed,
      async close() {
        if (closed) return;
        closed = true;
        healthMonitor.stop();
        terminateProcessTree(child!);
        const exitedGracefully = await waitForExit(exited, 2_000);
        if (!exitedGracefully) {
          forceTerminateProcessTree(child!);
          await waitForExit(exited, 1_000);
        }
        await fs.rm(stateDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child) terminateProcessTree(child);
    await fs.rm(stateDir, { recursive: true, force: true });
    throw error;
  }
}

function startHealthMonitor(options: {
  healthUrl: string;
  intervalMs: number;
  failureThreshold: number;
  maxControlPlanePollAgeSeconds: number;
}): { failed: Promise<Error>; stop(): void } {
  let stopped = false;
  let checking = false;
  let consecutiveFailures = 0;
  let resolveFailure!: (error: Error) => void;
  const failed = new Promise<Error>(resolve => {
    resolveFailure = resolve;
  });

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const health = await readTunnelHealth(options.healthUrl);
      const healthy =
        health.ready === true &&
        (health.controlPlanePollAgeSeconds === undefined ||
          health.controlPlanePollAgeSeconds <= options.maxControlPlanePollAgeSeconds);
      consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
      if (!healthy && consecutiveFailures >= options.failureThreshold) {
        stopped = true;
        clearInterval(timer);
        const detail = health.controlPlanePollAgeSeconds === undefined
          ? "health endpoint is not ready"
          : `control-plane poll age is ${Math.round(health.controlPlanePollAgeSeconds)}s`;
        resolveFailure(new Error(`OpenAI tunnel-client became unhealthy: ${detail}`));
      }
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= options.failureThreshold) {
        stopped = true;
        clearInterval(timer);
        const detail = error instanceof Error ? error.message : String(error);
        resolveFailure(new Error(`OpenAI tunnel-client health checks failed: ${detail}`, { cause: error }));
      }
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => void check(), Math.max(100, options.intervalMs));
  timer.unref();
  return {
    failed,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function readTunnelHealth(healthUrl: string): Promise<{
  ready: boolean;
  controlPlanePollAgeSeconds?: number;
}> {
  const response = await fetch(`${healthUrl}/health?details=true`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) return { ready: false };
  const body = await response.json() as unknown;
  if (!isRecord(body)) return { ready: false };
  const components = isRecord(body.components) ? body.components : undefined;
  const controlPlane = components && isRecord(components["control-plane"])
    ? components["control-plane"]
    : undefined;
  const details = controlPlane && isRecord(controlPlane.details) ? controlPlane.details : undefined;
  const pollAge = details?.current_poll_age_seconds;
  return {
    ready: body.ready === true,
    controlPlanePollAgeSeconds: typeof pollAge === "number" && Number.isFinite(pollAge) ? pollAge : undefined,
  };
}

function observeExit(child: ChildProcess): Promise<TunnelClientExit> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: TunnelClientExit) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", error => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

async function waitForReady(options: {
  child: ChildProcess;
  exited: Promise<TunnelClientExit>;
  healthUrlFile: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  let exit: TunnelClientExit | undefined;
  void options.exited.then(value => {
    exit = value;
  });

  while (Date.now() < deadline) {
    if (exit) throw earlyExitError(exit);

    const healthUrl = await readHealthUrl(options.healthUrlFile);
    if (healthUrl && (await healthEndpointReady(healthUrl))) return healthUrl;
    await delay(100);
  }

  if (exit) throw earlyExitError(exit);
  throw new Error(
    "OpenAI tunnel-client did not become ready before the startup timeout; verify the tunnel ID, runtime API key, and Tunnels Read + Use permissions",
  );
}

async function readHealthUrl(file: string): Promise<string | undefined> {
  try {
    const value = (await fs.readFile(file, "utf8")).trim();
    if (!value) return undefined;
    validateHealthUrl(value);
    return value.replace(/\/$/, "");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function healthEndpointReady(healthUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${healthUrl}/readyz`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function validateTunnelId(value: string): void {
  if (!/^tunnel_[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Tunnel ID must start with tunnel_ and include an identifier");
  }
}

function validateLoopbackMcpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid local MCP URL: ${value}`);
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new Error(`Secure MCP Tunnel local server URL must be loopback HTTP; received ${value}`);
  }
}

function validateHealthUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    throw new Error(`tunnel-client returned a non-loopback health URL: ${value}`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function earlyExitError(exit: TunnelClientExit): Error {
  if (exit.error) return new Error(`Failed to start tunnel-client: ${exit.error.message}`, { cause: exit.error });
  return new Error(
    `OpenAI tunnel-client exited during startup (code=${String(exit.code)}, signal=${String(exit.signal)}); verify the runtime API key and tunnel permissions`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForExit(exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}
