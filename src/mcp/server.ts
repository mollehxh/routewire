import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CodexTurnBridge } from "../bridge.js";
import { cleanCodeModeResult, type ExecToolSpec } from "../provider/protocol.js";
import {
  compactExecDescription,
  SIDEBAND_EXEC_GUIDANCE,
  wrapExecCode,
} from "../tool-policy.js";
import { invokeBootstrap, SIDEBAND_BOOTSTRAP_TOOL } from "./bootstrap.js";
import {
  invokeCollaborationTool,
  type CollaborationTool,
} from "./collaboration-tools.js";
import { SIDEBAND_MCP_INSTRUCTIONS } from "./instructions.js";
import {
  invokeProjectedNativeTool,
  type ProjectedNativeTool,
} from "./projected-tools.js";
import {
  invokeSidebandSkillTool,
  SIDEBAND_SKILL_TOOL_DEFINITIONS,
  type NativeSkillTools,
} from "./skill-tools.js";

export interface CreateSidebandMcpServerOptions {
  bridge: CodexTurnBridge;
  execSpec: ExecToolSpec;
  projectedTools?: ProjectedNativeTool[];
  nativeSkillTools?: NativeSkillTools;
  collaborationTools?: CollaborationTool[];
}

export function createSidebandMcpServer(options: CreateSidebandMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "sideband", version: "0.0.0" },
    { instructions: SIDEBAND_MCP_INSTRUCTIONS },
  );

  server.registerTool(
    SIDEBAND_BOOTSTRAP_TOOL.name,
    {
      title: SIDEBAND_BOOTSTRAP_TOOL.title,
      description: SIDEBAND_BOOTSTRAP_TOOL.description,
      inputSchema: SIDEBAND_BOOTSTRAP_TOOL.inputSchema,
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await invokeBootstrap(options.bridge, options.nativeSkillTools);
        return { content: result.content, isError: result.isError };
      } catch (error) {
        return {
          content: [{ type: "text", text: errorMessage(error) }],
          isError: true,
        };
      }
    },
  );

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

  for (const tool of options.collaborationTools ?? []) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (arguments_: unknown): Promise<CallToolResult> => {
        try {
          const result = await invokeCollaborationTool(options.bridge, tool, arguments_);
          return { content: result.content, isError: result.isError };
        } catch (error) {
          return {
            content: [{ type: "text", text: errorMessage(error) }],
            isError: true,
          };
        }
      },
    );
  }

  if (options.nativeSkillTools) {
    for (const definition of SIDEBAND_SKILL_TOOL_DEFINITIONS) {
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
        async (arguments_: unknown): Promise<CallToolResult> => {
          try {
            const result = await invokeSidebandSkillTool(
              options.bridge,
              options.nativeSkillTools!,
              definition.name,
              arguments_,
            );
            return { content: result.content, isError: result.isError };
          } catch (error) {
            return {
              content: [{ type: "text", text: errorMessage(error) }],
              isError: true,
            };
          }
        },
      );
    }
  }

  server.registerTool(
    "exec",
    {
      title: "Codex exec",
      description: `${compactExecDescription(options.execSpec.description)}\n\n${SIDEBAND_EXEC_GUIDANCE}`,
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .describe(
            "Raw JavaScript source for Codex functions.exec. Do not wrap it in JSON or markdown fences.",
          ),
      }),
    },
    async ({ code }): Promise<CallToolResult> => {
      const result = cleanCodeModeResult(await options.bridge.invokeExec(wrapExecCode(code)));
      return {
        content: result.content,
        isError: result.isError,
      };
    },
  );

  return server;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
