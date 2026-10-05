import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { runwireEnvFlag } from "../env.js";
import {
  isReasoningEffort,
  SUBAGENT_REASONING_EFFORTS,
  type ReasoningEffort,
} from "../model-catalog.js";
import { isRecord } from "./protocol.js";

export const LUNA_MODEL = "gpt-6-luna";
export const LUNA_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CHILD_REASONING_EFFORTS = SUBAGENT_REASONING_EFFORTS;

const DEFAULT_CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface LunaProxyOptions {
  fetchImpl?: typeof fetch;
  chatgptResponsesUrl?: string;
  syntheticRootChild?: boolean;
  allowedModels?: readonly string[];
  modelEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>;
}

export function isLunaRequest(body: unknown): body is Record<string, unknown> {
  return isRecord(body) && body.model === LUNA_MODEL;
}

export function isAllowedChildRequest(
  body: unknown,
  allowedModels: readonly string[],
): body is Record<string, unknown> {
  return isRecord(body) && typeof body.model === "string" && allowedModels.includes(body.model);
}

export async function proxyLunaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  options: LunaProxyOptions = {},
): Promise<void> {
  return proxyChildRequest(req, res, body, {
    ...options,
    allowedModels: options.allowedModels ?? [LUNA_MODEL],
  });
}

export async function proxyChildRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  options: LunaProxyOptions = {},
): Promise<void> {
  const allowedModels = options.allowedModels ?? [LUNA_MODEL];
  validateChildRequest(body, allowedModels, options.modelEfforts);
  const authorization = singleHeader(req.headers.authorization);
  if (!authorization) throw new Error("Subagents require Codex authentication");
  if (!singleHeader(req.headers["chatgpt-account-id"])) {
    throw new Error("Subagents require ChatGPT Codex authentication; API-key billing is not supported");
  }

  const target = options.chatgptResponsesUrl ?? DEFAULT_CHATGPT_RESPONSES_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const upstream = await fetchImpl(target, {
    method: "POST",
    headers: forwardingHeaders(req.headers),
    body: JSON.stringify(prepareLunaRequest(body, options.syntheticRootChild === true)),
    redirect: "manual",
  });

  const responseBody = await upstream.text();
  if (runwireEnvFlag("RUNWIRE_DEBUG", "SIDEBAND_DEBUG")) {
    process.stderr.write(
      `[runwire] child upstream: ${JSON.stringify(lunaUpstreamSummary(upstream, responseBody))}\n`,
    );
  }
  if (upstream.ok && (isEventStream(upstream.headers.get("content-type")) || responseBody.includes("data:"))) {
    validateChildResponse(responseBody, allowedModels, options.modelEfforts);
  }

  const headers = responseHeaders(upstream.headers);
  res.writeHead(upstream.status, headers);
  res.end(responseBody);
}

export function validateLunaResponse(sse: string): void {
  validateChildResponse(sse, [LUNA_MODEL]);
}

export function validateChildResponse(
  sse: string,
  allowedModels: readonly string[],
  modelEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>,
): void {
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
    if (!isRecord(event)) continue;
    const items = event.type === "response.output_item.done"
      ? [event.item]
      : event.type === "response.completed" && isRecord(event.response) && Array.isArray(event.response.output)
        ? event.response.output
        : [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (
        item.type !== "function_call" ||
        item.name !== "spawn_agent" ||
        (item.namespace !== undefined && item.namespace !== "collaboration")
      ) continue;

      const rawArguments = typeof item.arguments === "string" ? item.arguments : "{}";
      let arguments_: unknown;
      try {
        arguments_ = JSON.parse(rawArguments);
      } catch {
        throw new Error("Subagent spawn_agent returned invalid JSON arguments");
      }
      if (!isRecord(arguments_)) throw new Error("Subagent spawn_agent arguments must be an object");
      if (
        arguments_.model !== undefined &&
        (typeof arguments_.model !== "string" || !allowedModels.includes(arguments_.model))
      ) {
        throw new Error(`Subagent cannot spawn model ${String(arguments_.model)}`);
      }
      if (arguments_.reasoning_effort !== undefined) {
        const model = typeof arguments_.model === "string" ? arguments_.model : undefined;
        const effort = arguments_.reasoning_effort;
        if (!isReasoningEffort(effort)) {
          throw new Error(`Subagent reasoning effort is not allowed: ${String(effort)}`);
        }
        if (model && modelEfforts?.[model] && !modelEfforts[model].includes(effort)) {
          throw new Error(`Subagent reasoning effort ${effort} is not supported by ${model}`);
        }
      }
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

function validateChildRequest(
  body: Record<string, unknown>,
  allowedModels: readonly string[],
  modelEfforts?: Readonly<Record<string, readonly ReasoningEffort[]>>,
): void {
  if (typeof body.model !== "string" || !allowedModels.includes(body.model)) {
    throw new Error(`Unsupported child model: ${String(body.model)}`);
  }
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined;
  const effort = reasoning?.effort;
  if (!isReasoningEffort(effort)) {
    throw new Error(`Subagent reasoning effort is not allowed: ${String(effort)}`);
  }
  const supported = modelEfforts?.[body.model];
  if (supported && !supported.includes(effort)) {
    throw new Error(`Subagent reasoning effort ${effort} is not supported by ${body.model}`);
  }
}

function forwardingHeaders(headers: IncomingHttpHeaders): Headers {
  const forwarded = new Headers();
  const blocked = new Set(["connection", "content-length", "host", "transfer-encoding"]);
  for (const [name, value] of Object.entries(headers)) {
    if (blocked.has(name.toLowerCase()) || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) forwarded.append(name, item);
    else forwarded.set(name, value);
  }
  forwarded.set("content-type", "application/json");
  return forwarded;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
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
      // Metadata-only diagnostics.
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
