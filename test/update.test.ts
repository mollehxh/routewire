import fs from "node:fs";
import {EventEmitter} from "node:events";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import {afterEach, describe, expect, it, vi} from "vitest";

const mocks = vi.hoisted(() => ({spawn: vi.fn()}));
vi.mock("cross-spawn", () => ({default: mocks.spawn}));

import {
  checkForRoutewireUpdate,
  createRoutewireUpdateAction,
  detectRoutewirePackageManager,
  installRoutewireUpdate,
  type RoutewireUpdateInfo,
} from "../src/update.js";

const cleanup: string[] = [];
const originalArgv1 = process.argv[1];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  mocks.spawn.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalArgv1 === undefined) process.argv.splice(1, 1);
  else process.argv[1] = originalArgv1;
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);

  constructor(readonly pid?: number) {
    super();
  }
}

const update: RoutewireUpdateInfo = {
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  action: {command: "npm", args: ["install", "--global", "routewire@latest"], display: "npm install -g routewire@latest"},
};

function tempCacheFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-update-"));
  cleanup.push(dir);
  return path.join(dir, "update-check.json");
}

function registryResponse(version: string): Response {
  return new Response(JSON.stringify({version}), {
    status: 200,
    headers: {"content-type": "application/json"},
  });
}

describe("Routewire update checks", () => {
  it("offers a newer npm release and pins the installer to latest", async () => {
    const update = await checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile: tempCacheFile(),
      packageManager: "npm",
      fetchImpl: async () => registryResponse("0.2.0"),
    });

    expect(update).toEqual({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {
        command: "npm",
        args: ["install", "--global", "routewire@latest"],
        display: "npm install -g routewire@latest",
      },
    });
  });

  it("does not offer the same or an older release", async () => {
    for (const latestVersion of ["0.1.0", "0.0.9"]) {
      const update = await checkForRoutewireUpdate({
        currentVersion: "0.1.0",
        cacheFile: tempCacheFile(),
        fetchImpl: async () => registryResponse(latestVersion),
      });
      expect(update).toBeUndefined();
    }
  });

  it("uses a fresh cached registry result across launches", async () => {
    const cacheFile = tempCacheFile();
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return registryResponse("0.3.0");
    };

    const first = await checkForRoutewireUpdate({currentVersion: "0.1.0", cacheFile, fetchImpl, now: () => 10_000});
    const second = await checkForRoutewireUpdate({currentVersion: "0.1.0", cacheFile, fetchImpl, now: () => 10_500});

    expect(first?.latestVersion).toBe("0.3.0");
    expect(second?.latestVersion).toBe("0.3.0");
    expect(fetches).toBe(1);
  });

  it("does not reuse a cached version from a different registry", async () => {
    const cacheFile = tempCacheFile();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const registry = new URL(input).origin;
      return registry === "https://registry.example-a.test"
        ? registryResponse("0.2.0")
        : registryResponse("0.3.0");
    });

    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile,
      registry: "https://registry.example-a.test",
      fetchImpl,
      now: () => 10_000,
    })).resolves.toMatchObject({latestVersion: "0.2.0"});

    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile,
      registry: "https://registry.example-b.test",
      fetchImpl,
      now: () => 10_500,
    })).resolves.toMatchObject({latestVersion: "0.3.0"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired cached registry result", async () => {
    const cacheFile = tempCacheFile();
    let latestVersion = "0.2.0";
    const fetchImpl = vi.fn(async () => registryResponse(latestVersion));

    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile,
      cacheTtlMs: 3_600_000,
      fetchImpl,
      now: () => 1_000,
    })).resolves.toMatchObject({latestVersion: "0.2.0"});

    latestVersion = "0.3.0";
    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile,
      cacheTtlMs: 3_600_000,
      fetchImpl,
      now: () => 3_601_001,
    })).resolves.toMatchObject({latestVersion: "0.3.0"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails open when the registry cannot be reached", async () => {
    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile: tempCacheFile(),
      fetchImpl: async () => { throw new Error("offline"); },
    })).resolves.toBeUndefined();
  });

  it("fails open for non-OK and malformed registry responses", async () => {
    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile: tempCacheFile(),
      fetchImpl: async () => new Response("not found", {status: 404}),
    })).resolves.toBeUndefined();
    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile: tempCacheFile(),
      fetchImpl: async () => new Response(JSON.stringify({version: "latest"}), {status: 200}),
    })).resolves.toBeUndefined();
  });

  it("honors the documented update-check opt out without touching the registry", async () => {
    vi.stubEnv("ROUTEWIRE_DISABLE_UPDATE_CHECK", "1");
    const fetchImpl = vi.fn();
    await expect(checkForRoutewireUpdate({
      currentVersion: "0.1.0",
      cacheFile: tempCacheFile(),
      fetchImpl,
    })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds install commands for supported package managers", () => {
    expect(createRoutewireUpdateAction("pnpm").display).toBe("pnpm add -g routewire@latest");
    expect(createRoutewireUpdateAction("yarn").display).toBe("yarn global add routewire@latest");
    expect(createRoutewireUpdateAction("bun").display).toBe("bun add -g routewire@latest");
  });

  it("detects the package manager from runtime hints", () => {
    vi.stubEnv("npm_config_user_agent", "pnpm/10.0.0 npm/? node/v24");
    expect(detectRoutewirePackageManager()).toBe("pnpm");

    vi.stubEnv("npm_config_user_agent", "yarn/1.22.22 npm/? node/v24");
    expect(detectRoutewirePackageManager()).toBe("yarn");

    vi.stubEnv("npm_config_user_agent", "yarn/4.9.2 npm/? node/v24");
    expect(detectRoutewirePackageManager()).toBe("npm");

    vi.stubEnv("npm_config_user_agent", "bun/1.3.0 npm/? node/v24");
    expect(detectRoutewirePackageManager()).toBe("bun");

    vi.stubEnv("npm_config_user_agent", "");
    process.argv[1] = "/tmp/pnpm/global/5/.pnpm/routewire@0.2.0/node_modules/routewire/dist/cli.js";
    expect(detectRoutewirePackageManager()).toBe("pnpm");

    process.argv[1] = "/tmp/node_modules/routewire/dist/cli.js";
    expect(detectRoutewirePackageManager()).toBe("npm");
  });
});

