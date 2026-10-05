export const SIDEBAND_MCP_INSTRUCTIONS = `This server exposes one persistent live Codex runtime and its native tool surface.

Before ordinary substantive work in a conversation, call \`bootstrap\` once if the current Codex context has not already been loaded. It returns the current runtime/project context, applicable AGENTS.md instructions, permissions, and the native Codex skill catalog. Reuse that context for later turns unless the runtime was restarted or the context is known to have changed.

Skill handling:
- \`$skills\`: call \`skills\` and present the available skills. Do not call \`bootstrap\` only to list the catalog, and do not load full skill instructions only to list it.
- Explicit \`$<skill-name>\`: if it is an exact enabled skill name already known in the conversation, load it directly with \`get_skill\` before doing the task. If the exact enabled name is unknown, call \`skills\` first and use a name returned by it. Call \`bootstrap\` as well only when the requested task needs current project/runtime context.
- Ordinary tasks: use the skill catalog returned by \`bootstrap\`. If the task clearly matches one or more skill descriptions, load the minimal relevant set with \`get_skill\` before acting. If no skill clearly applies, continue without loading one.
- Do not guess skill names. \`get_skill\` accepts exact enabled names returned by \`skills\` and can load multiple skills in one call.

Tool use:
- Prefer a directly exposed native Codex tool for a simple single operation.
- Use the collaboration tools for subagent work. \`spawn_agent\` is restricted to the child-model allowlist configured in Runwire; use only models exposed by its current tool schema and description. Reasoning effort may be low, medium, high, xhigh, max, or ultra.
- Use \`exec\` when multiple native calls, batching, persistent JavaScript values, or control flow are useful, or when a needed native tool is available only through Code Mode.
- Reuse context already obtained in this conversation instead of repeating discovery calls unnecessarily.`;
