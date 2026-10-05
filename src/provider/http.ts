import type { IncomingMessage, ServerResponse } from "node:http";

import type { CodexTurnBridge } from "../bridge.js";
import { runwireEnvFlag } from "../env.js";
import {
  isAllowedChildRequest,
  proxyChildRequest,
  type LunaProxyOptions,
} from "./luna.js";
import { isRecord } from "./protocol.js";
import type { ProviderReply } from "./protocol.js";

let providerRequestSequence = 0;
const rootThreadIds = new WeakMap<CodexTurnBridge, string>();

export async function handleProviderHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bridge: CodexTurnBridge,
  lunaOptions: LunaProxyOptions = {},
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

  const requestId = ++providerRequestSequence;
  if (providerDebugEnabled()) {
    process.stderr.write(
      `[runwire] provider request #${requestId}: ${JSON.stringify(providerRequestSummary(body))}\n`,
    );
  }

  const parentThreadId = singleHeader(req.headers["x-codex-parent-thread-id"]);
  const allowedChildModels = lunaOptions.allowedModels ?? ["gpt-6-luna"];
  if (parentThreadId && isAllowedChildRequest(body, allowedChildModels)) {
    try {
      const rootThreadId = rootThreadIds.get(bridge);
      await proxyChildRequest(req, res, body, {
        ...lunaOptions,
        allowedModels: allowedChildModels,
        syntheticRootChild:
          lunaOptions.syntheticRootChild ?? Boolean(rootThreadId && parentThreadId === rootThreadId),
      });
    } catch (error) {
      const message = errorMessage(error);
      logProviderError(body, message);
      sendFailedStream(res, "runwire_luna_proxy_error", message);
    }
    return true;
  }

  if (isRecord(body) && body.model === bridge.model) {
    const threadId = singleHeader(req.headers["thread-id"]);
    if (threadId && !rootThreadIds.has(bridge)) rootThreadIds.set(bridge, threadId);
  }

  if (isRecord(body) && body.model !== bridge.model) {
    const message = `Unsupported Runwire model request: ${String(body.model)}`;
    logProviderError(body, message);
    sendFailedStream(res, "runwire_model_not_allowed", message);
    return true;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(": runwire keepalive\n\n");
  }, 15_000);
  keepAlive.unref();
  res.once("close", () => clearInterval(keepAlive));

  const finish = (reply: ProviderReply) => {
    clearInterval(keepAlive);
    if (res.writableEnded) return;
    if (providerDebugEnabled()) {
      process.stderr.write(
        `[runwire] provider reply #${requestId}: ${JSON.stringify(providerReplySummary(reply))}\n`,
      );
    }
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
    const message = errorMessage(error);
    logProviderError(body, message);
    if (!res.writableEnded) {
      const responseId = `resp_runwire_error_${Date.now()}`;
      sendFailedEvent(res, responseId, "runwire_bridge_error", message);
    }
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
      : `resp_runwire_complete_${Date.now()}`;

  const created: SseEvent = {
    type: "response.created",
    response: { id: responseId },
  };

  const output: SseEvent =
    reply.kind === "tool_call"
      ? reply.callType === "custom"
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
              type: "function_call",
              call_id: reply.callId,
              namespace: reply.namespace,
              name: reply.name,
              arguments: reply.arguments,
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

function sendFailedStream(res: ServerResponse, code: string, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  sendFailedEvent(res, `resp_runwire_error_${Date.now()}`, code, message);
}

function sendFailedEvent(
  res: ServerResponse,
  responseId: string,
  code: string,
  message: string,
): void {
  const failed = {
    type: "response.failed",
    response: {
      id: responseId,
      error: { code, message },
    },
  };
  res.write(`event: response.failed\n`);
  res.write(`data: ${JSON.stringify(failed)}\n\n`);
  res.end();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logProviderError(body: unknown, message: string): void {
  const summary = providerRequestSummary(body);
  process.stderr.write(
    `[runwire] provider bridge error: ${message}; ${JSON.stringify(summary)}\n`,
  );
}

function providerRequestSummary(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { bodyType: typeof body };
  const record = body as Record<string, unknown>;
  const input = Array.isArray(record.input) ? record.input : [];
  const inputTypes = input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return typeof item;
    const type = (item as Record<string, unknown>).type;
    return typeof type === "string" ? type : "object";
  });
  let requestKind: unknown;
  const metadata = record.client_metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const raw = (metadata as Record<string, unknown>)["x-codex-turn-metadata"];
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        requestKind = parsed.request_kind;
      } catch {
        requestKind = "unparseable";
      }
    }
  }
  return {
    model: record.model,
    requestKind,
    inputTypes,
  };
}

function providerReplySummary(reply: ProviderReply): Record<string, unknown> {
  return reply.kind === "tool_call"
    ? {
        kind: reply.kind,
        callType: reply.callType,
        callId: reply.callId,
        namespace: reply.namespace,
        name: reply.name,
      }
    : { kind: reply.kind };
}

function providerDebugEnabled(): boolean {
  return runwireEnvFlag("RUNWIRE_DEBUG", "SIDEBAND_DEBUG");
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
