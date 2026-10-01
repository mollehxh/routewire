import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexTurnBridge } from "../src/bridge.js";
import { SidebandHttpSurface } from "../src/http-surface.js";
import { createSidebandMcpServer } from "../src/mcp/server.js";
import type { ProviderReply } from "../src/provider/protocol.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

function initialRequest() {
  return {
    model: "gpt-5.6-sol",
    input: [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              {
                type: "custom",
                name: "exec",
                description: "LIVE CODEX EXEC DESCRIPTION",
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("SidebandHttpSurface", () => {
  it("rejects non-loopback binds", () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    expect(() => new SidebandHttpSurface({ bridge, host: "0.0.0.0" })).toThrow(/loopback/i);
  });

  it("protects the internal Responses provider from non-local browser origins", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const surface = new SidebandHttpSurface({ bridge });
    await surface.start();
    closers.push(() => surface.close());

    const response = await fetch(`${surface.origin}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://evil.example",
      },
      body: JSON.stringify(initialRequest()),
    });

    expect(response.status).toBe(403);
  });

  it("serves the dynamically captured Codex exec tool over Streamable HTTP MCP", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(initialRequest(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();

    const surface = new SidebandHttpSurface({ bridge });
    await surface.start();
    surface.setMcpServer(createSidebandMcpServer({ bridge, execSpec }));
    closers.push(() => surface.close());

    const client = new Client({ name: "sideband-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(surface.mcpUrl));
    await client.connect(transport);
    closers.push(async () => client.close());

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: "exec",
      description: "LIVE CODEX EXEC DESCRIPTION",
    });

    const call = client.callTool({
      name: "exec",
      arguments: { code: "text('http-roundtrip');" },
    });

    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    if (!providerReply || providerReply.kind !== "tool_call") throw new Error("missing tool call");

    bridge.acceptModelRequest(
      {
        ...initialRequest(),
        input: [
          ...initialRequest().input,
          {
            type: "custom_tool_call_output",
            call_id: providerReply.callId,
            output: [{ type: "input_text", text: "http-roundtrip-result" }],
          },
        ],
      },
      () => undefined,
    );

    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "http-roundtrip-result" }],
      isError: false,
    });
  });
});
