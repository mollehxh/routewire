import {invokeQueuedFunction} from "./bridge-scheduler.js";
import { z, type ZodType } from "zod";

import type { BridgeCallOptions, CodexTurnBridge } from "../bridge.js";
import {
  catalogEntry,
  isReasoningEffort,
  loadCodexModelCatalog,
  type CodexModelCatalogEntry,
} from "../model-catalog.js";
import type { BridgeCallResult, FunctionToolSpec } from "../provider/protocol.js";

export interface CollaborationTool {
  name: string;
  title: string;
  nativeName: string;
  description: string;
  inputSchema: ZodType;
  mapArguments(arguments_: unknown): Record<string, unknown>;
}

export interface CollaborationPolicy {
  allowedModels: readonly string[];
  catalog: readonly CodexModelCatalogEntry[];
}

const taskName = z.string().min(1).regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits, and underscores only");
const target = z.string().min(1);
const message = z.string().min(1);
const forkTurns = z.string().regex(/^(?:none|[1-9]\d*)$/, 'Use "none" or a positive integer such as "3"').optional();
const reasoningEffort = z.string().optional().refine(
  value => value === undefined || isReasoningEffort(value),
  "Unsupported reasoning effort",
);

const titles: Record<string, string> = {
  followup_task: "Follow up with Codex agent",
  interrupt_agent: "Interrupt Codex agent",
  list_agents: "List Codex agents",
  send_message: "Message Codex agent",
  spawn_agent: "Spawn Codex agent",
  wait_agent: "Wait for Codex agent",
};

export function selectCollaborationTools(
  specs: FunctionToolSpec[],
  policy: CollaborationPolicy = defaultPolicy(),
): CollaborationTool[] {
  return specs.flatMap(spec => {
    const title = titles[spec.name];
    if (!title) return [];
    if (spec.name === "spawn_agent" && policy.allowedModels.length === 0) return [];

    const schema = schemaFor(spec.name, policy);
    if (!schema) return [];
    return [{
      name: spec.name,
      title,
      nativeName: spec.name,
      description: spec.name === "spawn_agent" ? spawnDescription(spec.description, policy) : spec.description,
      inputSchema: schema,
      mapArguments: arguments_ => mapArguments(spec.name, schema.parse(arguments_), policy),
    }];
  });
}

export async function invokeCollaborationTool(
  bridge: CodexTurnBridge,
  tool: CollaborationTool,
  arguments_: unknown,
  options: BridgeCallOptions = {},
): Promise<BridgeCallResult> {
  return invokeQueuedFunction(
    bridge,
    "collaboration",
    tool.nativeName,
    tool.mapArguments(arguments_),
    options,
  );
}

export function collaborationToolJsonSchema(tool: CollaborationTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  const { $schema: _schema, ...withoutDialect } = schema;
  return withoutDialect;
}

function schemaFor(name: string, policy: CollaborationPolicy): ZodType | undefined {
  if (name === "followup_task") return z.object({ target, message });
  if (name === "interrupt_agent") return z.object({ target });
  if (name === "list_agents") return z.object({ path_prefix: z.string().min(1).optional() });
  if (name === "send_message") return z.object({ target, message });
  if (name === "wait_agent") return z.object({ timeout_ms: z.number().int().min(10_000).max(3_600_000).optional() });
  if (name === "spawn_agent") {
    return z.object({
      task_name: taskName,
      message,
      fork_turns: forkTurns,
      reasoning_effort: reasoningEffort,
      model: z.string().refine(
        value => policy.allowedModels.includes(value),
        "Model is blocked by Routewire subagent policy",
      ),
    });
  }
  return undefined;
}

function mapArguments(
  name: string,
  parsed: unknown,
  policy: CollaborationPolicy,
): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid collaboration arguments for ${name}`);
  }
  const arguments_ = { ...(parsed as Record<string, unknown>) };
  if (name !== "spawn_agent") return arguments_;
  const model = arguments_.model;
  if (typeof model !== "string" || !policy.allowedModels.includes(model)) {
    throw new Error("spawn_agent must select a model from the Routewire allowlist");
  }
  const modelSpec = catalogEntry(policy.catalog, model);
  if (!modelSpec) throw new Error(`Routewire has no model metadata for ${model}`);
  const effort = arguments_.reasoning_effort;
  if (effort !== undefined && (!isReasoningEffort(effort) || !modelSpec.efforts.includes(effort))) {
    throw new Error(`Reasoning effort ${String(effort)} is not supported by ${model}`);
  }
  return {
    ...arguments_,
    model,
    fork_turns: arguments_.fork_turns ?? "none",
  };
}

function spawnDescription(nativeDescription: string, policy: CollaborationPolicy): string {
  const behavior = nativeDescription.replace(/^\s*Available model overrides[\s\S]*?Spawns an agent/m, "Spawns an agent").trim();
  const models = policy.allowedModels.map(model => {
    const spec = catalogEntry(policy.catalog, model);
    return spec
      ? `- ${model}: ${spec.efforts.join(", ")}`
      : `- ${model}`;
  });
  return [
    `Allowed child models and reasoning efforts:\n${models.join("\n")}`,
    "Choose the model and reasoning effort for each spawned agent. Routewire does not impose defaults.",
    'fork_turns defaults to "none" and may be "none" or a positive recent-turn count.',
    behavior,
  ].join("\n\n");
}

function defaultPolicy(): CollaborationPolicy {
  const catalog = loadCodexModelCatalog();
  return {
    allowedModels: catalog.some(entry => entry.id === "gpt-6-luna") ? ["gpt-6-luna"] : catalog.slice(0, 1).map(entry => entry.id),
    catalog,
  };
}
