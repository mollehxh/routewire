import type { IncomingMessage, ServerResponse } from "node:http";

import type { CodexTurnBridge } from "../bridge.js";
import type { ExecToolSpec } from "../provider/protocol.js";
import { cleanCodeModeResult, isRecord } from "../provider/protocol.js";
import { SIDEBAND_EXEC_GUIDANCE, wrapExecCode } from "../tool-policy.js";
import {
  bootstrapToolJsonSchema,
  invokeBootstrap,
  SIDEBAND_BOOTSTRAP_TOOL,
} from "./bootstrap.js";
import { SIDEBAND_MCP_INSTRUCTIONS } from "./instructions.js";
import {
  invokeProjectedNativeTool,
  projectedToolJsonSchema,
  type ProjectedNativeTool,
} from "./projected-tools.js";
import {
  invokeSidebandSkillTool,
  SIDEBAND_SKILL_TOOL_DEFINITIONS,
  skillToolJsonSchema,
  type NativeSkillTools,
} from "./skill-tools.js";

export const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";

export interface ModernMcpContext {
  bridge: CodexTurnBridge;
  execSpec: ExecToolSpec;
  projectedTools?: ProjectedNativeTool[];
  nativeSkillTools?: NativeSkillTools;
}

export async function handleModernMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: ModernMcpContext,
): Promise<boolean> {
  const requestedVersion = header(req, "mcp-protocol-version");
  if (requestedVersion !== MODERN_MCP_PROTOCOL_VERSION) return false;

  if (req.method !== "POST") {
    sendJson(res, 405, rpcError(null, -32600, "MCP 2026-07-28 uses POST requests"));
    return true;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, rpcError(null, -32700, `Parse error: ${errorMessage(error)}`));
    return true;
  }

  if (!isRecord(body) || body.jsonrpc !== "2.0" || !("id" in body) || typeof body.method !== "string") {
    sendJson(res, 400, rpcError(null, -32600, "Invalid JSON-RPC request"));
    return true;
  }

  const id = body.id as string | number | null;
  const params = isRecord(body.params) ? body.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const bodyVersion = meta["io.modelcontextprotocol/protocolVersion"];
  const headerMethod = header(req, "mcp-method");

  if (bodyVersion !== MODERN_MCP_PROTOCOL_VERSION) {
    sendJson(
      res,
      400,
      rpcError(id, -32020, "Header mismatch: MCP-Protocol-Version does not match request _meta"),
    );
    return true;
  }

  if (headerMethod !== body.method) {
    sendJson(
      res,
      400,
      rpcError(id, -32020, "Header mismatch: Mcp-Method does not match request method"),
    );
    return true;
  }

  if (body.method === "server/discover") {
    sendJson(res, 200, rpcResult(id, {
      resultType: "complete",
      supportedVersions: [MODERN_MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: SIDEBAND_MCP_INSTRUCTIONS,
      ttlMs: 0,
      cacheScope: "private",
      _meta: serverMeta(),
    }));
    return true;
  }

  if (body.method === "tools/list") {
    sendJson(res, 200, rpcResult(id, {
      resultType: "complete",
      tools: [
        modernBootstrapTool(),
        ...(context.projectedTools ?? []).map(modernProjectedTool),
        ...(context.nativeSkillTools ? SIDEBAND_SKILL_TOOL_DEFINITIONS.map(modernSkillTool) : []),
        modernExecTool(context.execSpec),
      ],
      ttlMs: 0,
      cacheScope: "private",
      _meta: serverMeta(),
    }));
    return true;
  }

  if (body.method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : undefined;
    const headerName = header(req, "mcp-name");
    if (!name || headerName !== name) {
      sendJson(
        res,
        400,
        rpcError(id, -32020, "Header mismatch: Mcp-Name does not match params.name"),
      );
      return true;
    }
    const args = isRecord(params.arguments) ? params.arguments : {};

    try {
      const projected = (context.projectedTools ?? []).find(tool => tool.name === name);
      const skillDefinition = context.nativeSkillTools
        ? SIDEBAND_SKILL_TOOL_DEFINITIONS.find(tool => tool.name === name)
        : undefined;
      let result;
      if (name === SIDEBAND_BOOTSTRAP_TOOL.name) {
        result = await invokeBootstrap(context.bridge, context.nativeSkillTools);
      } else if (projected) {
        result = await invokeProjectedNativeTool(context.bridge, projected, args);
      } else if (skillDefinition && context.nativeSkillTools) {
        result = await invokeSidebandSkillTool(
          context.bridge,
          context.nativeSkillTools,
          skillDefinition.name,
          args,
        );
      } else if (name === "exec") {
        if (typeof args.code !== "string" || args.code.length === 0) {
          sendJson(res, 200, rpcError(id, -32602, "exec requires a non-empty string argument: code"));
          return true;
        }
        result = cleanCodeModeResult(await context.bridge.invokeExec(wrapExecCode(args.code)));
      } else {
        sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${name}`));
        return true;
      }
      sendJson(res, 200, rpcResult(id, {
        resultType: "complete",
        content: result.content,
        isError: result.isError,
        _meta: serverMeta(),
      }));
    } catch (error) {
      sendJson(res, 200, rpcResult(id, {
        resultType: "complete",
        content: [{ type: "text", text: errorMessage(error) }],
        isError: true,
        _meta: serverMeta(),
      }));
    }
    return true;
  }

  sendJson(res, 404, rpcError(id, -32601, `Method not found: ${body.method}`));
  return true;
}

function modernBootstrapTool(): Record<string, unknown> {
  return {
    name: SIDEBAND_BOOTSTRAP_TOOL.name,
    title: SIDEBAND_BOOTSTRAP_TOOL.title,
    description: SIDEBAND_BOOTSTRAP_TOOL.description,
    inputSchema: bootstrapToolJsonSchema(),
  };
}

function modernSkillTool(
  definition: (typeof SIDEBAND_SKILL_TOOL_DEFINITIONS)[number],
): Record<string, unknown> {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: skillToolJsonSchema(definition),
  };
}

function modernProjectedTool(tool: ProjectedNativeTool): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: projectedToolJsonSchema(tool),
  };
}

function modernExecTool(execSpec: ExecToolSpec): Record<string, unknown> {
  return {
    name: "exec",
    title: "Codex exec",
    description: `${execSpec.description}\n\n${SIDEBAND_EXEC_GUIDANCE}`,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          minLength: 1,
          description: `Raw JavaScript source for Codex functions.exec. Do not wrap it in JSON or markdown fences. ${SIDEBAND_EXEC_GUIDANCE}`,
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  };
}

function serverMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/serverInfo": {
      name: "sideband",
      version: "0.0.0",
    },
  };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
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
    "cache-control": "no-store",
  });
  res.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
