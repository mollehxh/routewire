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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sideband-tunnel-test-"));
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
});
