import { describe, expect, it } from "vitest";

import { buildCodexArgs } from "../src/codex/command.js";

describe("buildCodexArgs", () => {
  it("forces gpt-5.6-sol and a process-local Responses provider without replacing CODEX_HOME", () => {
    const args = buildCodexArgs({
      model: "gpt-5.6-sol",
      providerBaseUrl: "http://127.0.0.1:3210/v1",
    });

    expect(args).toContain("gpt-5.6-sol");
    expect(args).toContain('model_provider="sideband"');
    expect(args.join(" ")).toContain("127.0.0.1:3210/v1");
    expect(args.join(" ")).toContain("requires_openai_auth=true");
    expect(args).toContain("agents.enabled=true");
    expect(args).toContain("features.multi_agent_v2.enabled=true");
    expect(args).toContain("--ephemeral");
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("--ignore-user-config");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});
