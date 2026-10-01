import { describe, expect, it } from "vitest";

import { selectNativeSkillTools } from "../src/mcp/skill-tools.js";

describe("Sideband Codex skill tools", () => {
  it("selects the native fkn-codex catalog/read pair without matching work or test variants", () => {
    expect(
      selectNativeSkillTools([
        { name: "mcp__codex_apps__fkn_codex_work_codex_skills_list" },
        { name: "mcp__codex_apps__fkn_codex_work_codex_skill_get" },
        { name: "mcp__codex_apps__test_agent_001_skills_list" },
        { name: "mcp__codex_apps__fkn_codex_codex_skills_list" },
        { name: "mcp__codex_apps__fkn_codex_codex_skill_get" },
      ]),
    ).toEqual({
      listName: "mcp__codex_apps__fkn_codex_codex_skills_list",
      getName: "mcp__codex_apps__fkn_codex_codex_skill_get",
    });
  });

  it("does not expose skill helpers when the native pair is incomplete", () => {
    expect(
      selectNativeSkillTools([
        { name: "mcp__codex_apps__fkn_codex_codex_skills_list" },
      ]),
    ).toBeUndefined();
  });
});
