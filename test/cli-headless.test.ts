import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DEFAULT_ROUTEWIRE_SETTINGS} from "../src/tui-settings.js";

const mocks = vi.hoisted(() => ({startRoutewire: vi.fn(), loadSettings: vi.fn(), hasKey: vi.fn()}));
vi.mock("../src/runtime.js", () => ({startRoutewire: mocks.startRoutewire}));
vi.mock("../src/tui-settings.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/tui-settings.js")>(),
  loadRoutewireSettings: mocks.loadSettings,
  hasStoredApiKey: mocks.hasKey,
  storedApiKeyPath: () => "/saved/key",
}));
import {runHeadless} from "../src/cli.js";
import {parseCliOptions} from "../src/cli-options.js";

let originalSignals: Record<string, Function[]>;
beforeEach(() => {
  originalSignals = Object.fromEntries((["SIGINT", "SIGTERM"] as const).map(signal => [signal, process.listeners(signal)]));
  for (const name of ["ROUTEWIRE_TUNNEL_ID", "SIDEBAND_TUNNEL_ID", "ROUTEWIRE_TUNNEL_API_KEY_FILE", "SIDEBAND_TUNNEL_API_KEY_FILE", "CONTROL_PLANE_API_KEY"]) vi.stubEnv(name, undefined);
  mocks.loadSettings.mockReturnValue({...DEFAULT_ROUTEWIRE_SETTINGS, tunnelId: "tunnel_saved"});
  mocks.hasKey.mockReturnValue(true);
  mocks.startRoutewire.mockReset().mockResolvedValue({
    codexExited: Promise.resolve({code: 0}), close: vi.fn().mockResolvedValue(undefined),
    tunnelHealthUrl: "http://127.0.0.1/health",
  });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  for (const signal of (["SIGINT", "SIGTERM"] as const)) {
    for (const listener of process.listeners(signal)) {
      if (!originalSignals[signal]!.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("headless tunnel connection", () => {
  it("uses the saved tunnel ID and credential file", async () => {
    await runHeadless(parseCliOptions([]));
    expect(mocks.startRoutewire).toHaveBeenCalledWith(expect.objectContaining({
      tunnel: {tunnelId: "tunnel_saved", apiKeyFile: "/saved/key", command: undefined},
    }));
  });
  it("gives explicit connection flags precedence", async () => {
    await runHeadless(parseCliOptions(["--tunnel-id", "tunnel_override", "--tunnel-api-key-file", "/override/key"]));
    expect(mocks.startRoutewire).toHaveBeenCalledWith(expect.objectContaining({
      tunnel: {tunnelId: "tunnel_override", apiKeyFile: "/override/key", command: undefined},
    }));
  });
  it("rejects missing credentials before starting the runtime", async () => {
    mocks.hasKey.mockReturnValue(false);
    await expect(runHeadless(parseCliOptions([]))).rejects.toThrow(/API key/);
    expect(mocks.startRoutewire).not.toHaveBeenCalled();
  });
});
