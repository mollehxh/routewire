import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CodexTurnBridge } from "../bridge.js";
import type { ExecToolSpec } from "../provider/protocol.js";
import { SIDEBAND_EXEC_GUIDANCE, wrapExecCode } from "../tool-policy.js";

export interface CreateSidebandMcpServerOptions {
  bridge: CodexTurnBridge;
  execSpec: ExecToolSpec;
}

export function createSidebandMcpServer(options: CreateSidebandMcpServerOptions): McpServer {
  const server = new McpServer({ name: "sideband", version: "0.0.0" });

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
