import { describe, expect, it } from "vitest";

import { buildCodexArgs } from "../src/codex/command.js";

describe("buildCodexArgs", () => {
  it("uses explicit Codex permission and fast-mode settings without replacing CODEX_HOME", () => {
    const args = buildCodexArgs({
      model: "gpt-5.6-sol",
      providerBaseUrl: "http://127.0.0.1:3210/v1",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: true,
    });

    expect(args).toContain("gpt-5.6-sol");
    expect(args).toContain('model_provider="routewire"');
    expect(args.join(" ")).toContain("127.0.0.1:3210/v1");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("-s");
    expect(args).toContain("workspace-write");
    expect(args).toContain("-a");
    expect(args).toContain("never");
    expect(args).toContain("features.fast_mode=true");
    expect(args).not.toContain("--ignore-user-config");
  });

  it("can disable fast mode and select read-only permissions", () => {
    const args = buildCodexArgs({
      model: "gpt-5.6-sol",
      providerBaseUrl: "http://127.0.0.1:3210/v1",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      fastMode: false,
    });
    expect(args).toContain("read-only");
    expect(args).toContain("never");
    expect(args).toContain("features.fast_mode=false");
  });

  it("keeps --danger-full-access as a backwards-compatible full-access preset", () => {
    const args = buildCodexArgs({
      model: "gpt-5.6-sol",
      providerBaseUrl: "http://127.0.0.1:3210/v1",
      dangerFullAccess: true,
    });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("-s");
    expect(args).not.toContain("-a");
  });
});
