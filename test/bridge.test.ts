import { describe, expect, it } from "vitest";

import { CodexTurnBridge } from "../src/bridge.js";
import type { ProviderReply } from "../src/provider/protocol.js";

function modelRequest(callOutput?: { callId: string; output: unknown }) {
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
              description: "Run JavaScript against Codex native tools.",
              format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" },
            },
          ],
        },
      ],
    },
  ];

  if (callOutput) {
    input.push({
      type: "custom_tool_call_output",
      call_id: callOutput.callId,
      output: callOutput.output,
    });
  }

  return {
    model: "gpt-5.6-sol",
    input,
  };
}

describe("CodexTurnBridge", () => {
  it("exposes the captured functions.exec declaration and round-trips calls through a persistent Codex turn", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const firstReplies: ProviderReply[] = [];

    bridge.acceptModelRequest(modelRequest(), reply => firstReplies.push(reply));

    await expect(bridge.ready()).resolves.toMatchObject({
      name: "exec",
      description: "Run JavaScript against Codex native tools.",
    });

    const firstCall = bridge.invokeExec("text(await tools.exec_command({cmd: 'pwd'}));");
    expect(firstReplies).toHaveLength(1);

    const emitted = firstReplies[0];
    expect(emitted.kind).toBe("tool_call");
    if (emitted.kind !== "tool_call") throw new Error("expected tool_call");
    expect(emitted.namespace).toBe("functions");
    expect(emitted.name).toBe("exec");
    expect(emitted.input).toContain("tools.exec_command");

    const secondReplies: ProviderReply[] = [];
    bridge.acceptModelRequest(
      modelRequest({
        callId: emitted.callId,
        output: [
          { type: "input_text", text: "Script completed\n" },
          { type: "input_text", text: "cwd=/tmp/project" },
        ],
      }),
      reply => secondReplies.push(reply),
    );

    await expect(firstCall).resolves.toEqual({
      content: [
        { type: "text", text: "Script completed\n" },
        { type: "text", text: "cwd=/tmp/project" },
      ],
      isError: false,
    });

    const secondCall = bridge.invokeExec("text('second');");
    expect(secondReplies).toHaveLength(1);
    const secondEmitted = secondReplies[0];
    expect(secondEmitted.kind).toBe("tool_call");
    if (secondEmitted.kind !== "tool_call") throw new Error("expected tool_call");

    bridge.acceptModelRequest(
      modelRequest({
        callId: secondEmitted.callId,
        output: [{ type: "input_text", text: "second-result" }],
      }),
      () => undefined,
    );

    await expect(secondCall).resolves.toMatchObject({
      content: [{ type: "text", text: "second-result" }],
    });
  });

  it("forwards inline image output from Codex to MCP content", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let reply: ProviderReply | undefined;
    bridge.acceptModelRequest(modelRequest(), value => {
      reply = value;
    });
    await bridge.ready();

    const call = bridge.invokeExec("image(await tools.view_image({path:'shot.png'}));");
    expect(reply?.kind).toBe("tool_call");
    if (!reply || reply.kind !== "tool_call") throw new Error("expected tool_call");

    bridge.acceptModelRequest(
      modelRequest({
        callId: reply.callId,
        output: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,aGVsbG8=",
          },
        ],
      }),
      () => undefined,
    );

    await expect(call).resolves.toEqual({
      content: [
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
      ],
      isError: false,
    });
  });

  it("rejects a second MCP call while one Codex tool call is still active", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    bridge.acceptModelRequest(modelRequest(), () => undefined);
    await bridge.ready();

    void bridge.invokeExec("text('one');");
    await expect(bridge.invokeExec("text('two');")).rejects.toThrow(/already active/i);
  });

  it("rebinds an identical pending Codex request after a provider-stream retry", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const abandonedReplies: ProviderReply[] = [];
    const retryReplies: ProviderReply[] = [];
    const request = modelRequest();

    bridge.acceptModelRequest(request, reply => abandonedReplies.push(reply));
    await bridge.ready();
    bridge.acceptModelRequest(
      {
        ...request,
        client_metadata: { retry: "transport metadata may differ" },
      },
      reply => retryReplies.push(reply),
    );

    void bridge.invokeExec("text('after-reconnect');");

    expect(abandonedReplies).toHaveLength(0);
    expect(retryReplies).toHaveLength(1);
    expect(retryReplies[0]).toMatchObject({
      kind: "tool_call",
      callId: "sideband-1",
    });
  });

  it("replays the same active tool call when Codex retries the request that produced it", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const firstReplies: ProviderReply[] = [];
    const retryReplies: ProviderReply[] = [];
    const request = modelRequest();

    bridge.acceptModelRequest(request, reply => firstReplies.push(reply));
    await bridge.ready();
    const call = bridge.invokeExec("text('once');");
    expect(firstReplies).toHaveLength(1);
    const emitted = firstReplies[0];
    if (emitted.kind !== "tool_call") throw new Error("expected tool_call");

    bridge.acceptModelRequest(request, reply => retryReplies.push(reply));
    expect(retryReplies).toEqual([emitted]);

    bridge.acceptModelRequest(
      modelRequest({
        callId: emitted.callId,
        output: [{ type: "input_text", text: "eventual-output" }],
      }),
      () => undefined,
    );

    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "eventual-output" }],
    });
  });

  it("still rejects a genuinely different model request while one is pending", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    bridge.acceptModelRequest(modelRequest(), () => undefined);
    await bridge.ready();

    expect(() =>
      bridge.acceptModelRequest(
        {
          ...modelRequest(),
          input: [...modelRequest().input, { type: "message", role: "user", content: "different" }],
        },
        () => undefined,
      ),
    ).toThrow(/second model request/i);
  });

  it("returns each native agent message once with the next completed tool call", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    let reply: ProviderReply | undefined;
    const followupReplies: ProviderReply[] = [];
    const request = modelRequest();
    request.input[0] = {
      type: "additional_tools",
      tools: [
        ...(request.input[0] as { tools: unknown[] }).tools,
        {
          type: "namespace",
          name: "collaboration",
          tools: [{
            type: "function",
            name: "wait_agent",
            description: "Wait for an agent.",
            parameters: { type: "object", properties: {} },
          }],
        },
      ],
    };
    bridge.acceptModelRequest(request, value => {
      reply = value;
    });
    await bridge.ready();

    const call = bridge.invokeFunction("collaboration", "wait_agent", { timeout_ms: 10_000 });
    if (!reply || reply.kind !== "tool_call") throw new Error("expected collaboration call");

    bridge.acceptModelRequest(
      {
        ...request,
        input: [
          ...request.input,
          {
            type: "function_call_output",
            call_id: reply.callId,
            output: '{"message":"Wait completed.","timed_out":false}',
          },
          {
            type: "agent_message",
            id: "agent-message-1",
            content: [{
              type: "input_text",
              text: "Message Type: FINAL_ANSWER\nSender: /root/review\nPayload:\nREVIEW_OK",
            }],
          },
        ],
      },
      value => followupReplies.push(value),
    );

    await expect(call).resolves.toEqual({
      content: [
        { type: "text", text: '{"message":"Wait completed.","timed_out":false}' },
        {
          type: "text",
          text: "Message Type: FINAL_ANSWER\nSender: /root/review\nPayload:\nREVIEW_OK",
        },
      ],
      isError: false,
    });

    const secondCall = bridge.invokeFunction("collaboration", "wait_agent", { timeout_ms: 10_000 });
    const secondReply = followupReplies[0];
    if (!secondReply || secondReply.kind !== "tool_call") {
      throw new Error("expected second collaboration call");
    }
    bridge.acceptModelRequest(
      {
        ...request,
        input: [
          ...request.input,
          {
            type: "agent_message",
            id: "agent-message-1",
            content: [{
              type: "input_text",
              text: "Message Type: FINAL_ANSWER\nSender: /root/review\nPayload:\nREVIEW_OK",
            }],
          },
          {
            type: "function_call_output",
            call_id: secondReply.callId,
            output: '{"message":"Wait completed.","timed_out":true}',
          },
        ],
      },
      () => undefined,
    );

    await expect(secondCall).resolves.toEqual({
      content: [{ type: "text", text: '{"message":"Wait completed.","timed_out":true}' }],
      isError: false,
    });
  });
});
