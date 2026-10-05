import { McpServer, type CallToolResult, type Tool, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CodexBridgeEvent, CodexTurnBridge } from "../bridge.js";
import { ROUTEWIRE_NAME, ROUTEWIRE_VERSION } from "../meta.js";
import { type ExecToolSpec } from "../provider/protocol.js";
import {
  wrapExecCode,
} from "../tool-policy.js";
import {execToolDefinition} from "./exec-tool.js";
import {invokeExecAndWait} from "./code-mode.js";
import { invokeBootstrap, ROUTEWIRE_BOOTSTRAP_TOOL } from "./bootstrap.js";
import {
  invokeCollaborationTool,
  type CollaborationTool,
} from "./collaboration-tools.js";
import { ROUTEWIRE_MCP_INSTRUCTIONS } from "./instructions.js";
import {
  invokeProjectedNativeTool,
  projectedToolsFingerprint,
  type ProjectedNativeTool,
} from "./projected-tools.js";
import {
  invokeRoutewireSkillTool,
  ROUTEWIRE_SKILL_TOOL_DEFINITIONS,
  type NativeSkillTools,
} from "./skill-tools.js";

export interface CreateRoutewireMcpServerOptions {
  bridge: CodexTurnBridge;
  execSpec: ExecToolSpec;
  projectedTools?: ProjectedNativeTool[];
  nativeSkillTools?: NativeSkillTools;
  collaborationTools?: CollaborationTool[];
  onEvent?: (event: CodexBridgeEvent) => void;
  refreshProjectedTools?: () => Promise<ProjectedNativeTool[]>;
}

export function createRoutewireMcpServer(options: CreateRoutewireMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: ROUTEWIRE_NAME, version: ROUTEWIRE_VERSION },
    { instructions: ROUTEWIRE_MCP_INSTRUCTIONS },
  );

  server.registerTool(
    ROUTEWIRE_BOOTSTRAP_TOOL.name,
    {
      title: ROUTEWIRE_BOOTSTRAP_TOOL.title,
      description: ROUTEWIRE_BOOTSTRAP_TOOL.description,
      inputSchema: ROUTEWIRE_BOOTSTRAP_TOOL.inputSchema,
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

  const projected = new Map<string, ReturnType<McpServer["registerTool"]>>();
  let projectedSnapshot = "";
  const updateProjected = (tools: ProjectedNativeTool[]) => {
    const snapshot = projectedToolsFingerprint(tools);
    if (snapshot === projectedSnapshot) return;
    projectedSnapshot = snapshot;
    for (const [name, registration] of projected) {
      if (!tools.some(tool => tool.name === name)) {
        registration.remove();
        projected.delete(name);
      }
    }
    for (const tool of tools) {
      const handler = async (arguments_: unknown, context: ServerContext): Promise<CallToolResult> => {
        const result = await invokeProjectedNativeTool(options.bridge, tool, arguments_, {signal: context.mcpReq.signal});
        return {content: result.content, isError: result.isError};
      };
      const registration = projected.get(tool.name);
      if (registration) registration.update({description:tool.description,paramsSchema:tool.inputSchema,callback:handler});
      else projected.set(tool.name, server.registerTool(tool.name, {
        title: tool.title, description:tool.description,inputSchema:tool.inputSchema,
      },handler));
    }
    options.projectedTools = tools;
  };
  projectedUpdaters.set(server, updateProjected);
  updateProjected(options.projectedTools ?? []);

  for (const tool of options.collaborationTools ?? []) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (arguments_: unknown, context): Promise<CallToolResult> => {
        try {
          const result = await invokeCollaborationTool(options.bridge, tool, arguments_, {signal: context.mcpReq.signal});
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
    for (const definition of ROUTEWIRE_SKILL_TOOL_DEFINITIONS) {
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
        async (arguments_: unknown): Promise<CallToolResult> => {
          try {
            const result = await invokeRoutewireSkillTool(
              options.bridge,
              options.nativeSkillTools!,
              definition.name,
              arguments_,
              { onEvent: options.onEvent },
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
    execToolDefinition(options.execSpec),
    async ({ code }, context): Promise<CallToolResult> => {
      const result = await invokeExecAndWait(options.bridge, wrapExecCode(code), {signal: context.mcpReq.signal});
      return {
        content: result.content,
        isError: result.isError,
      };
    },
  );

  if (options.refreshProjectedTools) {
    server.server.setRequestHandler("tools/list", async () => {
      updateProjected(await options.refreshProjectedTools!());
      return {tools: listRoutewireTools(options)};
    });
  }
  return server;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const projectedUpdaters = new WeakMap<McpServer, (tools: ProjectedNativeTool[]) => void>();
export function updateRoutewireProjectedTools(server: McpServer, tools: ProjectedNativeTool[]): void {
  projectedUpdaters.get(server)?.(tools);
}

function listRoutewireTools(options: CreateRoutewireMcpServerOptions): Tool[] {
  const definitions = [
    ROUTEWIRE_BOOTSTRAP_TOOL,
    ...(options.projectedTools ?? []),
    ...(options.collaborationTools ?? []),
    ...(options.nativeSkillTools ? ROUTEWIRE_SKILL_TOOL_DEFINITIONS : []),
    execToolDefinition(options.execSpec),
  ];
  return definitions.map(({name,title,description,inputSchema}) => ({
    name,title,description,inputSchema:z.toJSONSchema(inputSchema) as Tool["inputSchema"],
  }));
}
