import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startTunnelClient, type TunnelClientHandle } from "../src/tunnel/process.js";

const handles: TunnelClientHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()?.close();
  while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("startTunnelClient", () => {
  it("waits for readyz and stops the child it owns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routewire-tunnel-test-"));
    tempDirs.push(dir);
    const script = path.join(dir, "fake-tunnel-client.mjs");
    const argsFile = path.join(dir, "args.json");

    await fs.writeFile(
      script,
      `
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_TUNNEL_ARGS_FILE, JSON.stringify(args));
const healthIndex = args.indexOf("--health.url-file");
if (healthIndex < 0) process.exit(11);
const healthFile = args[healthIndex + 1];
const server = http.createServer((req, res) => {
  if (req.url === "/readyz") {
    res.writeHead(200).end("ready");
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(healthFile, "http://127.0.0.1:" + address.port);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`,
      "utf8",
    );

    const handle = await startTunnelClient({
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:4567/mcp",
      command: process.execPath,
      commandPrefixArgs: [script],
      env: {
        ...process.env,
        CONTROL_PLANE_API_KEY: "test-only-key",
        FAKE_TUNNEL_ARGS_FILE: argsFile,
      },
      readyTimeoutMs: 5_000,
      quiet: true,
    });
    handles.push(handle);

    expect(handle.healthUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const forwardedArgs = JSON.parse(await fs.readFile(argsFile, "utf8")) as string[];
    expect(forwardedArgs).toContain("tunnel_test");
    expect(forwardedArgs).toContain("url=http://127.0.0.1:4567/mcp,channel=main");
    expect(forwardedArgs.join(" ")).not.toContain("test-only-key");

    await handle.close();
    handles.pop();
    await expect(handle.exited).resolves.toMatchObject({ code: 0 });
  });

  it("fails before spawning when neither an API key env nor a key file is available", async () => {
    await expect(
      startTunnelClient({
        tunnelId: "tunnel_test",
        mcpUrl: "http://127.0.0.1:4567/mcp",
        command: process.execPath,
        commandPrefixArgs: [],
        env: {},
        readyTimeoutMs: 100,
        quiet: true,
      }),
    ).rejects.toThrow(/CONTROL_PLANE_API_KEY/i);
  });

  it("drains child stdout and stderr even when quiet", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routewire-tunnel-drain-test-"));
    tempDirs.push(dir);
    const script = path.join(dir, "fake-chatty-tunnel-client.mjs");
    const doneFile = path.join(dir, "done");

    await fs.writeFile(
      script,
      `
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const healthIndex = args.indexOf("--health.url-file");
const healthFile = args[healthIndex + 1];
const server = http.createServer((req, res) => {
  if (req.url === "/readyz") return res.writeHead(200).end("ready");
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(healthFile, "http://127.0.0.1:" + address.port);
  setImmediate(() => {
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 32; i += 1) {
      process.stdout.write(chunk);
      process.stderr.write(chunk);
    }
    fs.writeFileSync(process.env.FAKE_TUNNEL_DONE_FILE, "done");
  });
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`,
      "utf8",
    );

    const handle = await startTunnelClient({
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:4567/mcp",
      command: process.execPath,
      commandPrefixArgs: [script],
      env: {
        ...process.env,
        CONTROL_PLANE_API_KEY: "test-only-key",
        FAKE_TUNNEL_DONE_FILE: doneFile,
      },
      readyTimeoutMs: 5_000,
      quiet: true,
    });
    handles.push(handle);

    await expect(waitForFile(doneFile, 5_000)).resolves.toBe(true);
  });

  it("detects a stalled control-plane poller after startup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routewire-tunnel-health-test-"));
    tempDirs.push(dir);
    const script = path.join(dir, "fake-unhealthy-tunnel-client.mjs");

    await fs.writeFile(
      script,
      `
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const healthIndex = args.indexOf("--health.url-file");
const healthFile = args[healthIndex + 1];
const server = http.createServer((req, res) => {
  if (req.url === "/readyz") return res.writeHead(200).end("ready");
  if (req.url === "/health?details=true") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ready: true,
      components: {
        "control-plane": { details: { current_poll_age_seconds: 301 } },
      },
    }));
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(healthFile, "http://127.0.0.1:" + address.port);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`,
      "utf8",
    );

    const handle = await startTunnelClient({
      tunnelId: "tunnel_test",
      mcpUrl: "http://127.0.0.1:4567/mcp",
      command: process.execPath,
      commandPrefixArgs: [script],
      env: { ...process.env, CONTROL_PLANE_API_KEY: "test-only-key" },
      readyTimeoutMs: 5_000,
      quiet: true,
      healthCheckIntervalMs: 100,
      healthFailureThreshold: 2,
      maxControlPlanePollAgeSeconds: 90,
    });
    handles.push(handle);

    const unhealthy = await handle.unhealthy;
    expect(unhealthy.message).toMatch(/poll age is 301s/i);
  });
});

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  return false;
}
