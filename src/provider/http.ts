import type { IncomingMessage, ServerResponse } from "node:http";

import type { CodexTurnBridge } from "../bridge.js";
import type { ProviderReply } from "./protocol.js";

export async function handleProviderHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bridge: CodexTurnBridge,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, { models: [] });
    return true;
  }

  if (req.method !== "POST" || url.pathname !== "/v1/responses") return false;

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: { message: errorMessage(error) } });
    return true;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": sideband keepalive\n\n");
  }, 15_000);
  keepAlive.unref();
  res.once("close", () => clearInterval(keepAlive));

  const finish = (reply: ProviderReply) => {
    clearInterval(keepAlive);
    if (res.writableEnded) return;
    for (const event of replyEvents(reply)) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  };

  try {
    bridge.acceptModelRequest(body, finish);
  } catch (error) {
    clearInterval(keepAlive);
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }

  return true;
}

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

function replyEvents(reply: ProviderReply): SseEvent[] {
  const responseId =
    reply.kind === "tool_call"
      ? `resp_${reply.callId}`
      : `resp_sideband_complete_${Date.now()}`;

  const created: SseEvent = {
    type: "response.created",
    response: { id: responseId },
  };

  const output: SseEvent =
    reply.kind === "tool_call"
      ? {
          type: "response.output_item.done",
          item: {
            type: "custom_tool_call",
            call_id: reply.callId,
            namespace: reply.namespace,
            name: reply.name,
            input: reply.input,
          },
        }
      : {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: `${responseId}_message`,
            content: [{ type: "output_text", text: reply.text }],
          },
        };

  const completed: SseEvent = {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };

  return [created, output, completed];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
