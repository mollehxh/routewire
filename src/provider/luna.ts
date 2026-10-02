import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { isRecord } from "./protocol.js";

export const LUNA_MODEL = "gpt-6-luna";
export const LUNA_REASONING_EFFORTS = ["high", "xhigh", "max"] as const;

const DEFAULT_CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface LunaProxyOptions {
  fetchImpl?: typeof fetch;
  chatgptResponsesUrl?: string;
  syntheticRootChild?: boolean;
}

export function isLunaRequest(body: unknown): body is Record<string, unknown> {
  return isRecord(body) && body.model === LUNA_MODEL;
}

export async function proxyLunaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  options: LunaProxyOptions = {},
): Promise<void> {
  validateLunaRequest(body);
  const authorization = singleHeader(req.headers.authorization);
  if (!authorization) {
    throw new Error("Luna subagents require Codex authentication");
  }

  if (!singleHeader(req.headers["chatgpt-account-id"])) {
    throw new Error(
      "Luna subagents require ChatGPT Codex authentication; API-key billing is not supported",
    );
  }
  const target = options.chatgptResponsesUrl ?? DEFAULT_CHATGPT_RESPONSES_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const upstream = await fetchImpl(target, {
    method: "POST",
    headers: forwardingHeaders(req.headers),
    // Codex collaboration tools are reserved server-side and their declarations
    // must match the stock client schema exactly. Enforce Sideband's Luna-only
    // policy on the exposed root tool and on upstream responses, not by
    // rewriting the child's native tool declarations.
    body: JSON.stringify(prepareLunaRequest(body, options.syntheticRootChild === true)),
    redirect: "manual",
  });

  const responseBody = await upstream.text();
  if (process.env.SIDEBAND_DEBUG === "1") {
    process.stderr.write(
      `[sideband] Luna upstream: ${JSON.stringify(lunaUpstreamSummary(upstream, responseBody))}\n`,
    );
  }
  if (upstream.ok && (isEventStream(upstream.headers.get("content-type")) || responseBody.includes("data:"))) {
    validateLunaResponse(responseBody);
  }

  const headers = responseHeaders(upstream.headers);
  res.writeHead(upstream.status, headers);
  res.end(responseBody);
}

export function validateLunaResponse(sse: string): void {
  for (const rawLine of sse.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const data = rawLine.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(event) || !isRecord(event.item)) continue;
    const item = event.item;
    if (
      item.type !== "function_call" ||
      item.name !== "spawn_agent" ||
      (item.namespace !== undefined && item.namespace !== "collaboration")
    ) {
      continue;
    }
    const rawArguments = typeof item.arguments === "string" ? item.arguments : "{}";
    let arguments_: unknown;
    try {
      arguments_ = JSON.parse(rawArguments);
    } catch {
      throw new Error("Luna spawn_agent returned invalid JSON arguments");
    }
    if (!isRecord(arguments_)) throw new Error("Luna spawn_agent arguments must be an object");
    if (arguments_.model !== undefined && arguments_.model !== LUNA_MODEL) {
      throw new Error(`Luna subagents cannot spawn model ${String(arguments_.model)}`);
    }
    if (
      arguments_.reasoning_effort !== undefined &&
      !LUNA_REASONING_EFFORTS.includes(arguments_.reasoning_effort as (typeof LUNA_REASONING_EFFORTS)[number])
    ) {
      throw new Error(
        `Luna subagent reasoning effort is not allowed: ${String(arguments_.reasoning_effort)}`,
      );
    }
  }
}

export function prepareLunaRequest(
  body: Record<string, unknown>,
  syntheticRootChild: boolean,
): Record<string, unknown> {
  if (!syntheticRootChild) return body;

  const prepared = structuredClone(body);
  if (!Array.isArray(prepared.input)) return prepared;
  for (const item of prepared.input) {
    if (!isRecord(item) || item.type !== "agent_message" || !Array.isArray(item.content)) continue;
    item.content = item.content.map(content => {
      if (
        isRecord(content) &&
        content.type === "encrypted_content" &&
        typeof content.encrypted_content === "string"
      ) {
        return { type: "input_text", text: content.encrypted_content };
      }
      return content;
    });
  }
  return prepared;
}

function validateLunaRequest(body: Record<string, unknown>): void {
  if (body.model !== LUNA_MODEL) throw new Error(`Unsupported child model: ${String(body.model)}`);
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const effort = reasoning?.effort;
  if (!LUNA_REASONING_EFFORTS.includes(effort as (typeof LUNA_REASONING_EFFORTS)[number])) {
    throw new Error(`Luna subagent reasoning effort is not allowed: ${String(effort)}`);
  }
}

function forwardingHeaders(headers: IncomingHttpHeaders): Headers {
  const forwarded = new Headers();
  const blocked = new Set(["connection", "content-length", "host", "transfer-encoding"]);
  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) forwarded.append(name, item);
    } else {
      forwarded.set(name, value);
    }
  }
  forwarded.set("content-type", "application/json");
  return forwarded;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  // fetch() transparently decodes compressed response bodies, so forwarding
  // the original content-encoding would make Codex try to decode plain text.
  const blocked = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);
  headers.forEach((value, name) => {
    if (!blocked.has(name.toLowerCase())) forwarded[name] = value;
  });
  return forwarded;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isEventStream(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/event-stream") ?? false;
}

function lunaUpstreamSummary(response: Response, body: string): Record<string, unknown> {
  const eventTypes: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const data = rawLine.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed) && typeof parsed.type === "string") eventTypes.push(parsed.type);
    } catch {
      // Keep debug output metadata-only even when an upstream data line is malformed.
    }
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentEncoding: response.headers.get("content-encoding"),
    bodyBytes: Buffer.byteLength(body),
    eventTypes,
  };
}
