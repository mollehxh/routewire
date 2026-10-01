import { z, type ZodType } from "zod";

import type { CodexTurnBridge } from "../bridge.js";
import type { BridgeCallResult } from "../provider/protocol.js";
import {
  loadNativeSkillCatalog,
  type CodexSkillSummary,
  type NativeSkillTools,
} from "./skill-tools.js";

export interface BootstrapToolDefinition {
  name: "bootstrap";
  title: string;
  description: string;
  inputSchema: ZodType;
}

const bootstrapInputSchema = z.object({});

export const SIDEBAND_BOOTSTRAP_TOOL: BootstrapToolDefinition = {
  name: "bootstrap",
  title: "Load Codex context",
  description:
    "Load the current safe model-facing Codex runtime/project context before ordinary substantive work. Returns model, environment, permissions, applicable AGENTS.md instructions, and the current native Codex skill catalog. It intentionally excludes hidden base/developer prompts, app/plugin instruction blocks, and session identifiers.",
  inputSchema: bootstrapInputSchema,
};

export async function invokeBootstrap(
  bridge: CodexTurnBridge,
  nativeSkillTools?: NativeSkillTools,
): Promise<BridgeCallResult> {
  const context = bridge.operationalContext();
  let skills: CodexSkillSummary[] = [];
  let skillsAvailable = false;

  if (nativeSkillTools) {
    skills = await loadNativeSkillCatalog(bridge, nativeSkillTools);
    skillsAvailable = true;
  }

  const payload = {
    model: context.model,
    environment: context.environment
      ? {
          cwd: context.environment.cwd,
          shell: context.environment.shell,
          current_date: context.environment.currentDate,
          timezone: context.environment.timezone,
          workspace_roots: context.environment.workspaceRoots,
          permission_profile: context.environment.permissionProfile,
          file_system: context.environment.fileSystem,
        }
      : null,
    permissions: context.permissions ?? null,
    project_instructions: context.projectInstructions.map(instruction => ({
      scope: instruction.scope,
      content: instruction.content,
    })),
    skills_available: skillsAvailable,
    skills,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

export function bootstrapToolJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(bootstrapInputSchema) as Record<string, unknown>;
  const { $schema: _schema, ...withoutDialect } = schema;
  return withoutDialect;
}
