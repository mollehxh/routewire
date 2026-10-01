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
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: "exec",
    });
    expect(listed.tools[0].description).toContain("EXACT CODEX EXEC DESCRIPTION");
    expect(listed.tools[0].description).toContain("Prefer a directly exposed Sideband native tool");
    expect(listed.tools[0].inputSchema).toMatchObject({
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
    expect(providerReply.input).toContain("Sideband blocked model-spawning tool");

    bridge.acceptModelRequest(
      requestWithExec({
        callId: providerReply.callId,
        output: [{ type: "input_text", text: "native-result" }],
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
    expect(listed.tools.map(tool => tool.name)).toEqual(["exec_command", "exec"]);
    expect(listed.tools[0].description).toContain("LIVE NATIVE EXEC COMMAND DESCRIPTION");
    expect(listed.tools[0].inputSchema).toMatchObject({
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
        output: [{ type: "input_text", text: "DIRECT RESULT" }],
      }),
      () => undefined,
    );

    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "DIRECT RESULT" }],
      isError: false,
    });
  });

  it("exposes skills/get_skill as thin wrappers over Codex native skill tools", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let providerReply: ProviderReply | undefined;
    bridge.acceptModelRequest(requestWithExec(), reply => {
      providerReply = reply;
    });
    const execSpec = await bridge.ready();
    const nativeSkillTools = {
      listName: "mcp__codex_apps__fkn_codex_codex_skills_list",
      getName: "mcp__codex_apps__fkn_codex_codex_skill_get",
    };

    const server = createSidebandMcpServer({ bridge, execSpec, nativeSkillTools });
    const client = new Client({ name: "sideband-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(["skills", "get_skill", "exec"]);
    expect(listed.tools.find(tool => tool.name === "skills")?.description).toContain(
      "Codex's native skill catalog",
    );
    expect(listed.tools.find(tool => tool.name === "get_skill")?.inputSchema).toMatchObject({
      type: "object",
      required: ["names"],
    });

    const skillsCall = client.callTool({ name: "skills", arguments: {} });
    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    if (!providerReply || providerReply.kind !== "tool_call") throw new Error("missing skills tool call");
    expect(providerReply.input).toContain(nativeSkillTools.listName);
    expect(providerReply.input).toContain("force_reload: false");
    bridge.acceptModelRequest(
      requestWithExec({
        callId: providerReply.callId,
        output: [{
          type: "input_text",
          text: '__SIDEBAND_SKILL_PAYLOAD_START__{"total":2,"skills":[{"name":"alpha","description":"A"},{"name":"beta","description":"B"}]}__SIDEBAND_SKILL_PAYLOAD_END__',
        }],
      }),
      reply => {
        providerReply = reply;
      },
    );
    const skillsResult = await skillsCall;
    expect(JSON.parse(skillsResult.content.find(item => item.type === "text")!.text)).toEqual({
      skills: [
        { name: "alpha", description: "A" },
        { name: "beta", description: "B" },
      ],
    });

    providerReply = undefined;
    const getCall = client.callTool({
      name: "get_skill",
      arguments: { names: ["alpha"] },
    });
    await vi.waitFor(() => expect(providerReply?.kind).toBe("tool_call"));
    const getReply = providerReply as ProviderReply | undefined;
    if (!getReply || getReply.kind !== "tool_call") throw new Error("missing get_skill tool call");
    expect(getReply.input).toContain(nativeSkillTools.getName);
    expect(getReply.input).toContain('name: "alpha"');
    bridge.acceptModelRequest(
      requestWithExec({
        callId: getReply.callId,
        output: [{
          type: "input_text",
          text: '__SIDEBAND_SKILL_PAYLOAD_START__{"total":24,"chunk":"---\\nname: alpha\\n---\\nbody"}__SIDEBAND_SKILL_PAYLOAD_END__',
        }],
      }),
      () => undefined,
    );
    const getResult = await getCall;
    expect(JSON.parse(getResult.content.find(item => item.type === "text")!.text)).toEqual({
      skills: [{ name: "alpha", content: "---\nname: alpha\n---\nbody" }],
      errors: [],
    });
  });
});
