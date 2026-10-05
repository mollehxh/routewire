import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export const SUBAGENT_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export interface CodexModelCatalogEntry {
  id: string;
  displayName: string;
  description?: string;
  efforts: readonly ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  multiAgentEffort?: ReasoningEffort;
  fastMode: boolean;
}

const FALLBACK_MODELS: readonly CodexModelCatalogEntry[] = [
  {
    id: "gpt-6-luna",
    displayName: "GPT-6-Luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    multiAgentEffort: "high",
    fastMode: true,
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    multiAgentEffort: "high",
    fastMode: true,
  },
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
    multiAgentEffort: "high",
    fastMode: true,
  },
];

export function loadCodexModelCatalog(codexHome?: string): CodexModelCatalogEntry[] {
  const home = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const file = path.join(home, "models_cache.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const models = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
    const catalog = models.flatMap(parseCatalogEntry);
    return catalog.length > 0 ? catalog : FALLBACK_MODELS.map(entry => ({...entry, efforts: [...entry.efforts]}));
  } catch {
    return FALLBACK_MODELS.map(entry => ({...entry, efforts: [...entry.efforts]}));
  }
}

export function catalogEntry(
  catalog: readonly CodexModelCatalogEntry[],
  model: string,
): CodexModelCatalogEntry | undefined {
  return catalog.find(entry => entry.id === model);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra"
  );
}

function parseCatalogEntry(value: unknown): CodexModelCatalogEntry[] {
  if (!isRecord(value) || value.visibility !== "list" || typeof value.slug !== "string") return [];
  const efforts = Array.isArray(value.supported_reasoning_levels)
    ? value.supported_reasoning_levels.flatMap(item => {
        if (!isRecord(item) || !isReasoningEffort(item.effort)) return [];
        return [item.effort];
      })
    : [];

  const defaultEffort = isReasoningEffort(value.default_reasoning_level) && efforts.includes(value.default_reasoning_level)
    ? value.default_reasoning_level
    : efforts[0] ?? "high";
  const multiAgentEffort = isReasoningEffort(value.multi_agent_reasoning_effort) && efforts.includes(value.multi_agent_reasoning_effort)
    ? value.multi_agent_reasoning_effort
    : undefined;
  const additionalSpeedTiers = Array.isArray(value.additional_speed_tiers)
    ? value.additional_speed_tiers
    : [];

  return [{
    id: value.slug,
    displayName: typeof value.display_name === "string" ? value.display_name : value.slug,
    description: typeof value.description === "string" ? value.description : undefined,
    efforts,
    defaultEffort,
    multiAgentEffort,
    fastMode: additionalSpeedTiers.includes("fast"),
  }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
