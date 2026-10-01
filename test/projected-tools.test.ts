import { describe, expect, it } from "vitest";

import { selectProjectedNativeTools } from "../src/mcp/projected-tools.js";

describe("projected Codex native tools", () => {
  it("projects the small canonical surface and ignores test-harness duplicates", () => {
    const projected = selectProjectedNativeTools([
      { name: "exec_command", description: "EXEC" },
      { name: "write_stdin", description: "STDIN" },
      { name: "apply_patch", description: "PATCH" },
      { name: "view_image", description: "IMAGE" },
      { name: "mcp__node_repl__js", description: "NODE" },
      { name: "mcp__node_repl__js_reset", description: "NODE RESET" },
      { name: "mcp__node_repl__js_add_node_module_dir", description: "NODE MODULE" },
      {
        name: "mcp__codex_apps__test_harnes_0001_cua_repl__js",
        description: "WRONG CUA",
      },
      {
        name: "mcp__codex_apps__fkn_codex_mcp__cua_repl__js",
        description: "CUA",
      },
      {
        name: "mcp__codex_apps__fkn_codex_mcp__cua_repl__js_reset",
        description: "CUA RESET",
      },
      {
        name: "mcp__codex_apps__fkn_codex_mcp__cua_repl__js_add_node_module_dir",
        description: "CUA MODULE",
      },
      { name: "create_goal", description: "GOAL" },
      { name: "mcp__mail__search", description: "MAIL" },
    ]);

    expect(projected.map(tool => tool.name)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
      "mcp__node_repl__js",
      "mcp__node_repl__js_reset",
      "mcp__node_repl__js_add_node_module_dir",
      "mcp__codex_apps__fkn_codex_mcp__cua_repl__js",
      "mcp__codex_apps__fkn_codex_mcp__cua_repl__js_reset",
      "mcp__codex_apps__fkn_codex_mcp__cua_repl__js_add_node_module_dir",
    ]);
    expect(
      projected.find(tool => tool.name.endsWith("cua_repl__js"))?.nativeName,
    ).toBe(
      "mcp__codex_apps__fkn_codex_mcp__cua_repl__js",
    );
    expect(projected.find(tool => tool.name === "mcp__node_repl__js")?.description).toBe("NODE");
    expect(projected.find(tool => tool.name.endsWith("cua_repl__js"))?.description).toBe("CUA");
    expect(projected.some(tool => /goal|mail/i.test(tool.name))).toBe(false);
  });

  it("adapts apply_patch to a structured ChatGPT-facing argument", () => {
    const [tool] = selectProjectedNativeTools([
      { name: "apply_patch", description: "FREEFORM PATCH" },
    ]);

    expect(tool.name).toBe("apply_patch");
    expect(tool.description).toContain("FREEFORM PATCH");
    expect(tool.description).toContain("patch");
    expect(tool.mapArguments({ patch: "*** Begin Patch\n*** End Patch" })).toBe(
      "*** Begin Patch\n*** End Patch",
    );
  });
});
