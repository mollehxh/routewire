export interface ToolMetadata {
  name: string;
  description?: string;
}

const MODEL_TOOL_NAME_PATTERN =
  /collaboration__|spawn_agent|spawn_session|run_model|subagent_(?:complete|message)/i;

const MODEL_TOOL_DESCRIPTION_PATTERN =
  /\b(?:spawn (?:an? )?agent|start (?:an? )?agent session|run (?:an? )?model|continue (?:an? )?agent session)\b/i;

const TEST_HARNESS_TOOL_NAME_PATTERN = /(?:^|__)codex_apps__test_harnes[^_]*_/i;

export const RUNWIRE_EXEC_GUIDANCE = [
  "This server runs one real Codex turn and exposes its native Code Mode tools.",
  "Prefer a directly exposed native tool for a single operation.",
  "Use exec when multiple native calls, batching, persistent JavaScript values, control flow, or an unprojected native Codex tool make Code Mode useful.",
  "Inside exec, native Codex tools are available through tools and described by ALL_TOOLS.",
  "Nested tools that start or continue independent model/agent sessions and test-harness duplicates are blocked.",
].join(" ");

export function compactExecDescription(description: string): string {
  const sharedTypesIndex = description.indexOf("\nShared MCP Types:");
  const nestedToolIndex = description.search(/\n### `[^`]+`\n/);
  const cutAt = [sharedTypesIndex, nestedToolIndex]
    .filter(index => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), description.length);
  return description.slice(0, cutAt).trimEnd();
}

export function isModelSpawningTool(tool: ToolMetadata): boolean {
  return (
    MODEL_TOOL_NAME_PATTERN.test(tool.name) ||
    MODEL_TOOL_DESCRIPTION_PATTERN.test(tool.description ?? "")
  );
}

export function isRunwireBlockedTool(tool: ToolMetadata): boolean {
  return isModelSpawningTool(tool) || TEST_HARNESS_TOOL_NAME_PATTERN.test(tool.name);
}

export function wrapExecCode(code: string): string {
  const pragmaMatch = code.match(/^([ \t]*\/\/ @exec:[^\r\n]*)\r?\n/);
  const pragma = pragmaMatch ? `${pragmaMatch[1]}\n` : "";
  if (pragmaMatch) code = code.slice(pragmaMatch[0].length);
  const namePattern = JSON.stringify(MODEL_TOOL_NAME_PATTERN.source);
  const descriptionPattern = JSON.stringify(MODEL_TOOL_DESCRIPTION_PATTERN.source);
  const testHarnessPattern = JSON.stringify(TEST_HARNESS_TOOL_NAME_PATTERN.source);

  return `${pragma}{
  const __runwireNamePattern = new RegExp(${namePattern}, "i");
  const __runwireDescriptionPattern = new RegExp(${descriptionPattern}, "i");
  const __runwireTestHarnessPattern = new RegExp(${testHarnessPattern}, "i");
  const __runwireOriginalTools = globalThis.tools;
  const __runwireOriginalInventory = Array.isArray(globalThis.ALL_TOOLS)
    ? globalThis.ALL_TOOLS
    : [];
  const __runwireBlockedNames = new Set(
    __runwireOriginalInventory
      .filter(tool => {
        const name = String(tool?.name ?? "");
        const description = String(tool?.description ?? "");
        return __runwireNamePattern.test(name) ||
          __runwireDescriptionPattern.test(description) ||
          __runwireTestHarnessPattern.test(name);
      })
      .map(tool => String(tool.name)),
  );
  const __runwireFilteredTools = Object.create(null);
  for (const tool of __runwireOriginalInventory) {
    const name = String(tool?.name ?? "");
    if (!name || __runwireBlockedNames.has(name)) continue;
    const callable = __runwireOriginalTools[name];
    if (typeof callable === "function") {
      Object.defineProperty(__runwireFilteredTools, name, {
        value: callable.bind(__runwireOriginalTools),
        enumerable: true,
      });
    }
  }
  globalThis.ALL_TOOLS = __runwireOriginalInventory.filter(
    tool => !__runwireBlockedNames.has(String(tool?.name ?? "")),
  );
  globalThis.tools = new Proxy(__runwireFilteredTools, {
    get(target, property, receiver) {
      const name = String(property);
      if (__runwireTestHarnessPattern.test(name)) {
        throw new Error("Blocked test-harness tool: " + name);
      }
      if (__runwireBlockedNames.has(name) || __runwireNamePattern.test(name)) {
        throw new Error("Blocked model-spawning tool: " + name);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
${code}`;
}
