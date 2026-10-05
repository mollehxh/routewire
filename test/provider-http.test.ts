import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { CodexTurnBridge } from "../src/bridge.js";
import { handleProviderHttpRequest } from "../src/provider/http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve());
        }),
    ),
  );
});

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
              description: "Codex exec",
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

  return { model: "gpt-5.6-sol", input };
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("Responses-compatible provider HTTP surface", () => {
  it("holds each /responses request until the MCP side supplies the next model action", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const server = createServer(async (req, res) => {
      if (!(await handleProviderHttpRequest(req, res, bridge))) {
        res.writeHead(404).end();
      }
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const models = await fetch(`${baseUrl}/v1/models`).then(response => response.json());
    expect(models).toEqual({ models: [] });

    const firstResponse = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(modelRequest()),
    });

    await bridge.ready();
    const toolResult = bridge.invokeExec("text('hello');");

    const firstSse = await firstResponse.then(response => response.text());
    expect(firstSse).toContain('"type":"custom_tool_call"');
    expect(firstSse).toContain('"namespace":"functions"');
    expect(firstSse).toContain('"name":"exec"');
    expect(firstSse).toContain("\"input\":\"text('hello');\"");

    const callIdMatch = /"call_id":"([^"]+)"/.exec(firstSse);
    expect(callIdMatch?.[1]).toBeTruthy();
    const callId = callIdMatch![1];

    const secondResponse = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        modelRequest({
          callId,
          output: [{ type: "input_text", text: "native-output" }],
        }),
      ),
    });

    await expect(toolResult).resolves.toMatchObject({
      content: [{ type: "text", text: "native-output" }],
      isError: false,
    });

    bridge.close("test complete");
    const secondSse = await secondResponse.then(response => response.text());
    expect(secondSse).toContain('"type":"message"');
    expect(secondSse).toContain("test complete");
  });

  it("returns a valid response.failed stream when bridge state rejects a provider request", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const server = createServer(async (req, res) => {
      if (!(await handleProviderHttpRequest(req, res, bridge))) {
        res.writeHead(404).end();
      }
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const firstResponse = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(modelRequest()),
    });
    await bridge.ready();

    const rejected = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...modelRequest(),
        input: [
          ...modelRequest().input,
          { type: "message", role: "user", content: "genuinely different request" },
        ],
      }),
    });
    const rejectedSse = await rejected.text();
    expect(rejected.status).toBe(200);
    expect(rejected.headers.get("content-type")).toContain("text/event-stream");
    expect(rejectedSse).toContain("event: response.failed");
    expect(rejectedSse).toContain('"code":"routewire_bridge_error"');
    expect(rejectedSse).toContain("second model request");

    bridge.close("test complete");
    await firstResponse;
  });

  it("rebinds an identical /responses retry after the original SSE stream disconnects", async () => {
    const bridge = new CodexTurnBridge({ model: "gpt-5.6-sol" });
    const server = createServer(async (req, res) => {
      if (!(await handleProviderHttpRequest(req, res, bridge))) {
        res.writeHead(404).end();
      }
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const request = modelRequest();

    const controller = new AbortController();
    const abandoned = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    await bridge.ready();
    controller.abort();
    await abandoned.text().catch(() => undefined);

    const retryResponse = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        client_metadata: { retry_attempt: 1 },
      }),
    });

    const toolResult = bridge.invokeExec("text('retry-ok');");
    const retrySse = await retryResponse.then(response => response.text());
    expect(retrySse).toContain('"type":"custom_tool_call"');
    expect(retrySse).toContain("retry-ok");

    const callIdMatch = /"call_id":"([^"]+)"/.exec(retrySse);
    expect(callIdMatch?.[1]).toBeTruthy();
    const outputResponse = fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        modelRequest({
          callId: callIdMatch![1],
          output: [{ type: "input_text", text: "retry-output" }],
        }),
      ),
    });

    await expect(toolResult).resolves.toMatchObject({
      content: [{ type: "text", text: "retry-output" }],
      isError: false,
    });

    bridge.close("test complete");
    await outputResponse;
  });
});
