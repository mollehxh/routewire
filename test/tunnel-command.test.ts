import { describe, expect, it } from "vitest";

import { buildTunnelClientArgs } from "../src/tunnel/command.js";

describe("buildTunnelClientArgs", () => {
  it("binds the official tunnel client to Runwire MCP without putting raw secrets in argv", () => {
    const args = buildTunnelClientArgs({
      tunnelId: "tunnel_0123456789abcdef",
      mcpUrl: "http://127.0.0.1:4321/mcp",
      healthUrlFile: "/tmp/runwire-health.url",
      apiKeyFile: "/tmp/runtime-api-key",
    });

    expect(args).toEqual([
      "run",
      "--control-plane.tunnel-id",
      "tunnel_0123456789abcdef",
      "--control-plane.api-key",
      "file:/tmp/runtime-api-key",
      "--mcp.server-url",
      "url=http://127.0.0.1:4321/mcp,channel=main",
      "--mcp.startup-wait-timeout",
      "10s",
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      "/tmp/runwire-health.url",
      "--log.format",
      "struct-text",
      "--log.level",
      "info",
    ]);
  });

  it("relies on CONTROL_PLANE_API_KEY when no key file is configured", () => {
    const args = buildTunnelClientArgs({
      tunnelId: "tunnel_abc",
      mcpUrl: "http://127.0.0.1:4321/mcp",
      healthUrlFile: "/tmp/health.url",
    });

    expect(args).not.toContain("--control-plane.api-key");
  });
});
