import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexExit } from "../src/codex/process.js";
import type { RoutewireRuntime } from "../src/runtime.js";
import type { RoutewireTuiOptions } from "../src/tui.js";
import { DEFAULT_ROUTEWIRE_SETTINGS } from "../src/tui-settings.js";

const mocks = vi.hoisted(() => ({
  startRoutewire: vi.fn(),
  checkForRoutewireUpdate: vi.fn(),
  installRoutewireUpdate: vi.fn(),
  instances: [] as Array<{
    options: RoutewireTuiOptions;
    stop: ReturnType<typeof vi.fn>;
    setRuntimeState: ReturnType<typeof vi.fn>;
    setUpdateError: ReturnType<typeof vi.fn>;
    showAvailableUpdate: ReturnType<typeof vi.fn>;
    finishUpdateCheck: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("../src/runtime.js", () => ({ startRoutewire: mocks.startRoutewire }));
vi.mock("../src/update.js", () => ({
  checkForRoutewireUpdate: mocks.checkForRoutewireUpdate,
  installRoutewireUpdate: mocks.installRoutewireUpdate,
}));
vi.mock("../src/model-catalog.js", () => ({ loadCodexModelCatalog: () => [] }));
vi.mock("../src/tui-settings.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/tui-settings.js")>(),
  hasStoredApiKey: () => false,
}));
vi.mock("../src/tui.js", () => ({
  RoutewireTui: class {
    stop = vi.fn();
    setRuntimeState = vi.fn();
    setUpdateError = vi.fn();
    showAvailableUpdate = vi.fn();
    finishUpdateCheck = vi.fn();
    handle = vi.fn();
    start = vi.fn();
    constructor(public options: RoutewireTuiOptions) { mocks.instances.push(this); }
  },
}));

import { runInteractive } from "../src/cli.js";
import { parseCliOptions } from "../src/cli-options.js";

const lifecycleSignals = ["exit", "SIGINT", "SIGTERM"] as const;
const signalListeners = (signal: typeof lifecycleSignals[number]) =>
  signal === "exit" ? process.listeners("exit") : process.listeners(signal);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function runtime(close = vi.fn().mockResolvedValue(undefined)) {
  const exit = deferred<CodexExit>();
  return { value: { close, codexExited: exit.promise } as unknown as RoutewireRuntime, close, exit };
}

let done: Promise<void> | undefined;
let listeners: Record<string, Function[]>;
beforeEach(() => {
  mocks.instances.length = 0;
  mocks.startRoutewire.mockReset();
  mocks.checkForRoutewireUpdate.mockReset().mockResolvedValue(undefined);
  mocks.installRoutewireUpdate.mockReset().mockResolvedValue(undefined);
  listeners = Object.fromEntries(lifecycleSignals.map(signal => [signal, signalListeners(signal)]));
  vi.stubEnv("ROUTEWIRE_TUNNEL_ID", "");
  vi.stubEnv("ROUTEWIRE_TUNNEL_API_KEY_FILE", "");
  vi.stubEnv("CONTROL_PLANE_API_KEY", "");
});
afterEach(async () => {
  mocks.instances[0]?.options.onQuit?.();
  await done;
  done = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const signal of lifecycleSignals) {
    expect(signalListeners(signal)).toEqual(listeners[signal]);
  }
});

async function startInteractive() {
  done = runInteractive(parseCliOptions([]));
  await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
  const tui = mocks.instances[0]!;
  await vi.waitFor(() => expect(tui.finishUpdateCheck).toHaveBeenCalledTimes(1));
  tui.options.onStart?.(structuredClone(DEFAULT_ROUTEWIRE_SETTINGS));
  return tui;
}

