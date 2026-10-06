import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { McpServer } from "@modelcontextprotocol/server";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexTurnBridge } from "../src/bridge.js";
import { RoutewireHttpSurface } from "../src/http-surface.js";
import { ROUTEWIRE_MCP_INSTRUCTIONS } from "../src/mcp/instructions.js";
import { selectProjectedNativeTools } from "../src/mcp/projected-tools.js";
import { createRoutewireMcpServer } from "../src/mcp/server.js";
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
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: '<environment_context><cwd>/repo</cwd><shell>zsh</shell><current_date>2026-10-01</current_date><timezone>Europe/Moscow</timezone><filesystem><workspace_roots><root>/repo</root></workspace_roots><permission_profile type="managed"><file_system type="restricted" /></permission_profile></filesystem></environment_context>',
        }],
      },
    ],
  };
}

describe("RoutewireHttpSurface", () => {
  it("accepts repeated legacy MCP connections after the tunnel startup probe", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    bridge.acceptModelRequest(initialRequest(), () => undefined);
    const execSpec = await bridge.ready();
    const surface = new RoutewireHttpSurface({ bridge });
    await surface.start();
    surface.setMcpServer(createRoutewireMcpServer({ bridge, execSpec }), execSpec);
    closers.push(() => surface.close());

    const probe = await fetch(surface.mcpUrl, { headers: { accept: "application/json" } });
    await probe.text();

    for (let id = 1; id <= 3; id++) {
      const response = await fetch(surface.mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" } },
        }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain('"name":"routewire"');
    }
  });

  it("releases the HTTP listener even when MCP cleanup fails", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    bridge.acceptModelRequest(initialRequest(), () => undefined);
    const surface = new RoutewireHttpSurface({ bridge });
    await surface.start();
    const origin = surface.origin;
    const failure = new Error("transport cleanup failed");
    const close = vi.fn().mockRejectedValue(failure);
    surface.setMcpServer({ close } as unknown as McpServer, await bridge.ready());
    await expect(surface.close()).rejects.toBe(failure);
    await expect(fetch(origin)).rejects.toThrow();
    await expect(surface.close()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds shutdown when a client leaves its request body incomplete", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const surface = new RoutewireHttpSurface({ bridge });
    await surface.start();
    const origin = surface.origin;
    const socket = createConnection(Number(new URL(origin).port), "127.0.0.1");
    socket.on("error", () => undefined);
    closers.push(async () => { socket.destroy(); await surface.close(); });
    await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.write("POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{");
    // Ensure Node has accepted this request before starting shutdown.
    await new Promise(resolve => setTimeout(resolve, 20));
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    await expect(Promise.race([
      surface.close().then(() => "closed"),
      new Promise(resolve => setTimeout(() => resolve("timed out"), 1500)),
    ])).resolves.toBe("closed");
    await closed;
    await expect(fetch(origin)).rejects.toThrow();
  });

  it("rejects non-loopback binds", () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    expect(() => new RoutewireHttpSurface({ bridge, host: "0.0.0.0" })).toThrow(/loopback/i);
  });

  it("protects the internal Responses provider from non-local browser origins", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const surface = new RoutewireHttpSurface({ bridge });
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

    const surface = new RoutewireHttpSurface({ bridge });
    await surface.start();
    surface.setMcpServer(createRoutewireMcpServer({ bridge, execSpec }), execSpec);
    closers.push(() => surface.close());

    const client = new Client({ name: "routewire-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(surface.mcpUrl));
    await client.connect(transport);
    closers.push(async () => client.close());

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["bootstrap", "exec"]);
    const execTool = listed.tools.find(tool => tool.name === "exec")!;
    expect(execTool.description).toContain("LIVE CODEX EXEC DESCRIPTION");
    expect(execTool.description).toContain("Prefer a directly exposed native tool");

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
    const root = await mkdtemp(join(tmpdir(), "routewire-http-skills-"));
    const skillRoot = join(root, "skills");
    const skillDir = join(skillRoot, "alpha");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: alpha\ndescription: A\n---\n\nbody\n",
      "utf8",
    );
    const nativeSkillTools = { kind: "local" as const, roots: [skillRoot] };

    const surface = new RoutewireHttpSurface({ bridge });
    await surface.start();
    surface.setMcpServer(
      createRoutewireMcpServer({ bridge, execSpec, projectedTools, nativeSkillTools }),
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
      "io.modelcontextprotocol/clientInfo": { name: "routewire-test", version: "1" },
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
        instructions: ROUTEWIRE_MCP_INSTRUCTIONS,
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
            name: "bootstrap",
            inputSchema: {
              type: "object",
            },
          },
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

    const bootstrapCallResponse = await fetch(surface.mcpUrl, {
      method: "POST",
      headers: modernHeaders("tools/call", "bootstrap"),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bootstrap-call-1",
        method: "tools/call",
        params: {
          name: "bootstrap",
          arguments: {},
          _meta: meta,
        },
      }),
    });

    expect(bootstrapCallResponse.status).toBe(200);
    const bootstrapPayload = await bootstrapCallResponse.json() as any;
    const bootstrapText = bootstrapPayload.result.content[0].text as string;
    expect(JSON.parse(bootstrapText)).toMatchObject({
      model: "gpt-5.6-sol",
      environment: {
        cwd: "/repo",
        shell: "zsh",
      },
      skills_available: true,
      skills: [{ name: "alpha", description: "A" }],
    });

    const skillsCallResponse = await fetch(surface.mcpUrl, {
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

    expect(skillsCallResponse.status).toBe(200);
    await expect(skillsCallResponse.json()).resolves.toMatchObject({
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

  it("drains a native reply after modern MCP cancellation and then accepts another call", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(initialRequest(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();
    const projectedTools = selectProjectedNativeTools([
      { name: "exec_command", description: "LIVE DIRECT EXEC DESCRIPTION" },
    ]);

    const surface = new RoutewireHttpSurface({ bridge });
    await surface.start();
    surface.setMcpServer(
      createRoutewireMcpServer({ bridge, execSpec, projectedTools }),
      execSpec,
      projectedTools,
    );
    closers.push(async () => {
      bridge.close("test complete");
      await surface.close();
    });

    const controller = new AbortController();
    const request = fetch(surface.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "exec_command",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cancel-call-1",
        method: "tools/call",
        params: {
          name: "exec_command",
          arguments: { cmd: "printf CANCEL_MODERN" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "routewire-test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    controller.abort();
    await request.catch(() => undefined);

    await vi.waitFor(async () => {
      await expect(bridge.invokeExec("text('probe-after-cancel');")).rejects.toThrow(
        /already active/i,
      );
    });
    const first = providerReply;
    if (!first || first.kind !== "tool_call") throw new Error("expected first call");
    bridge.acceptModelRequest({...initialRequest(), input: [...initialRequest().input, {
      type:"custom_tool_call_output",call_id:first.callId,output:[{type:"input_text",text:"late native completion"}],
    }]}, reply => {providerReply=reply;});
    const next=bridge.invokeExec("text('after cancellation');");
    const second=providerReply;
    if (!second || second.kind !== "tool_call") throw new Error("expected next call");
    bridge.acceptModelRequest({...initialRequest(), input:[...initialRequest().input,{
      type:"custom_tool_call_output",call_id:second.callId,output:[{type:"input_text",text:"recovered"}],
    }]},()=>undefined);
    await expect(next).resolves.toMatchObject({content:[{type:"text",text:"recovered"}]});
  });
});
