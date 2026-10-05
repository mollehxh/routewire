import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexExit } from "../src/codex/process.js";
import type { RunwireRuntime } from "../src/runtime.js";
import type { RunwireTuiOptions } from "../src/tui.js";
import { DEFAULT_RUNWIRE_SETTINGS } from "../src/tui-settings.js";

const mocks = vi.hoisted(() => ({
  startRunwire: vi.fn(),
  checkForRunwireUpdate: vi.fn(),
  installRunwireUpdate: vi.fn(),
  instances: [] as Array<{
    options: RunwireTuiOptions;
    stop: ReturnType<typeof vi.fn>;
    setRuntimeState: ReturnType<typeof vi.fn>;
    setUpdateError: ReturnType<typeof vi.fn>;
    showAvailableUpdate: ReturnType<typeof vi.fn>;
    finishUpdateCheck: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("../src/runtime.js", () => ({ startRunwire: mocks.startRunwire }));
vi.mock("../src/update.js", () => ({
  checkForRunwireUpdate: mocks.checkForRunwireUpdate,
  installRunwireUpdate: mocks.installRunwireUpdate,
}));
vi.mock("../src/model-catalog.js", () => ({ loadCodexModelCatalog: () => [] }));
vi.mock("../src/tui-settings.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/tui-settings.js")>(),
  hasStoredApiKey: () => false,
}));
vi.mock("../src/tui.js", () => ({
  RunwireTui: class {
    stop = vi.fn();
    setRuntimeState = vi.fn();
    setUpdateError = vi.fn();
    showAvailableUpdate = vi.fn();
    finishUpdateCheck = vi.fn();
    handle = vi.fn();
    start = vi.fn();
    constructor(public options: RunwireTuiOptions) { mocks.instances.push(this); }
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
  return { value: { close, codexExited: exit.promise } as unknown as RunwireRuntime, close, exit };
}

let done: Promise<void> | undefined;
let listeners: Record<string, Function[]>;
beforeEach(() => {
  mocks.instances.length = 0;
  mocks.startRunwire.mockReset();
  mocks.checkForRunwireUpdate.mockReset().mockResolvedValue(undefined);
  mocks.installRunwireUpdate.mockReset().mockResolvedValue(undefined);
  listeners = Object.fromEntries(lifecycleSignals.map(signal => [signal, signalListeners(signal)]));
  vi.stubEnv("RUNWIRE_TUNNEL_ID", "");
  vi.stubEnv("RUNWIRE_TUNNEL_API_KEY_FILE", "");
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
  tui.options.onStart?.(structuredClone(DEFAULT_RUNWIRE_SETTINGS));
  return tui;
}

describe("interactive CLI lifecycle", () => {
  it("restores the terminal and completes Quit when runtime cleanup rejects", async () => {
    const current = runtime(vi.fn().mockRejectedValue(new Error("cleanup failed")));
    mocks.startRunwire.mockResolvedValue(current.value);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const tui = await startInteractive();
    await vi.waitFor(() => expect(tui.setRuntimeState).toHaveBeenCalledWith("running"));
    tui.options.onQuit?.();
    await done;
    expect(current.close).toHaveBeenCalledTimes(1);
    expect(tui.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith("[runwire] cleanup failed\n"));
  });

  it("waits for Stop cleanup before launching a queued replacement", async () => {
    const cleanup = deferred<void>();
    const first = runtime(vi.fn().mockImplementation(() => cleanup.promise));
    const second = runtime();
    mocks.startRunwire.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    const tui = await startInteractive();
    await vi.waitFor(() => expect(tui.setRuntimeState).toHaveBeenCalledWith("running"));
    tui.options.onStop?.();
    tui.options.onStart?.(structuredClone(DEFAULT_RUNWIRE_SETTINGS));
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
    expect(mocks.startRunwire).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await vi.waitFor(() => expect(mocks.startRunwire).toHaveBeenCalledTimes(2));
    expect(second.close).not.toHaveBeenCalled();
  });

  it("ignores a previous process exit after its replacement becomes active", async () => {
    const first = runtime();
    const second = runtime();
    mocks.startRunwire.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    const tui = await startInteractive();
    await vi.waitFor(() => expect(tui.setRuntimeState).toHaveBeenCalledWith("running"));
    tui.options.onStart?.(structuredClone(DEFAULT_RUNWIRE_SETTINGS));
    await vi.waitFor(() => expect(mocks.startRunwire).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(tui.setRuntimeState.mock.calls.filter(([state]) => state === "running")).toHaveLength(2));
    tui.setRuntimeState.mockClear();
    first.exit.resolve({ code: 23, signal: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(second.close).not.toHaveBeenCalled();
    expect(tui.setRuntimeState).not.toHaveBeenCalled();
  });

  it("installs an offered update and exits before starting the runtime", async () => {
    mocks.checkForRunwireUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "runwire@latest"], display: "npm install -g runwire@latest"},
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    done = runInteractive(parseCliOptions([]));
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const tui = mocks.instances[0]!;

    expect(tui.options.checkingForUpdate).toBe(true);
    await vi.waitFor(() => expect(tui.showAvailableUpdate).toHaveBeenCalledWith({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "runwire@latest"], display: "npm install -g runwire@latest"},
    }));
    tui.options.onUpdate?.();
    await done;

    expect(mocks.installRunwireUpdate).toHaveBeenCalledWith(
      {
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        action: {command: "npm", args: ["install", "--global", "runwire@latest"], display: "npm install -g runwire@latest"},
      },
      {signal: expect.any(AbortSignal)},
    );
    expect(mocks.startRunwire).not.toHaveBeenCalled();
    expect(tui.stop).toHaveBeenCalledTimes(1);
    expect(stdout).toHaveBeenCalledWith("[runwire] Updated to 0.2.0. Restart Runwire to use the new version.\n");
  });

  it("cancels an in-flight update before quitting", async () => {
    mocks.checkForRunwireUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "runwire@latest"], display: "npm install -g runwire@latest"},
    });
    let signal: AbortSignal | undefined;
    mocks.installRunwireUpdate.mockImplementation((_update, options) => {
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
    await vi.waitFor(() => expect(mocks.installRunwireUpdate).toHaveBeenCalledTimes(1));
    tui.options.onQuit?.();
    await done;

    expect(signal?.aborted).toBe(true);
    expect(tui.setUpdateError).not.toHaveBeenCalled();
    expect(tui.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the update prompt alive when installation fails", async () => {
    mocks.checkForRunwireUpdate.mockResolvedValue({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      action: {command: "npm", args: ["install", "--global", "runwire@latest"], display: "npm install -g runwire@latest"},
    });
    mocks.installRunwireUpdate.mockRejectedValue(new Error("permission denied"));
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
