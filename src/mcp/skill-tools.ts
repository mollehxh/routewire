import { z, type ZodType } from "zod";

import type { CodexTurnBridge } from "../bridge.js";
import type { BridgeCallResult } from "../provider/protocol.js";
import { wrapExecCode } from "../tool-policy.js";

export interface NativeSkillTools {
  listName: string;
  getName: string;
}

export interface CodexSkillSummary {
  name: string;
  description: string;
}

export interface SidebandSkillToolDefinition {
  name: "skills" | "get_skill";
  title: string;
  description: string;
  inputSchema: ZodType;
}

const skillsInputSchema = z.object({
  force_reload: z
    .boolean()
    .optional()
    .describe(
      "Reload Codex's native skill catalog instead of using its current cache. Use only when skills or plugins may have changed.",
    ),
});

const getSkillInputSchema = z.object({
  names: z
    .array(z.string().min(1))
    .min(1)
    .max(32)
    .describe("Exact enabled skill names returned by the skills tool."),
});

export const SIDEBAND_SKILL_TOOL_DEFINITIONS: SidebandSkillToolDefinition[] = [
  {
    name: "skills",
    title: "Codex skills",
    description:
      "List the enabled Codex skills for the current workspace using Codex's native skill catalog. Returns only the exact skill names and descriptions. Use for $skills and skill discovery; call again with force_reload only when skills or plugins may have changed.",
    inputSchema: skillsInputSchema,
  },
  {
    name: "get_skill",
    title: "Read Codex skill",
    description:
      "Read the complete canonical SKILL.md instructions for one or more exact enabled skill names returned by skills. Use before applying a relevant skill. This delegates resolution and reading to Codex's native skill mechanism; it does not accept filesystem paths or infer skill names.",
    inputSchema: getSkillInputSchema,
  },
];

interface SkillInventoryItem {
  name: string;
}

const DISCOVERY_START = "__SIDEBAND_SKILL_TOOLS_START__";
const DISCOVERY_END = "__SIDEBAND_SKILL_TOOLS_END__";
const PAYLOAD_START = "__SIDEBAND_SKILL_PAYLOAD_START__";
const PAYLOAD_END = "__SIDEBAND_SKILL_PAYLOAD_END__";
const LIST_PAGE_SIZE = 40;
const SKILL_CONTENT_CHUNK_SIZE = 24_000;

export function selectNativeSkillTools(
  inventory: SkillInventoryItem[],
): NativeSkillTools | undefined {
  const names = inventory.map(tool => tool.name);
  const listName = names.find(name => name.endsWith("fkn_codex_codex_skills_list"));
  const getName = names.find(name => name.endsWith("fkn_codex_codex_skill_get"));
  return listName && getName ? { listName, getName } : undefined;
}

export async function discoverNativeSkillTools(
  bridge: CodexTurnBridge,
): Promise<NativeSkillTools | undefined> {
  const code = `
const __sidebandSkillTools = ALL_TOOLS
  .filter(tool => {
    const name = String(tool?.name ?? "");
    return name.endsWith("fkn_codex_codex_skills_list") || name.endsWith("fkn_codex_codex_skill_get");
  })
  .map(tool => ({ name: String(tool.name) }));
text(${JSON.stringify(DISCOVERY_START)} + JSON.stringify(__sidebandSkillTools) + ${JSON.stringify(DISCOVERY_END)});
`;
  const result = await bridge.invokeExec(wrapExecCode(code));
  const payload = extractMarkedJson(result, DISCOVERY_START, DISCOVERY_END);
  if (!Array.isArray(payload)) return undefined;
  const inventory = payload.flatMap(item => {
    if (typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string") {
      return [{ name: (item as { name: string }).name }];
    }
    return [];
  });
  return selectNativeSkillTools(inventory);
}

export async function invokeSidebandSkillTool(
  bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  name: "skills" | "get_skill",
  arguments_: unknown,
): Promise<BridgeCallResult> {
  return name === "skills"
    ? invokeSkills(bridge, nativeTools, skillsInputSchema.parse(arguments_))
    : invokeGetSkill(bridge, nativeTools, getSkillInputSchema.parse(arguments_));
}

async function invokeSkills(
  bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  args: z.infer<typeof skillsInputSchema>,
): Promise<BridgeCallResult> {
  const skills = await loadNativeSkillCatalog(bridge, nativeTools, args.force_reload === true);
  return textResult({ skills });
}

