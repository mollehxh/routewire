import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexTurnBridge } from "../src/bridge.js";
import { SIDEBAND_MCP_INSTRUCTIONS } from "../src/mcp/instructions.js";
import { selectProjectedNativeTools } from "../src/mcp/projected-tools.js";
import { createSidebandMcpServer } from "../src/mcp/server.js";
import type { ProviderReply } from "../src/provider/protocol.js";

const resources: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.close();
});

function requestWithExec(output?: { callId: string; output: unknown }) {
  const input: unknown[] = [
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
              description: "EXACT CODEX EXEC DESCRIPTION",
              format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" },
            },
          ],
        },
      ],
    },
  ];

  if (output) {
    input.push({
      type: "custom_tool_call_output",
      call_id: output.callId,
      output: output.output,
    });
  }

  return { model: "gpt-5.6-sol", input };
}

function requestWithContext() {
  const request = requestWithExec();
  return {
    ...request,
    input: [
      ...request.input,
      {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: "<permissions instructions>Approval policy is currently never.</permissions instructions>",
        }],
      },
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nKeep it simple.\n</INSTRUCTIONS>",
        }],
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

describe("Sideband MCP server", () => {
  it("publishes Codex's captured exec description and forwards MCP calls into the waiting Codex turn", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(requestWithExec(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();

    const server = createSidebandMcpServer({ bridge, execSpec });
    const client = new Client({ name: "sideband-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getInstructions()).toBe(SIDEBAND_MCP_INSTRUCTIONS);
    expect(client.getInstructions()).toContain("$skills");
    expect(client.getInstructions()).toContain("get_skill");

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["bootstrap", "exec"]);
    const execTool = listed.tools.find(tool => tool.name === "exec")!;
    expect(execTool.description).toContain("EXACT CODEX EXEC DESCRIPTION");
    expect(execTool.description).toContain("Prefer a directly exposed native tool");
    expect(execTool.inputSchema).toMatchObject({
      type: "object",
      required: ["code"],
    });

    const call = client.callTool({
      name: "exec",
      arguments: { code: "text(await tools.exec_command({cmd:'pwd'}));" },
    });

    await vi.waitFor(() => {
      expect(providerReply?.kind).toBe("tool_call");
    });
    if (!providerReply || providerReply.kind !== "tool_call") {
      throw new Error("expected provider tool call");
    }
    expect(providerReply.input).toContain("tools.exec_command");
    expect(providerReply.input).toContain("Blocked model-spawning tool");

    bridge.acceptModelRequest(
      requestWithExec({
        callId: providerReply.callId,
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
          { type: "input_text", text: "native-result" },
        ],
      }),
      () => undefined,
    );

    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "native-result" }],
      isError: false,
    });
  });

  it("projects a native exec_command tool directly while still executing through Codex functions.exec", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(requestWithExec(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();
    const projectedTools = selectProjectedNativeTools([
      {
        name: "exec_command",
        description: "LIVE NATIVE EXEC COMMAND DESCRIPTION",
      },
    ]);

    const server = createSidebandMcpServer({ bridge, execSpec, projectedTools });
    const client = new Client({ name: "sideband-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["bootstrap", "exec_command", "exec"]);
    const directTool = listed.tools.find(tool => tool.name === "exec_command")!;
    expect(directTool.description).toContain("LIVE NATIVE EXEC COMMAND DESCRIPTION");
    expect(directTool.inputSchema).toMatchObject({
      type: "object",
      required: ["cmd"],
    });

    const call = client.callTool({
      name: "exec_command",
      arguments: { cmd: "printf DIRECT" },
    });

    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    if (!providerReply || providerReply.kind !== "tool_call") {
      throw new Error("expected provider tool call");
    }
    expect(providerReply.input).toContain('tools["exec_command"]');
    expect(providerReply.input).toContain("printf DIRECT");

    bridge.acceptModelRequest(
      requestWithExec({
        callId: providerReply.callId,
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
          {
            type: "input_text",
            text: '{"exit_code":0,"wall_time_seconds":0,"output":"DIRECT RESULT"}',
          },
        ],
      }),
      () => undefined,
    );

    await expect(call).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"exit_code":0,"wall_time_seconds":0,"output":"DIRECT RESULT"}',
        },
      ],
      isError: false,
    });
  });

  it("removes Code Mode transport wrappers and duplicate projected-tool errors", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(requestWithExec(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();
    const projectedTools = selectProjectedNativeTools([
      {
        name: "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js",
        description: "CUA",
      },
    ]);
    const server = createSidebandMcpServer({ bridge, execSpec, projectedTools });
    const client = new Client({ name: "sideband-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = client.callTool({
      name: "mcp__codex_apps__desktop_runtime_mcp__cua_repl__js",
      arguments: { code: "await cua.getState();" },
    });
    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    if (!providerReply || providerReply.kind !== "tool_call") throw new Error("missing CUA tool call");
    bridge.acceptModelRequest(
      requestWithExec({
        callId: providerReply.callId,
        output: [
          { type: "input_text", text: "Script failed\nWall time 1.0 seconds\nOutput:\n" },
          { type: "input_text", text: "Wall time: 0.0125 seconds\nOutput:" },
          { type: "input_text", text: '{"error":{"code":"tool_unavailable"},"ok":false}' },
          { type: "input_text", text: "__SIDEBAND_PROJECTED_NATIVE_ERROR__" },
        ],
      }),
      () => undefined,
    );

    await expect(call).resolves.toEqual({
      content: [
        { type: "text", text: '{"error":{"code":"tool_unavailable"},"ok":false}' },
      ],
      isError: true,
    });
  });

  it("turns an empty successful apply_patch payload into a useful result", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(requestWithExec(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();
    const projectedTools = selectProjectedNativeTools([
      { name: "apply_patch", description: "PATCH" },
    ]);
    const server = createSidebandMcpServer({ bridge, execSpec, projectedTools });
    const client = new Client({ name: "sideband-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = client.callTool({
      name: "apply_patch",
      arguments: { patch: "*** Begin Patch\n*** End Patch" },
    });
    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    if (!providerReply || providerReply.kind !== "tool_call") throw new Error("missing patch tool call");
    bridge.acceptModelRequest(
      requestWithExec({
        callId: providerReply.callId,
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
          { type: "input_text", text: "{}" },
        ],
      }),
      () => undefined,
    );

    await expect(call).resolves.toEqual({
      content: [{ type: "text", text: "Patch applied." }],
      isError: false,
    });
  });

  it("exposes skills/get_skill from the local Codex skill resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "sideband-mcp-skills-"));
    const skillRoot = join(root, "skills");
    const skillDir = join(skillRoot, "alpha");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: alpha\ndescription: A\n---\n\nbody\n",
      "utf8",
    );

    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    bridge.acceptModelRequest(requestWithExec(), () => undefined);
    const execSpec = await bridge.ready();
    const nativeSkillTools = { kind: "local" as const, roots: [skillRoot] };

    const server = createSidebandMcpServer({ bridge, execSpec, nativeSkillTools });
    const client = new Client({ name: "sideband-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["bootstrap", "skills", "get_skill", "exec"]);
    expect(listed.tools.find(tool => tool.name === "skills")?.description).toContain(
      "Codex's native skill catalog",
    );
    expect(listed.tools.find(tool => tool.name === "get_skill")?.inputSchema).toMatchObject({
      type: "object",
      required: ["names"],
    });

    const skillsResult = await client.callTool({ name: "skills", arguments: {} });
    expect(JSON.parse(skillsResult.content.find(item => item.type === "text")!.text)).toEqual({
      skills: [{ name: "alpha", description: "A" }],
    });

    const getResult = await client.callTool({
      name: "get_skill",
      arguments: { names: ["alpha"] },
    });
    expect(JSON.parse(getResult.content.find(item => item.type === "text")!.text)).toEqual({
      skills: [{
        name: "alpha",
        content: "---\nname: alpha\ndescription: A\n---\n\nbody\n",
      }],
    });
  });

  it("returns safe current Codex context from bootstrap without exposing arbitrary prompts", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    bridge.acceptModelRequest(requestWithContext(), () => undefined);
    const execSpec = await bridge.ready();
    const server = createSidebandMcpServer({ bridge, execSpec });
    const client = new Client({ name: "sideband-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "bootstrap", arguments: {} });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content.find(item => item.type === "text")!.text);
    expect(payload).toMatchObject({
      model: "gpt-5.6-sol",
      environment: {
        cwd: "/repo",
        shell: "zsh",
        current_date: "2026-10-01",
        timezone: "Europe/Moscow",
        workspace_roots: ["/repo"],
        permission_profile: "managed",
        file_system: "restricted",
      },
      permissions: "Approval policy is currently never.",
      project_instructions: [{ scope: "/repo", content: "Keep it simple." }],
      skills_available: false,
      skills: [],
    });
  });
});
