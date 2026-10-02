import { z, type ZodType } from "zod";

import type { CodexTurnBridge } from "../bridge.js";
import type { BridgeCallResult, FunctionToolSpec } from "../provider/protocol.js";
import { LUNA_MODEL, LUNA_REASONING_EFFORTS } from "../provider/luna.js";

export interface CollaborationTool {
  name: string;
  title: string;
  nativeName: string;
  description: string;
  inputSchema: ZodType;
  mapArguments(arguments_: unknown): Record<string, unknown>;
}

const taskName = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits, and underscores only");
const target = z.string().min(1);
const message = z.string().min(1);
const forkTurns = z
  .string()
  .regex(/^(?:none|[1-9]\d*)$/, 'Use "none" or a positive integer such as "3"')
  .optional();
const reasoningEffort = z.enum(LUNA_REASONING_EFFORTS).optional();

const spawnAgentSchema = z.object({
  task_name: taskName,
  message,
  fork_turns: forkTurns,
  reasoning_effort: reasoningEffort,
});

const schemas: Record<string, ZodType> = {
  followup_task: z.object({ target, message }),
  interrupt_agent: z.object({ target }),
  list_agents: z.object({ path_prefix: z.string().min(1).optional() }),
  send_message: z.object({ target, message }),
  spawn_agent: spawnAgentSchema,
  wait_agent: z.object({ timeout_ms: z.number().int().min(10_000).max(3_600_000).optional() }),
};

const titles: Record<string, string> = {
  followup_task: "Follow up with Codex agent",
  interrupt_agent: "Interrupt Codex agent",
  list_agents: "List Codex agents",
  send_message: "Message Codex agent",
  spawn_agent: "Spawn Luna Codex agent",
  wait_agent: "Wait for Codex agent",
};

export function selectCollaborationTools(specs: FunctionToolSpec[]): CollaborationTool[] {
  return specs.flatMap(spec => {
    const schema = schemas[spec.name];
    const title = titles[spec.name];
    if (!schema || !title) return [];

    return [{
      name: spec.name,
      title,
      nativeName: spec.name,
      description:
        spec.name === "spawn_agent" ? lunaSpawnDescription(spec.description) : spec.description,
      inputSchema: schema,
      mapArguments: arguments_ => mapArguments(spec.name, schema.parse(arguments_)),
    }];
  });
}

export async function invokeCollaborationTool(
  bridge: CodexTurnBridge,
  tool: CollaborationTool,
  arguments_: unknown,
): Promise<BridgeCallResult> {
  return bridge.invokeFunction(
    "collaboration",
    tool.nativeName,
    tool.mapArguments(arguments_),
  );
}

export function collaborationToolJsonSchema(tool: CollaborationTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  const { $schema: _schema, ...withoutDialect } = schema;
  return withoutDialect;
}

function mapArguments(
  name: string,
  parsed: unknown,
): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid collaboration arguments for ${name}`);
  }
  const arguments_ = { ...(parsed as Record<string, unknown>) };
  if (name !== "spawn_agent") return arguments_;

  return {
    ...arguments_,
    model: LUNA_MODEL,
    reasoning_effort: arguments_.reasoning_effort ?? "high",
    fork_turns: arguments_.fork_turns ?? "none",
  };
}

function lunaSpawnDescription(nativeDescription: string): string {
  const behavior = nativeDescription.replace(
    /^\s*Available model overrides[\s\S]*?Spawns an agent/m,
    "Spawns an agent",
  ).trim();
  return [
    `Spawn a native Codex subagent. Sideband fixes the child model to ${LUNA_MODEL}; no other child model is available.`,
    "Reasoning effort may be high, xhigh, or max and defaults to high.",
    'Because the root model differs from Luna, fork_turns defaults to "none" and may be "none" or a positive recent-turn count; full-history "all" is not available for this root spawn.',
    behavior,
  ].join("\n\n");
}
