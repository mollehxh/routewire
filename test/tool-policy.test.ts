import { describe, expect, it } from "vitest";

import {
  compactExecDescription,
  isModelSpawningTool,
  isSidebandBlockedTool,
  SIDEBAND_EXEC_GUIDANCE,
  wrapExecCode,
} from "../src/tool-policy.js";

describe("Sideband tool policy", () => {
  it("blocks tools that start or continue independent model/agent sessions", () => {
    for (const tool of [
      { name: "mcp__x__collaboration__spawn_agent", description: "Spawn an agent." },
      { name: "mcp__x__notion_spawn_session", description: "Start an agent session." },
      { name: "mcp__x__figma_weave_run_model", description: "Run a model." },
      { name: "mcp__x__collaboration__followup_task", description: "Send follow-up work." },
    ]) {
      expect(isModelSpawningTool(tool)).toBe(true);
    }
  });

  it("keeps native execution and Browser/CUA tools available", () => {
    for (const tool of [
      { name: "exec_command", description: "Run a shell command." },
      { name: "mcp__node_repl__js", description: "Browser Use JavaScript runtime." },
      { name: "mcp__codex_apps__fkn_codex_mcp__cua_repl__js", description: "Computer Use runtime." },
      { name: "mcp__gmail__search", description: "Search mail." },
    ]) {
      expect(isModelSpawningTool(tool)).toBe(false);
    }
  });

  it("blocks Codex Apps test-harness tools without blocking canonical Browser Use", () => {
    expect(
      isSidebandBlockedTool({
        name: "mcp__codex_apps__test_harnes_0001_node_repl",
        description: "Node REPL with Browser Use runtime.",
      }),
    ).toBe(true);
    expect(
      isSidebandBlockedTool({
        name: "mcp__node_repl__js",
        description: "Canonical Node REPL.",
      }),
    ).toBe(false);
  });

  it("documents when ChatGPT should prefer direct tools versus Code Mode", () => {
    expect(SIDEBAND_EXEC_GUIDANCE).toContain("Prefer a directly exposed native tool");
    expect(SIDEBAND_EXEC_GUIDANCE).toContain("multiple native calls");
    expect(SIDEBAND_EXEC_GUIDANCE).toContain("ALL_TOOLS");
  });

  it("removes duplicated shared MCP types and nested tool declarations from exec descriptions", () => {
    const description = [
      "Run JavaScript code to orchestrate/compose tool calls",
      "- ALL_TOOLS contains enabled nested tools.",
      "",
      "Shared MCP Types:",
      "```ts",
      "type ContentBlock = unknown;",
      "```",
      "",
      "### `exec_command`",
      "nested declaration",
    ].join("\n");

    expect(compactExecDescription(description)).toBe(
      "Run JavaScript code to orchestrate/compose tool calls\n- ALL_TOOLS contains enabled nested tools.",
    );
  });

  it("wraps Code Mode cells with a dynamic tools/ALL_TOOLS policy before user code", () => {
    const wrapped = wrapExecCode("text(await tools.exec_command({cmd: 'pwd'}));");

    expect(wrapped).toContain("globalThis.ALL_TOOLS");
    expect(wrapped).toContain("new Proxy");
    expect(wrapped).toContain("Blocked model-spawning tool");
    expect(wrapped).toContain("Blocked test-harness tool");
    expect(wrapped).toContain("codex_apps__test_harnes");
    expect(wrapped).toContain("text(await tools.exec_command({cmd: 'pwd'}));");
  });
});
