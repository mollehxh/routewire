import fs from "node:fs";
import {promises as fsPromises} from "node:fs";
import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";

import {routewireEnvFlag} from "./env.js";
import {ROUTEWIRE_NAME, ROUTEWIRE_VERSION} from "./meta.js";

export type RoutewirePackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface RoutewireUpdateAction {
  command: string;
  args: string[];
  display: string;
}

export interface RoutewireUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  action: RoutewireUpdateAction;
}

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
  registry: string;
}

export interface RoutewireUpdateCheckOptions {
  currentVersion?: string;
  registry?: string;
  cacheFile?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  packageManager?: RoutewirePackageManager;
}

export interface RoutewireUpdateInstallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 1_200;
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1_000;
const INSTALL_TERMINATION_GRACE_MS = 1_000;

export async function checkForRoutewireUpdate(
  options: RoutewireUpdateCheckOptions = {},
): Promise<RoutewireUpdateInfo | undefined> {
  if (routewireEnvFlag("ROUTEWIRE_DISABLE_UPDATE_CHECK")) return undefined;

  const currentVersion = options.currentVersion ?? ROUTEWIRE_VERSION;
  const cacheFile = options.cacheFile ?? defaultUpdateCacheFile();
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const registry = ensureTrailingSlash(options.registry ?? process.env.npm_config_registry ?? "https://registry.npmjs.org/");
  const cached = await readUpdateCache(cacheFile);
  const checkedAt = now();

  const cachedUpdate = cached && cached.registry === registry
    ? updateInfo(currentVersion, cached.latestVersion, options.packageManager)
    : undefined;

  if (
    cached &&
    cached.registry === registry &&
    checkedAt - cached.checkedAt >= 0 &&
    checkedAt - cached.checkedAt < cacheTtlMs &&
    cachedUpdate
  ) {
    return cachedUpdate;
  }

  try {
    const url = new URL(`${ROUTEWIRE_NAME}/latest`, registry);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: {accept: "application/json"},
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as {version?: unknown};
    if (typeof payload.version !== "string") return undefined;
    const latestVersion = payload.version.trim();
    if (!parseSemver(latestVersion)) return undefined;
    await writeUpdateCache(cacheFile, {checkedAt: now(), latestVersion, registry});
    return updateInfo(currentVersion, latestVersion, options.packageManager);
  } catch {
    return undefined;
  }
}

export function createRoutewireUpdateAction(
  version: string,
  packageManager: RoutewirePackageManager = detectRoutewirePackageManager(),
): RoutewireUpdateAction {
  const spec = `${ROUTEWIRE_NAME}@${version}`;
  if (packageManager === "pnpm") {
    return {command: "pnpm", args: ["add", "--global", spec], display: `pnpm add -g ${spec}`};
  }
  if (packageManager === "yarn") {
    return {command: "yarn", args: ["global", "add", spec], display: `yarn global add ${spec}`};
  }
  if (packageManager === "bun") {
    return {command: "bun", args: ["add", "--global", spec], display: `bun add -g ${spec}`};
  }
  return {
    command: "npm",
    args: ["install", "--global", "--prefer-online", spec],
    display: `npm install -g --prefer-online ${spec}`,
  };
}

export function detectRoutewirePackageManager(): RoutewirePackageManager {
  const userAgent = process.env.npm_config_user_agent?.toLowerCase() ?? "";
  const executable = resolvedArgv1().toLowerCase();
  const hint = `${userAgent} ${executable}`;
  if (/\bpnpm\//.test(userAgent) || /(?:^|[\\/])(?:\.pnpm|pnpm)(?:[\\/]|-global|$)/.test(hint)) return "pnpm";
  const yarnMajor = /\byarn\/(\d+)/.exec(userAgent)?.[1];
  if (yarnMajor === "1" || /(?:^|[\\/])yarn[\\/]global(?:[\\/]|$)/.test(executable)) return "yarn";
  if (/\bbun\//.test(userAgent) || /(?:^|[\\/])\.bun(?:[\\/]|$)/.test(hint)) return "bun";
  return "npm";
}

export async function installRoutewireUpdate(
  update: RoutewireUpdateInfo,
  options: RoutewireUpdateInstallOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw new Error("Update cancelled");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(update.action.command, update.action.args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let output = "";
    let terminationError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      terminate(new Error(`Update timed out after ${formatTimeout(timeoutMs)}`));
    }, timeoutMs);
    timeout.unref?.();

    const append = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-16_384);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      signalInstaller(child.pid, () => child.kill("SIGTERM"), "SIGTERM");
      forceKillTimer = setTimeout(() => {
        signalInstaller(child.pid, () => child.kill("SIGKILL"), "SIGKILL");
        finish(() => reject(error));
      }, INSTALL_TERMINATION_GRACE_MS);
      forceKillTimer.unref?.();
    };
    const onAbort = () => terminate(new Error("Update cancelled"));

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    options.signal?.addEventListener("abort", onAbort, {once: true});
    child.once("error", error => {
      finish(() => reject(terminationError ?? error));
    });
    child.once("close", code => {
      finish(() => {
        if (terminationError) reject(terminationError);
        else if (code === 0) resolve();
        else reject(new Error(installFailureMessage(output, code)));
      });
    });
  });
}