export async function loadNativeSkillCatalog(
  bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  forceReload = false,
): Promise<CodexSkillSummary[]> {
  const skills: CodexSkillSummary[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let first = true;

  while (offset < total) {
    const code = `
const __sidebandNative = await tools[${JSON.stringify(nativeTools.listName)}]({
  force_reload: ${first && forceReload ? "true" : "false"},
});
if (__sidebandNative?.isError === true) {
  const __sidebandMessage = (__sidebandNative.content ?? []).filter(x => x?.type === "text").map(x => x.text).join("\\n");
  throw new Error(__sidebandMessage || "Codex native skill catalog failed");
}
const __sidebandCatalog = __sidebandNative?.structuredContent ?? {};
const __sidebandSkills = Array.isArray(__sidebandCatalog.skills) ? __sidebandCatalog.skills : [];
const __sidebandPayload = {
  total: Number.isInteger(__sidebandCatalog.returned) ? __sidebandCatalog.returned : __sidebandSkills.length,
  skills: __sidebandSkills.slice(${offset}, ${offset + LIST_PAGE_SIZE}).map(skill => ({
    name: String(skill?.name ?? ""),
    description: String(skill?.description ?? ""),
  })),
};
text(${JSON.stringify(PAYLOAD_START)} + JSON.stringify(__sidebandPayload) + ${JSON.stringify(PAYLOAD_END)});
`;
    const result = await bridge.invokeExec(wrapExecCode(code));
    const payload = extractMarkedJson(result, PAYLOAD_START, PAYLOAD_END);
    if (!isRecord(payload) || !Array.isArray(payload.skills) || typeof payload.total !== "number") {
      throw new Error("Codex native skill catalog returned an invalid payload");
    }
    total = payload.total;
    for (const item of payload.skills) {
      if (
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.description === "string"
      ) {
        skills.push({ name: item.name, description: item.description });
      }
    }
    if (payload.skills.length === 0) break;
    offset += payload.skills.length;
    first = false;
  }

  return skills;
}

async function invokeGetSkill(
  bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  args: z.infer<typeof getSkillInputSchema>,
): Promise<BridgeCallResult> {
  const results: Array<{ name: string; content: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const skillName of [...new Set(args.names)]) {
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    let content = "";
    let failed = false;

    while (offset < total) {
      const code = `
const __sidebandNative = await tools[${JSON.stringify(nativeTools.getName)}]({ name: ${JSON.stringify(skillName)} });
if (__sidebandNative?.isError === true) {
  const __sidebandMessage = (__sidebandNative.content ?? []).filter(x => x?.type === "text").map(x => x.text).join("\\n");
  text(${JSON.stringify(PAYLOAD_START)} + JSON.stringify({ error: __sidebandMessage || "Codex native skill read failed" }) + ${JSON.stringify(PAYLOAD_END)});
} else {
  const __sidebandContent = String(__sidebandNative?.structuredContent?.content ?? "");
  text(${JSON.stringify(PAYLOAD_START)} + JSON.stringify({
    total: __sidebandContent.length,
    chunk: __sidebandContent.slice(${offset}, ${offset + SKILL_CONTENT_CHUNK_SIZE}),
  }) + ${JSON.stringify(PAYLOAD_END)});
}
`;
      const result = await bridge.invokeExec(wrapExecCode(code));
      const payload = extractMarkedJson(result, PAYLOAD_START, PAYLOAD_END);
      if (!isRecord(payload)) throw new Error("Codex native skill read returned an invalid payload");
      if (typeof payload.error === "string") {
        errors.push({ name: skillName, error: payload.error });
        failed = true;
        break;
      }
      if (typeof payload.total !== "number" || typeof payload.chunk !== "string") {
        throw new Error("Codex native skill read returned an invalid content payload");
      }
      total = payload.total;
      content += payload.chunk;
      if (payload.chunk.length === 0) break;
      offset += payload.chunk.length;
    }

    if (!failed) results.push({ name: skillName, content });
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify(errors.length > 0 ? { skills: results, errors } : { skills: results }),
    }],
    isError: errors.length > 0,
  };
}

function extractMarkedJson(
  result: BridgeCallResult,
  startMarker: string,
  endMarker: string,
): unknown {
  const text = result.content
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(
      result.isError ? `Codex skill tool failed: ${text}` : "Codex skill tool response marker was missing",
    );
  }
  return JSON.parse(text.slice(start + startMarker.length, end));
}

function textResult(value: unknown): BridgeCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function skillToolJsonSchema(
  definition: SidebandSkillToolDefinition,
): Record<string, unknown> {
  const schema = z.toJSONSchema(definition.inputSchema) as Record<string, unknown>;
  const { $schema: _schema, ...withoutDialect } = schema;
  return withoutDialect;
}
