import { describe, expect, it, vi } from "vitest";

import {
  prepareLunaRequest,
  proxyChildRequest,
  proxyLunaRequest,
  validateChildResponse,
  validateLunaResponse,
} from "../src/provider/luna.js";

function lunaBody() {
  return {
    model: "gpt-6-luna",
    reasoning: { effort: "high", context: "all_turns" },
    input: [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: "collaboration",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                description:
                  "Available model overrides (optional; inherited parent model is preferred):\n- `gpt-6-sol`: other\n- `gpt-6-luna`: luna\nSpawns an agent to work on the specified task.",
                parameters: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    reasoning_effort: { type: "string" },
                    message: { type: "string" },
                    task_name: { type: "string" },
                  },
                  required: ["task_name", "message"],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function fakeRequest(headers: Record<string, string>) {
  return { headers } as never;
}

function fakeResponse() {
  const state: { status?: number; headers?: unknown; body?: string } = {};
  return {
    state,
    response: {
      writeHead(status: number, headers: unknown) {
        state.status = status;
        state.headers = headers;
      },
      end(body?: string) {
        state.body = body;
      },
    } as never,
  };
}

const okSse = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_luna"}}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"resp_luna"}}',
  "",
].join("\n");

describe("Luna provider routing", () => {
  it("validates completed spawn arguments after added and delta events", () => {
    const item = {type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: ""};
    const events = [
      {type: "response.output_item.added", item},
      {type: "response.function_call_arguments.delta", delta: '{"model":'},
      {type: "response.output_item.done", item: {...item, arguments: JSON.stringify({model: "gpt-6-luna", reasoning_effort: "high"})}},
    ];
    const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
    expect(() => validateChildResponse(sse, ["gpt-6-luna"])).not.toThrow();
    expect(() => validateChildResponse(sse.replace('gpt-6-luna', 'gpt-6-sol'), ["gpt-6-luna"])).toThrow(/cannot spawn/);
  });

  it("validates completed response output even without an output_item.done event", () => {
    const sse = `data: ${JSON.stringify({type: "response.completed", response: {output: [{type: "function_call", name: "spawn_agent", arguments: '{"model":"blocked"}'}]}})}\n\n`;
    expect(() => validateChildResponse(sse, ["gpt-6-luna"])).toThrow(/cannot spawn/);
  });
  it("turns synthetic root encrypted task payloads back into plain child input", () => {
    const body = lunaBody();
    body.input.push({
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "Review the tests." },
      ],
    } as never);

    const prepared = prepareLunaRequest(body, true);
    const message = (prepared.input as Array<Record<string, unknown>>).at(-1)!;
    expect(message.content).toEqual([
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "input_text", text: "Review the tests." },
    ]);
    expect(body.input.at(-1)).toMatchObject({
      content: [
        { type: "input_text" },
        { type: "encrypted_content", encrypted_content: "Review the tests." },
      ],
    });
  });

  it("preserves genuine nested-agent encrypted content", () => {
    const body = lunaBody();
    body.input.push({
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: "ciphertext" }],
    } as never);

    expect(prepareLunaRequest(body, false)).toBe(body);
  });

  it("routes ChatGPT-auth requests without rewriting reserved Codex tool declarations", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("gpt-6-luna");
      expect(body).toEqual(lunaBody());
      expect((init?.headers as Headers).get("authorization")).toBe("Bearer secret-token");
      return new Response(okSse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { state, response } = fakeResponse();

    await proxyLunaRequest(
      fakeRequest({
        authorization: "Bearer secret-token",
        "chatgpt-account-id": "acct",
        "content-type": "application/json",
      }),
      response,
      lunaBody(),
      {
        fetchImpl: fetchImpl as typeof fetch,
        chatgptResponsesUrl: "https://chatgpt.invalid/codex/responses",
        syntheticRootChild: false,
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chatgpt.invalid/codex/responses",
      expect.objectContaining({ method: "POST" }),
    );
    expect(state.status).toBe(200);
    expect(state.body).toBe(okSse);
  });

  it("rejects API-key-only auth instead of falling back to API billing", async () => {
    const fetchImpl = vi.fn();
    const { response } = fakeResponse();

    await expect(
      proxyLunaRequest(
        fakeRequest({ authorization: "Bearer sk-test" }),
        response,
        lunaBody(),
        { fetchImpl: fetchImpl as typeof fetch },
      ),
    ).rejects.toThrow(/API-key billing is not supported/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an upstream Luna response that tries to spawn another model", () => {
    const invalid = [
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          call_id: "bad",
          arguments: JSON.stringify({
            task_name: "bad",
            message: "bad",
            model: "gpt-6-sol",
          }),
        },
      })}`,
      "",
    ].join("\n");

    expect(() => validateLunaResponse(invalid)).toThrow(/cannot spawn model gpt-6-sol/i);
  });

  it("validates successful upstream event streams even when content-type is absent", async () => {
    const invalid = [
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          call_id: "bad",
          arguments: JSON.stringify({
            task_name: "bad",
            message: "bad",
            model: "gpt-6-sol",
          }),
        },
      })}`,
      "",
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(invalid, { status: 200 }));
    const { response } = fakeResponse();

    await expect(
      proxyLunaRequest(
        fakeRequest({
          authorization: "Bearer secret-token",
          "chatgpt-account-id": "acct",
        }),
        response,
        lunaBody(),
        { fetchImpl: fetchImpl as typeof fetch },
      ),
    ).rejects.toThrow(/cannot spawn model gpt-6-sol/i);
  });

  it("forwards medium Luna inference when authenticated", async () => {
    const fetchImpl = vi.fn(async () => new Response(okSse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const { response } = fakeResponse();
    const body = { ...lunaBody(), reasoning: { effort: "medium" } };

    await proxyLunaRequest(
      fakeRequest({ authorization: "Bearer secret", "chatgpt-account-id": "acct" }),
      response,
      body,
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects reasoning effort unsupported by the selected model before forwarding", async () => {
    const fetchImpl = vi.fn();
    const { response } = fakeResponse();
    const body = { ...lunaBody(), model: "gpt-5.5", reasoning: { effort: "max" } };

    await expect(
      proxyChildRequest(
        fakeRequest({ authorization: "Bearer secret", "chatgpt-account-id": "acct" }),
        response,
        body,
        {
          fetchImpl: fetchImpl as typeof fetch,
          allowedModels: ["gpt-5.5"],
          modelEfforts: { "gpt-5.5": ["low", "medium", "high", "xhigh"] },
        },
      ),
    ).rejects.toThrow(/not supported by gpt-5.5/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("proxies another explicitly allowed Codex child model", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("gpt-5.6-terra");
      return new Response(okSse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { response } = fakeResponse();
    await proxyChildRequest(
      fakeRequest({ authorization: "Bearer secret-token", "chatgpt-account-id": "acct" }),
      response,
      { ...lunaBody(), model: "gpt-5.6-terra" },
      { fetchImpl: fetchImpl as typeof fetch, allowedModels: ["gpt-5.6-terra"] },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects descendant spawns outside the configured allowlist", () => {
    const invalid = [
      "event: response.output_item.done",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: JSON.stringify({ model: "gpt-5.6-sol" }),
        },
      })}`,
      "",
    ].join("\n");
    expect(() => validateChildResponse(invalid, ["gpt-6-luna", "gpt-5.6-terra"])).toThrow(
      /cannot spawn model gpt-5.6-sol/i,
    );
  });

});
