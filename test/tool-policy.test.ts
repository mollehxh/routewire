import { describe, expect, it } from "vitest";

import { isModelSpawningTool, wrapExecCode } from "../src/tool-policy.js";

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

  it("wraps Code Mode cells with a dynamic tools/ALL_TOOLS policy before user code", () => {
    const wrapped = wrapExecCode("text(await tools.exec_command({cmd: 'pwd'}));");

    expect(wrapped).toContain("globalThis.ALL_TOOLS");
    expect(wrapped).toContain("new Proxy");
    expect(wrapped).toContain("Sideband blocked model-spawning tool");
    expect(wrapped).toContain("text(await tools.exec_command({cmd: 'pwd'}));");
  });
});