describe("interactive CLI lifecycle", () => {
  it("restores the terminal and completes Quit when runtime cleanup rejects", async () => {
    const current = runtime(vi.fn().mockRejectedValue(new Error("cleanup failed")));
    mocks.startRoutewire.mockResolvedValue(current.value);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const tui = await startInteractive();
    await vi.waitFor(() => expect(tui.setRuntimeState).toHaveBeenCalledWith("running"));
    tui.options.onQuit?.();
    await done;
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(tui.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith("[routewire] cleanup failed\n"));
  });

  it("waits for Stop cleanup before launching a queued replacement", async () => {
    const cleanup = deferred<void>();
    const first = runtime(vi.fn().mockImplementation(() => cleanup.promise));
    const second = runtime();
    mocks.startRoutewire.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    const tui = await startInteractive();
    await vi.waitFor(() => expect(tui.setRuntimeState).toHaveBeenCalledWith("running"));
    tui.options.onStop?.();
    tui.options.onStart?.(structuredClone(DEFAULT_ROUTEWIRE_SETTINGS));
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
    expect(mocks.startRoutewire).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await vi.waitFor(() => expect(mocks.startRoutewire).toHaveBeenCalledTimes(2));
    expect(second.close).not.toHaveBeenCalled();
  });

  it("ignores a previous process exit after its replacement becomes active", async () => {
    const first = runtime();
    const second = runtime();
    mocks.startRoutewire.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    const tui = await startInteractive();
    await vi.waitFor(() => expect(tui.setRuntimeState).toHaveBeenCalledWith("running"));
    tui.options.onStart?.(structuredClone(DEFAULT_ROUTEWIRE_SETTINGS));
    await vi.waitFor(() => expect(mocks.startRoutewire).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(tui.setRuntimeState.mock.calls.filter(([state]) => state === "running")).toHaveLength(2));
    tui.setRuntimeState.mockClear();
    first.exit.resolve({ code: 23, signal: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(second.close).not.toHaveBeenCalled();
    expect(tui.setRuntimeState).not.toHaveBeenCalled();
  });

  it("installs an offered update and exits before starting the runtime", async () => {
    mocks.checkForRoutewireUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "routewire@latest"], display: "npm install -g routewire@latest"},
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    done = runInteractive(parseCliOptions([]));
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const tui = mocks.instances[0]!;

    expect(tui.options.checkingForUpdate).toBe(true);
    await vi.waitFor(() => expect(tui.showAvailableUpdate).toHaveBeenCalledWith({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "routewire@latest"], display: "npm install -g routewire@latest"},
    }));
    tui.options.onUpdate?.();
    await done;

    expect(mocks.installRoutewireUpdate).toHaveBeenCalledWith(
      {
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        action: {command: "npm", args: ["install", "--global", "routewire@latest"], display: "npm install -g routewire@latest"},
      },
      {signal: expect.any(AbortSignal)},
    );
    expect(mocks.startRoutewire).not.toHaveBeenCalled();
    expect(tui.stop).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith("[routewire] Updated to 0.2.0. Restart Routewire to use the new version.\n");
  });

  it("cancels an in-flight update before quitting", async () => {
    mocks.checkForRoutewireUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "routewire@latest"], display: "npm install -g routewire@latest"},
    });
    let signal: AbortSignal | undefined;
    mocks.installRoutewireUpdate.mockImplementation((_update, options) => {
      signal = options.signal;
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Update cancelled")), {once: true});
      });
    });
    done = runInteractive(parseCliOptions([]));
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const tui = mocks.instances[0]!;
    await vi.waitFor(() => expect(tui.showAvailableUpdate).toHaveBeenCalledTimes(1));

    tui.options.onUpdate?.();
    await vi.waitFor(() => expect(mocks.installRoutewireUpdate).toHaveBeenCalledTimes(1));
    tui.options.onQuit?.();
    await done;

    expect(signal?.aborted).toBe(true);
    expect(tui.setUpdateError).not.toHaveBeenCalled();
    expect(tui.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the update prompt alive when installation fails", async () => {
    mocks.checkForRoutewireUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "routewire@latest"], display: "npm install -g routewire@latest"},
    });
    mocks.installRoutewireUpdate.mockRejectedValue(new Error("permission denied"));
    done = runInteractive(parseCliOptions([]));
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const tui = mocks.instances[0]!;
    await vi.waitFor(() => expect(tui.showAvailableUpdate).toHaveBeenCalledTimes(1));

    tui.options.onUpdate?.();
    await vi.waitFor(() => expect(tui.setUpdateError).toHaveBeenCalledWith("permission denied"));
    expect(tui.stop).not.toHaveBeenCalled();

    tui.options.onQuit?.();
    await done;
    expect(tui.stop).toHaveBeenCalledTimes(1);
  });
});
