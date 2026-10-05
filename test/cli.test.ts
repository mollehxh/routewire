import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexExit } from "../src/codex/process.js";
import type { RunwireRuntime } from "../src/runtime.js";
import type { RunwireTuiOptions } from "../src/tui.js";
import { DEFAULT_RUNWIRE_SETTINGS } from "../src/tui-settings.js";

const mocks = vi.hoisted(() => ({
  startRunwire: vi.fn(),
  instances: [] as Array<{
    options: RunwireTuiOptions;
    stop: ReturnType<typeof vi.fn>;
    setRuntimeState: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("../src/runtime.js", () => ({ startRunwire: mocks.startRunwire }));
vi.mock("../src/model-catalog.js", () => ({ loadCodexModelCatalog: () => [] }));
vi.mock("../src/tui-settings.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/tui-settings.js")>(),
  hasStoredApiKey: () => false,
}));
vi.mock("../src/tui.js", () => ({
  RunwireTui: class {
    stop = vi.fn();
    setRuntimeState = vi.fn();
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

function startInteractive() {
  done = runInteractive(parseCliOptions([]));
  const tui = mocks.instances[0]!;
  tui.options.onStart?.(structuredClone(DEFAULT_RUNWIRE_SETTINGS));
  return tui;
}

describe("interactive CLI lifecycle", () => {
  it("restores the terminal and completes Quit when runtime cleanup rejects", async () => {
    const current = runtime(vi.fn().mockRejectedValue(new Error("cleanup failed")));
    mocks.startRunwire.mockResolvedValue(current.value);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const tui = startInteractive();
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
    const tui = startInteractive();
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
    const tui = startInteractive();
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
});
