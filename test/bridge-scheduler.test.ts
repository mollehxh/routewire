import {describe, expect, it} from "vitest";
import {CodexTurnBridge} from "../src/bridge.js";
import {invokeExecAndWait} from "../src/mcp/code-mode.js";
import type {ProviderReply} from "../src/provider/protocol.js";

function harness() {
  const bridge = new CodexTurnBridge({model: "test"});
  const replies: ProviderReply[] = [];
  const request = (output?: {callId: string; text: string; functionCall: boolean}) => ({model: "test", input: [
    {type: "additional_tools", tools: [{type: "namespace", name: "functions", tools: [
      {type: "custom", name: "exec", description: "exec", format: {type: "grammar", syntax: "lark", definition: "start: SOURCE"}},
      {type: "function", name: "wait", description: "wait", parameters: {type: "object", properties: {cell_id: {type: "string"}}}},
    ]}]},
    ...(output ? [{type: output.functionCall ? "function_call_output" : "custom_tool_call_output", call_id: output.callId, output: output.functionCall ? output.text : [{type: "input_text", text: output.text}]}] : []),
  ]});
  bridge.acceptModelRequest(request(), reply => replies.push(reply));
  return {bridge, replies, finish(text: string) {
    const last = replies.at(-1);
    if (last?.kind !== "tool_call") throw new Error("No native call");
    bridge.acceptModelRequest(request({callId: last.callId, text, functionCall: last.name === "wait"}), reply => replies.push(reply));
  }};
}

describe("native bridge operation queue", () => {
  it("queues a command behind inventory and reserves yielded continuations", async () => {
    const h = harness();
    const inventory = invokeExecAndWait(h.bridge, "inventory");
    const command = invokeExecAndWait(h.bridge, "command");
    expect(h.replies).toHaveLength(1);
    h.finish("Script running with cell ID 12\n");
    await expect.poll(() => h.replies.length).toBe(2);
    expect(h.replies[1]).toMatchObject({namespace: "functions", name: "wait"});
    h.finish("inventory ready");
    await expect(inventory).resolves.toMatchObject({isError: false});
    await expect.poll(() => h.replies.length).toBe(3);
    expect(h.replies[2]).toMatchObject({input: "command"});
    h.finish("command ready");
    await expect(command).resolves.toMatchObject({content: [{type: "text", text: "command ready"}]});
    h.bridge.close();
  });

  it("rejects cancellation promptly but waits for native termination before the next command", async () => {
    const h = harness();
    const controller = new AbortController();
    const running = invokeExecAndWait(h.bridge, "slow", {signal: controller.signal});
    const cancelled = expect(running).rejects.toMatchObject({name: "AbortError"});
    const next = invokeExecAndWait(h.bridge, "next");
    controller.abort();
    await cancelled;
    expect(h.replies).toHaveLength(1);
    h.finish("Script running with cell ID 7\n");
    await expect.poll(() => h.replies.length).toBe(2);
    expect(h.replies[1]).toMatchObject({name: "wait", arguments: JSON.stringify({cell_id: "7", terminate: true})});
    h.finish("terminated");
    await expect.poll(() => h.replies.length).toBe(3);
    h.finish("recovered");
    await expect(next).resolves.toMatchObject({isError: false});
    h.bridge.close();
  });

  it("drains a pending wait before terminating the cell on cancellation", async () => {
    const h = harness();
    const controller = new AbortController();
    const running = invokeExecAndWait(h.bridge, "slow", {signal: controller.signal});
    const cancelled = expect(running).rejects.toMatchObject({name: "AbortError"});
    h.finish("Script running with cell ID 9\n");
    await expect.poll(() => h.replies.length).toBe(2);
    controller.abort();
    await cancelled;
    const next = invokeExecAndWait(h.bridge, "next");
    expect(h.replies).toHaveLength(2);
    h.finish("Script running with cell ID 9\n");
    await expect.poll(() => h.replies.length).toBe(3);
    expect(h.replies[2]).toMatchObject({name: "wait", arguments: JSON.stringify({cell_id: "9", terminate: true})});
    h.finish("terminated");
    await expect.poll(() => h.replies.length).toBe(4);
    h.finish("recovered");
    await next;
    h.bridge.close();
  });

  it("does not dispatch a queued cancelled command", async () => {
    const h = harness();
    const first = invokeExecAndWait(h.bridge, "first");
    const controller = new AbortController();
    const queued = invokeExecAndWait(h.bridge, "cancelled", {signal: controller.signal});
    const rejected = expect(queued).rejects.toMatchObject({name: "AbortError"});
    controller.abort();
    await rejected;
    h.finish("done");
    await first;
    expect(h.replies).toHaveLength(1);
    h.bridge.close();
  });
});