describe("Routewire update installer", () => {
  it("does not spawn when cancellation happened before the installer starts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(installRoutewireUpdate(update, {signal: controller.signal})).rejects.toThrow("Update cancelled");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("resolves when the package manager exits successfully", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const result = installRoutewireUpdate(update);
    child.emit("close", 0);
    await expect(result).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("surfaces the final package-manager error line on a nonzero exit", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const result = installRoutewireUpdate(update);
    child.stderr.write("npm error first line\nnpm error permission denied\n");
    child.emit("close", 1);
    await expect(result).rejects.toThrow("npm error permission denied");
  });

  it("rejects a process spawn error", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const result = installRoutewireUpdate(update);
    child.emit("error", new Error("spawn ENOENT"));
    await expect(result).rejects.toThrow("spawn ENOENT");
  });

  it("terminates an installer that exceeds the bounded timeout", async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = new FakeChild(42_424);
    mocks.spawn.mockReturnValue(child);
    const result = installRoutewireUpdate(update, {timeoutMs: 50});
    const rejection = expect(result).rejects.toThrow("Update timed out after 50ms");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.spawn).toHaveBeenCalledWith("npm", ["install", "--global", "routewire@latest"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    else expect(processKill).toHaveBeenCalledWith(-42_424, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    if (process.platform === "win32") expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    else expect(processKill).toHaveBeenLastCalledWith(-42_424, "SIGKILL");
  });

  it("terminates the installer when startup is cancelled", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const result = installRoutewireUpdate(update, {signal: controller.signal});
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(result).rejects.toThrow("Update cancelled");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("terminates the full installer process tree on Windows", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const installer = new FakeChild(51_515);
    const taskkillTerm = new FakeChild();
    const taskkillForce = new FakeChild();
    mocks.spawn
      .mockReturnValueOnce(installer)
      .mockReturnValueOnce(taskkillTerm)
      .mockReturnValueOnce(taskkillForce);

    const result = installRoutewireUpdate(update, {timeoutMs: 50});
    const rejection = expect(result).rejects.toThrow("Update timed out after 50ms");
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.spawn).toHaveBeenNthCalledWith(2, "taskkill", ["/pid", "51515", "/t"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.spawn).toHaveBeenNthCalledWith(3, "taskkill", ["/pid", "51515", "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await rejection;
  });
});
