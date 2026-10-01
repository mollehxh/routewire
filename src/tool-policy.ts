export interface ToolMetadata {
  name: string;
  description?: string;
}

const MODEL_TOOL_NAME_PATTERN =
  /collaboration__|spawn_agent|spawn_session|run_model|subagent_(?:complete|message)/i;

const MODEL_TOOL_DESCRIPTION_PATTERN =
  /\b(?:spawn (?:an? )?agent|start (?:an? )?agent session|run (?:an? )?model|continue (?:an? )?agent session)\b/i;

const TEST_HARNESS_TOOL_NAME_PATTERN = /(?:^|__)codex_apps__test_harnes[^_]*_/i;

export const SIDEBAND_EXEC_GUIDANCE = [
  "Sideband runs one real Codex turn and exposes its native Code Mode tools.",
  "Prefer a directly exposed Sideband native tool for a single operation.",
  "Use exec when multiple native calls, batching, persistent JavaScript values, control flow, or an unprojected native Codex tool make Code Mode useful.",
  "Inside exec, native Codex tools are available through tools and described by ALL_TOOLS.",
  "Sideband blocks nested tools that start or continue independent model/agent sessions and test-harness duplicates.",
].join(" ");

export function isModelSpawningTool(tool: ToolMetadata): boolean {
  return (
    MODEL_TOOL_NAME_PATTERN.test(tool.name) ||
    MODEL_TOOL_DESCRIPTION_PATTERN.test(tool.description ?? "")
  );
}

export function isSidebandBlockedTool(tool: ToolMetadata): boolean {
  return isModelSpawningTool(tool) || TEST_HARNESS_TOOL_NAME_PATTERN.test(tool.name);
}

export function wrapExecCode(code: string): string {
  const namePattern = JSON.stringify(MODEL_TOOL_NAME_PATTERN.source);
  const descriptionPattern = JSON.stringify(MODEL_TOOL_DESCRIPTION_PATTERN.source);
  const testHarnessPattern = JSON.stringify(TEST_HARNESS_TOOL_NAME_PATTERN.source);

  return `{
  const __sidebandNamePattern = new RegExp(${namePattern}, "i");
  const __sidebandDescriptionPattern = new RegExp(${descriptionPattern}, "i");
  const __sidebandTestHarnessPattern = new RegExp(${testHarnessPattern}, "i");
  const __sidebandOriginalTools = globalThis.tools;
  const __sidebandOriginalInventory = Array.isArray(globalThis.ALL_TOOLS)
    ? globalThis.ALL_TOOLS
    : [];
  const __sidebandBlockedNames = new Set(
    __sidebandOriginalInventory
      .filter(tool => {
        const name = String(tool?.name ?? "");
        const description = String(tool?.description ?? "");
        return __sidebandNamePattern.test(name) ||
          __sidebandDescriptionPattern.test(description) ||
          __sidebandTestHarnessPattern.test(name);
      })
      .map(tool => String(tool.name)),
  );
  const __sidebandFilteredTools = Object.create(null);
  for (const tool of __sidebandOriginalInventory) {
    const name = String(tool?.name ?? "");
    if (!name || __sidebandBlockedNames.has(name)) continue;
    const callable = __sidebandOriginalTools[name];
    if (typeof callable === "function") {
      Object.defineProperty(__sidebandFilteredTools, name, {
        value: callable.bind(__sidebandOriginalTools),
        enumerable: true,
      });
    }
  }
  globalThis.ALL_TOOLS = __sidebandOriginalInventory.filter(
    tool => !__sidebandBlockedNames.has(String(tool?.name ?? "")),
  );
  globalThis.tools = new Proxy(__sidebandFilteredTools, {
    get(target, property, receiver) {
      const name = String(property);
      if (__sidebandTestHarnessPattern.test(name)) {
        throw new Error("Sideband blocked test-harness tool: " + name);
      }
      if (__sidebandBlockedNames.has(name) || __sidebandNamePattern.test(name)) {
        throw new Error("Sideband blocked model-spawning tool: " + name);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
${code}`;
}
