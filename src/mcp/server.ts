import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CodexTurnBridge } from "../bridge.js";
import type { ExecToolSpec } from "../provider/protocol.js";
import { SIDEBAND_EXEC_GUIDANCE, wrapExecCode } from "../tool-policy.js";
import {
  invokeProjectedNativeTool,
  type ProjectedNativeTool,
} from "./projected-tools.js";

export interface CreateSidebandMcpServerOptions {
  bridge: CodexTurnBridge;
  execSpec: ExecToolSpec;
  projectedTools?: ProjectedNativeTool[];
}

export function createSidebandMcpServer(options: CreateSidebandMcpServerOptions): McpServer {
  const server = new McpServer({ name: "sideband", version: "0.0.0" });

  for (const tool of options.projectedTools ?? []) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (arguments_: unknown): Promise<CallToolResult> => {
        const result = await invokeProjectedNativeTool(options.bridge, tool, arguments_);
        return {
          content: result.content,
          isError: result.isError,
        };
      },
    );
  }

  server.registerTool(
    "exec",
    {
      title: "Codex exec",
      description: `${options.execSpec.description}\n\n${SIDEBAND_EXEC_GUIDANCE}`,
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .describe(
            `Raw JavaScript source for Codex functions.exec. Do not wrap it in JSON or markdown fences. ${SIDEBAND_EXEC_GUIDANCE}`,
          ),
      }),
    },
    async ({ code }): Promise<CallToolResult> => {
      const result = await options.bridge.invokeExec(wrapExecCode(code));
      return {
        content: result.content,
        isError: result.isError,
      };
    },
  );

  return server;
}
