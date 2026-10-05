import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {afterEach, describe, expect, it, vi} from "vitest";

const mocks = vi.hoisted(() => ({spawn: vi.fn()}));
vi.mock("cross-spawn", () => ({default: mocks.spawn}));

import {startCodexProcess} from "../src/codex/process.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 42_424;
  kill = vi.fn(() => true);
}

afterEach(() => {
  mocks.spawn.mockReset();
  vi.unstubAllEnvs();
});

describe("startCodexProcess", () => {
  it("forces the local Routewire provider to bypass inherited proxies", async () => {
    vi.stubEnv("NO_PROXY", "example.com");
    vi.stubEnv("no_proxy", "internal.test");
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const handle = startCodexProcess({
      cwd: "/tmp/project",
      model: "test",
      providerBaseUrl: "http://127.0.0.1:45678/v1",
      quiet: true,
    });
    child.emit("close", 0, null);
    await handle.exited;

    const env = mocks.spawn.mock.calls[0]![2]!.env as NodeJS.ProcessEnv;
    for (const value of [env.NO_PROXY, env.no_proxy]) {
      expect(value).toContain("example.com");
      expect(value).toContain("internal.test");
      expect(value).toContain("127.0.0.1");
      expect(value).toContain("localhost");
      expect(value).toContain("::1");
    }
  });

  it("captures the final Codex stderr for startup diagnostics even in quiet mode", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const handle = startCodexProcess({
      cwd: "/tmp/project",
      model: "test",
      providerBaseUrl: "http://127.0.0.1:45678/v1",
      quiet: true,
    });
    child.stderr.write("first warning\n");
    child.stderr.write("ERROR: unexpected status 503 Service Unavailable\n");
    child.emit("close", 1, null);

    await expect(handle.exited).resolves.toMatchObject({
      code: 1,
      stderrTail: expect.stringContaining("unexpected status 503 Service Unavailable"),
    });
  });

  it("waits for stdio close so stderr arriving after exit is preserved", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const handle = startCodexProcess({
      cwd: "/tmp/project",
      model: "test",
      providerBaseUrl: "http://127.0.0.1:45678/v1",
      quiet: true,
    });
    child.emit("exit", 1, null);
    child.stderr.write("ERROR: late diagnostic\n");
    child.emit("close", 1, null);

    await expect(handle.exited).resolves.toMatchObject({
      code: 1,
      stderrTail: expect.stringContaining("late diagnostic"),
    });
  });
});
