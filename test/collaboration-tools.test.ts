import { describe, expect, it } from "vitest";

import { selectCollaborationTools } from "../src/mcp/collaboration-tools.js";
import type { CodexModelCatalogEntry } from "../src/model-catalog.js";
import type { FunctionToolSpec } from "../src/provider/protocol.js";

const catalog: readonly CodexModelCatalogEntry[] = [
  {
    id: "gpt-6-luna",
    displayName: "GPT-6-Luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    fastMode: true,
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    fastMode: true,
  },
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
    fastMode: true,
  },
];

const policy = {
  allowedModels: ["gpt-6-luna", "gpt-5.6-terra"],
  catalog,
};

function spec(name: string): FunctionToolSpec {
  return {
    type: "function",
    name,
    description:
      name === "spawn_agent"
        ? "Available model overrides (optional; inherited parent model is preferred):\n- `gpt-5.6-sol`: sol\n- `gpt-5.6-terra`: terra\nSpawns an agent to work on the specified task."
        : `${name} native description`,
    parameters: { type: "object", properties: {} },
  };
}

describe("collaboration tool projection", () => {
  it("requires the orchestrator to choose an allowed model", () => {
    const [tool] = selectCollaborationTools([spec("spawn_agent")], policy);
    expect(tool.name).toBe("spawn_agent");
    expect(tool.description).toContain("gpt-6-luna");
    expect(tool.description).toContain("gpt-5.6-terra");
    expect(() => tool.mapArguments({ task_name: "review", message: "Review this" })).toThrow();
    expect(tool.mapArguments({ task_name: "review", message: "Review this", model: "gpt-6-luna" })).toEqual({
      task_name: "review",
      message: "Review this",
      model: "gpt-6-luna",
      fork_turns: "none",
    });
  });

  it("enforces only the Runwire model allowlist", () => {
    const [tool] = selectCollaborationTools([spec("spawn_agent")], policy);

    expect(tool.description).toContain("gpt-5.6-terra");
    expect(tool.mapArguments({
      task_name: "review",
      message: "Review this",
      model: "gpt-5.6-terra",
    })).toMatchObject({
      model: "gpt-5.6-terra",
      fork_turns: "none",
    });
    expect(() => tool.mapArguments({
      task_name: "bad",
      message: "bad",
      model: "gpt-5.6-sol",
    })).toThrow(/blocked/i);
  });

  it("removes spawn_agent when every child model is blocked", () => {
    expect(selectCollaborationTools([spec("spawn_agent")], {
      allowedModels: [],
      catalog,
    })).toEqual([]);
  });

  it("enforces the supported efforts of each allowed model", () => {
    const [tool] = selectCollaborationTools([spec("spawn_agent")], policy);
    expect(() => tool.mapArguments({ task_name: "bad", message: "bad", fork_turns: "all" })).toThrow();
    expect(() => tool.mapArguments({
      task_name: "deep_luna",
      message: "review",
      model: "gpt-6-luna",
      reasoning_effort: "ultra",
    })).toThrow(/not supported.*gpt-6-luna/i);
    expect(tool.mapArguments({task_name: "luna", message: "review", model: "gpt-6-luna", reasoning_effort: "max"})).toMatchObject({reasoning_effort: "max"});
    expect(tool.mapArguments({
      task_name: "deep_review",
      message: "review",
      model: "gpt-5.6-terra",
      fork_turns: "4",
      reasoning_effort: "ultra",
    })).toMatchObject({ model: "gpt-5.6-terra", fork_turns: "4", reasoning_effort: "ultra" });
    expect(tool.description).toContain("- gpt-6-luna: low, medium, high, xhigh, max\n");
    expect(tool.description).toContain("- gpt-5.6-terra: low, medium, high, xhigh, max, ultra");
    expect(tool.description).toContain("Runwire does not impose defaults");
  });
});
