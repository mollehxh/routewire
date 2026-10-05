import {describe, expect, it} from "vitest";

import {agentSenderTaskName, agentTaskReference, describeActivityEvent} from "../src/tui.js";

describe("Runwire Activity classification", () => {
  it("parses an agent sender exactly instead of matching task-name prefixes", () => {
    expect(agentSenderTaskName(
      "Message Type: FINAL_ANSWER\nSender: /root/review_tests\nPayload:\nok",
    )).toBe("review_tests");
    expect(agentSenderTaskName(
      "Message Type: FINAL_ANSWER\nSender: /root/review\nPayload:\nok",
    )).toBe("review");
  });

  it("normalizes canonical root agent references without prefix matching", () => {
    expect(agentTaskReference("test_math")).toBe("test_math");
    expect(agentTaskReference("/root/test_math")).toBe("test_math");
    expect(agentTaskReference("/root/test_math_child")).toBe("test_math_child");
  });

  it("classifies a projected exec_command as shell activity with the actual command", () => {
    const activity = describeActivityEvent({
      type: "call_started",
      callId: "runwire-1",
      namespace: "functions",
      name: "exec",
      input: 'const __runwireNativeResult = await tools["exec_command"]({"cmd":"npm test","workdir":"/repo"});',
      startedAt: 1,
    });
    expect(activity).toMatchObject({kind: "shell", target: "npm test", detail: "in /repo"});
  });

  it("classifies read-like shell commands separately", () => {
    const activity = describeActivityEvent({
      type: "call_started",
      callId: "runwire-read",
      namespace: "functions",
      name: "exec",
      input: 'const __runwireNativeResult = await tools["exec_command"]({"cmd":"sed -n \'1,120p\' src/tui.ts","workdir":"/repo"});',
      startedAt: 1,
    });
    expect(activity).toMatchObject({kind: "read", target: "sed -n '1,120p' src/tui.ts"});
  });

  it("classifies projected apply_patch activity by affected files", () => {
    const patch = "*** Begin Patch\n*** Update File: src/tui.ts\n*** Update File: test/tui.test.ts\n*** End Patch";
    const activity = describeActivityEvent({
      type: "call_started",
      callId: "runwire-2",
      namespace: "functions",
      name: "exec",
      input: `const __runwireNativeResult = await tools["apply_patch"](${JSON.stringify(patch)});`,
      startedAt: 1,
    });
    expect(activity).toMatchObject({
      kind: "edit",
      target: "2 files",
      detail: "src/tui.ts, test/tui.test.ts",
    });
  });

  it("hides Runwire inventory and skill-discovery calls from Activity", () => {
    expect(describeActivityEvent({
      type: "call_started",
      callId: "internal",
      namespace: "functions",
      name: "exec",
      input: "const __runwireInventory = ALL_TOOLS; text(__runwireInventory);",
      startedAt: 1,
    })).toBeUndefined();
  });

  it("shows semantic skill reads without exposing internal Code Mode", () => {
    const activity = describeActivityEvent({
      type: "call_started",
      callId: "skill-1",
      namespace: "runwire",
      name: "get_skill",
      arguments: { names: ["tui-design", "browser"] },
      startedAt: 1,
    });
    expect(activity).toMatchObject({
      kind: "skill",
      target: "tui-design, browser",
    });
  });

  it("describes multi-tool Code Mode as a script instead of generic codex", () => {
    const activity = describeActivityEvent({
      type: "call_started",
      callId: "script",
      namespace: "functions",
      name: "exec",
      input: "const a = await tools.exec_command({cmd:'pwd'}); await tools.apply_patch({patch:'x'}); text(a);",
      startedAt: 1,
    });
    expect(activity).toMatchObject({kind: "script", target: "exec_command + apply_patch", detail: "2 tool calls"});
  });

  it("classifies agent spawns semantically", () => {
    const activity = describeActivityEvent({
      type: "call_started",
      callId: "agent",
      namespace: "collaboration",
      name: "spawn_agent",
      arguments: {
        task_name: "review_tests",
        model: "gpt-6-luna",
        reasoning_effort: "high",
      },
      startedAt: 1,
    });
    expect(activity).toMatchObject({
      kind: "spawn",
      target: "review_tests",
      detail: "gpt-6-luna  high",
      agentTaskName: "review_tests",
    });
  });

  it.each([
    ["send_message", "message"],
    ["followup_task", "followup"],
    ["interrupt_agent", "interrupt"],
  ] as const)("classifies %s as %s", (name, kind) => {
    const activity = describeActivityEvent({
      type: "call_started",
      callId: name,
      namespace: "collaboration",
      name,
      arguments: { target: "review_tests", message: "continue" },
      startedAt: 1,
    });
    expect(activity).toMatchObject({
      kind,
      target: "review_tests",
      agentTaskName: "review_tests",
    });
  });

  it("normalizes canonical followup targets to the spawned agent key", () => {
    const activity = describeActivityEvent({
      type: "call_started",
      callId: "followup",
      namespace: "collaboration",
      name: "followup_task",
      arguments: {target: "/root/test_math", message: "continue"},
      startedAt: 1,
    });
    expect(activity).toMatchObject({
      kind: "followup",
      target: "test_math",
      agentTaskName: "test_math",
    });
  });
});
