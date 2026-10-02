import { describe, expect, it } from "vitest";

import { selectCollaborationTools } from "../src/mcp/collaboration-tools.js";
import type { FunctionToolSpec } from "../src/provider/protocol.js";

function spec(name: string): FunctionToolSpec {
  return {
    type: "function",
    name,
    description:
      name === "spawn_agent"
        ? "Available model overrides (optional; inherited parent model is preferred):\n- `gpt-6-sol`: other\n- `gpt-6-luna`: luna\nSpawns an agent to work on the specified task."
        : `${name} native description`,
    parameters: { type: "object", properties: {} },
  };
}

describe("collaboration tool projection", () => {
  it("exposes spawn_agent as Luna-only and injects safe defaults", () => {
    const [tool] = selectCollaborationTools([spec("spawn_agent")]);
    expect(tool.name).toBe("spawn_agent");
    expect(tool.description).toContain("gpt-6-luna");
    expect(tool.description).not.toContain("gpt-6-sol");

    expect(tool.mapArguments({ task_name: "review", message: "Review this" })).toEqual({
      task_name: "review",
      message: "Review this",
      model: "gpt-6-luna",
      reasoning_effort: "high",
      fork_turns: "none",
    });
  });

  it("allows only bounded root forks and high/xhigh/max reasoning", () => {
    const [tool] = selectCollaborationTools([spec("spawn_agent")]);

    expect(() =>
      tool.mapArguments({
        task_name: "bad",
        message: "bad",
        fork_turns: "all",
      }),
    ).toThrow();
    expect(() =>
      tool.mapArguments({
        task_name: "bad",
        message: "bad",
        reasoning_effort: "medium",
      }),
    ).toThrow();

    expect(tool.mapArguments({
      task_name: "deep_review",
      message: "review",
      fork_turns: "4",
      reasoning_effort: "max",
    })).toMatchObject({
      model: "gpt-6-luna",
      fork_turns: "4",
      reasoning_effort: "max",
    });
  });
});
