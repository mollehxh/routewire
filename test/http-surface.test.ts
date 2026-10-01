import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexTurnBridge } from "../src/bridge.js";
import { SidebandHttpSurface } from "../src/http-surface.js";
import { SIDEBAND_MCP_INSTRUCTIONS } from "../src/mcp/instructions.js";
import { selectProjectedNativeTools } from "../src/mcp/projected-tools.js";
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
    surface.setMcpServer(createSidebandMcpServer({ bridge, execSpec }), execSpec);
    closers.push(() => surface.close());

    const client = new Client({ name: "sideband-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(surface.mcpUrl));
    await client.connect(transport);
    closers.push(async () => client.close());

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({ name: "exec" });
    expect(listed.tools[0].description).toContain("LIVE CODEX EXEC DESCRIPTION");
    expect(listed.tools[0].description).toContain("Prefer a directly exposed Sideband native tool");

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

  it("serves MCP 2026-07-28 server/discover, tools/list, and tools/call statelessly", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(initialRequest(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();
    const projectedTools = selectProjectedNativeTools([
      { name: "exec_command", description: "LIVE DIRECT EXEC DESCRIPTION" },
    ]);
    const nativeSkillTools = {
      listName: "mcp__codex_apps__fkn_codex_codex_skills_list",
      getName: "mcp__codex_apps__fkn_codex_codex_skill_get",
    };

    const surface = new SidebandHttpSurface({ bridge });
    await surface.start();
    surface.setMcpServer(
      createSidebandMcpServer({ bridge, execSpec, projectedTools, nativeSkillTools }),
      execSpec,
      projectedTools,
      nativeSkillTools,
    );
    closers.push(() => surface.close());

    const modernHeaders = (method: string, name?: string) => ({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    });
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "sideband-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };

    const discover = await fetch(surface.mcpUrl, {
      method: "POST",
      headers: modernHeaders("server/discover"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-1",
        method: "server/discover",
        params: { _meta: meta },
      }),
    });
    expect(discover.status).toBe(200);
    await expect(discover.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "discover-1",
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        instructions: SIDEBAND_MCP_INSTRUCTIONS,
        ttlMs: 0,
        cacheScope: "private",
      },
    });

    const list = await fetch(surface.mcpUrl, {
      method: "POST",
      headers: modernHeaders("tools/list"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "list-1",
        method: "tools/list",
        params: { _meta: meta },
      }),
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "list-1",
      result: {
        resultType: "complete",
        tools: [
          {
            name: "exec_command",
            description: "LIVE DIRECT EXEC DESCRIPTION",
            inputSchema: {
              type: "object",
              required: ["cmd"],
            },
          },
          {
            name: "skills",
            inputSchema: {
              type: "object",
            },
          },
          {
            name: "get_skill",
            inputSchema: {
              type: "object",
              required: ["names"],
            },
          },
          {
            name: "exec",
            inputSchema: {
              type: "object",
              required: ["code"],
            },
          },
        ],
        ttlMs: 0,
        cacheScope: "private",
      },
    });

    const skillsCallResponse = fetch(surface.mcpUrl, {
      method: "POST",
      headers: modernHeaders("tools/call", "skills"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "skills-call-1",
        method: "tools/call",
        params: {
          name: "skills",
          arguments: {},
          _meta: meta,
        },
      }),
    });

    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    const skillsReply = providerReply as ProviderReply | undefined;
    if (!skillsReply || skillsReply.kind !== "tool_call") throw new Error("missing skills call");
    expect(skillsReply.input).toContain(nativeSkillTools.listName);
    bridge.acceptModelRequest(
      {
        ...initialRequest(),
        input: [
          ...initialRequest().input,
          {
            type: "custom_tool_call_output",
            call_id: skillsReply.callId,
            output: [{
              type: "input_text",
              text: '__SIDEBAND_SKILL_PAYLOAD_START__{"total":1,"skills":[{"name":"alpha","description":"A"}]}__SIDEBAND_SKILL_PAYLOAD_END__',
            }],
          },
        ],
      },
      reply => {
        providerReply = reply;
      },
    );

    const skillsCall = await skillsCallResponse;
    expect(skillsCall.status).toBe(200);
    await expect(skillsCall.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "skills-call-1",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: '{"skills":[{"name":"alpha","description":"A"}]}' }],
        isError: false,
      },
    });
    providerReply = undefined;

    const directCallResponse = fetch(surface.mcpUrl, {
      method: "POST",
      headers: modernHeaders("tools/call", "exec_command"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "direct-call-1",
        method: "tools/call",
        params: {
          name: "exec_command",
          arguments: { cmd: "printf MODERN_DIRECT" },
          _meta: meta,
        },
      }),
    });

    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    const directReply = providerReply as ProviderReply | undefined;
    if (!directReply || directReply.kind !== "tool_call") throw new Error("missing direct tool call");
    expect(directReply.input).toContain('tools["exec_command"]');
    expect(directReply.input).toContain("MODERN_DIRECT");

    bridge.acceptModelRequest(
      {
        ...initialRequest(),
        input: [
          ...initialRequest().input,
          {
            type: "custom_tool_call_output",
            call_id: directReply.callId,
            output: [{ type: "input_text", text: "modern-direct-result" }],
          },
        ],
      },
      reply => {
        providerReply = reply;
      },
    );

    const directCall = await directCallResponse;
    expect(directCall.status).toBe(200);
    await expect(directCall.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "direct-call-1",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "modern-direct-result" }],
        isError: false,
      },
    });
    providerReply = undefined;

    const callResponse = fetch(surface.mcpUrl, {
      method: "POST",
      headers: modernHeaders("tools/call", "exec"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "exec",
          arguments: { code: "text('modern-roundtrip');" },
          _meta: meta,
        },
      }),
    });

    await vi.waitFor(() =>
      expect((providerReply as ProviderReply | undefined)?.kind).toBe("tool_call"),
    );
    const execReply = providerReply as ProviderReply | undefined;
    if (!execReply || execReply.kind !== "tool_call") throw new Error("missing tool call");
    expect(execReply.input).toContain("modern-roundtrip");

    bridge.acceptModelRequest(
      {
        ...initialRequest(),
        input: [
          ...initialRequest().input,
          {
            type: "custom_tool_call_output",
            call_id: execReply.callId,
            output: [{ type: "input_text", text: "modern-result" }],
          },
        ],
      },
      () => undefined,
    );

    const call = await callResponse;
    expect(call.status).toBe(200);
    await expect(call.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "modern-result" }],
        isError: false,
      },
    });
  });
});
