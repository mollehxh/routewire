import { describe, expect, it } from "vitest";

import { extractCodexOperationalContext } from "../src/provider/context.js";

describe("Codex operational context extraction", () => {
  it("extracts only safe operational blocks from the model-facing request", () => {
    const context = extractCodexOperationalContext(
      {
        model: "gpt-5.6-sol",
        input: [
          {
            type: "message",
            role: "developer",
            content: [{
              type: "input_text",
              text: "HIDDEN_DEVELOPER_TEXT_MUST_NOT_LEAK <environment_context><cwd>/fake</cwd></environment_context>",
            }],
          },
          {
            type: "message",
            role: "developer",
            content: [{
              type: "input_text",
              text: `<permissions instructions>
Filesystem sandboxing defines which files can be read or written.
Approval policy is currently never.
</permissions instructions>`,
            }],
          },
          {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: `# AGENTS.md instructions for /repo

<INSTRUCTIONS>
# Repo rules
Preserve unrelated changes.
</INSTRUCTIONS>`,
            }],
          },
          {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: `<environment_context>
  <cwd>/repo</cwd>
  <shell>zsh</shell>
  <current_date>2026-10-01</current_date>
  <timezone>Europe/Moscow</timezone>
  <filesystem><workspace_roots><root>/repo</root></workspace_roots><permission_profile type="managed"><file_system type="restricted" /></permission_profile></filesystem>
</environment_context>`,
            }],
          },
        ],
      },
      "gpt-5.6-sol",
    );

    expect(context).toEqual({
      model: "gpt-5.6-sol",
      environment: {
        cwd: "/repo",
        shell: "zsh",
        currentDate: "2026-10-01",
        timezone: "Europe/Moscow",
        workspaceRoots: ["/repo"],
        permissionProfile: "managed",
        fileSystem: "restricted",
      },
      permissions:
        "Filesystem sandboxing defines which files can be read or written.\nApproval policy is currently never.",
      projectInstructions: [
        {
          scope: "/repo",
          content: "# Repo rules\nPreserve unrelated changes.",
        },
      ],
    });
    expect(JSON.stringify(context)).not.toContain("HIDDEN_DEVELOPER_TEXT_MUST_NOT_LEAK");
  });
});