function updateInfo(
  currentVersion: string,
  latestVersion: string,
  packageManager?: RoutewirePackageManager,
): RoutewireUpdateInfo | undefined {
  const comparison = compareSemver(latestVersion, currentVersion);
  if (comparison === undefined || comparison <= 0) return undefined;
  return {
    currentVersion,
    latestVersion,
    action: createRoutewireUpdateAction(latestVersion, packageManager),
  };
}

function compareSemver(left: string, right: string): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index]! - b.core[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const count = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < count; index += 1) {
    const av = a.pre[index];
    const bv = b.pre[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av) ? Number(av) : undefined;
    const bn = /^\d+$/.test(bv) ? Number(bv) : undefined;
    if (an !== undefined && bn !== undefined) return Math.sign(an - bn);
    if (an !== undefined) return -1;
    if (bn !== undefined) return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function parseSemver(value: string): {core: [number, number, number]; pre: string[]} | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]?.split(".") ?? [],
  };
}

async function readUpdateCache(file: string): Promise<UpdateCache | undefined> {
  try {
    const parsed = JSON.parse(await fsPromises.readFile(file, "utf8")) as Partial<UpdateCache>;
    if (
      !Number.isFinite(parsed.checkedAt) ||
      typeof parsed.latestVersion !== "string" ||
      typeof parsed.registry !== "string"
    ) return undefined;
    const latestVersion = parsed.latestVersion.trim();
    if (!parseSemver(latestVersion)) return undefined;
    return {checkedAt: parsed.checkedAt!, latestVersion, registry: parsed.registry};
  } catch {
    return undefined;
  }
}

async function writeUpdateCache(file: string, cache: UpdateCache): Promise<void> {
  try {
    await fsPromises.mkdir(path.dirname(file), {recursive: true});
    await fsPromises.writeFile(file, `${JSON.stringify(cache)}\n`, {mode: 0o600});
  } catch {
    // Update checks are advisory; cache failures must never block startup.
  }
}

function defaultUpdateCacheFile(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "routewire", "cache", "update-check.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "routewire", "update-check.json");
  }
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(base, "routewire", "update-check.json");
}

function resolvedArgv1(): string {
  const value = process.argv[1];
  if (!value) return "";
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function installFailureMessage(output: string, code: number | null): string {
  const cleaned = output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1);
  return cleaned ?? `Update command exited with code ${String(code)}`;
}

function signalInstaller(pid: number | undefined, fallback: () => boolean, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && pid) {
    try {
      const args = ["/pid", String(pid), "/t"];
      if (signal === "SIGKILL") args.push("/f");
      const killer = spawn("taskkill", args, {stdio: "ignore", windowsHide: true});
      let fellBack = false;
      const runFallback = () => {
        if (fellBack) return;
        fellBack = true;
        try {
          fallback();
        } catch {
          // The installer may already have exited.
        }
      };
      killer.once("error", runFallback);
      killer.once("close", code => {
        if (code !== 0) runFallback();
      });
      return;
    } catch {
      // Fall through to direct-child signaling when taskkill cannot start.
    }
  }

  try {
    if (pid) {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // Fall back to direct-child signaling if the process group already vanished.
  }
  try {
    fallback();
  } catch {
    // The process may already have exited between the timeout/abort and signal.
  }
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) return `${timeoutMs / 60_000}m`;
  if (timeoutMs >= 1_000 && timeoutMs % 1_000 === 0) return `${timeoutMs / 1_000}s`;
  return `${timeoutMs}ms`;
}
