import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexTurnBridge } from "../src/bridge.js";
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

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]).toMatchObject({
      name: "exec",
      description: "EXACT CODEX EXEC DESCRIPTION",
    });
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
});
