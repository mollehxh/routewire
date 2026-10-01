export const SIDEBAND_MCP_INSTRUCTIONS = `Sideband exposes one persistent live Codex runtime and its native tool surface.

Before ordinary substantive Sideband work in a conversation, ensure the current Codex skill catalog is available by calling \`skills\` once if it has not already been loaded. Reuse that catalog for later turns; call \`skills\` again only if skills or plugins may have changed. An explicit exact skill invocation does not require listing the whole catalog first.

Skill handling:
- \`$skills\`: call \`skills\` and present the available skills. Do not load full skill instructions only to list the catalog.
- Explicit \`$<skill-name>\`: if it is an exact enabled skill name already known in the conversation, load it directly with \`get_skill\` before doing the task. If the exact enabled name is unknown, call \`skills\` first and use a name returned by it.
- Ordinary tasks: after the catalog is available, if the task clearly matches one or more skill descriptions, load the minimal relevant set with \`get_skill\` before acting. If no skill clearly applies, continue without loading one.
- Do not guess skill names. \`get_skill\` accepts exact enabled names returned by \`skills\` and can load multiple skills in one call.

Tool use:
- Prefer a directly exposed native Codex tool for a simple single operation.
- Use \`exec\` when multiple native calls, batching, persistent JavaScript values, or control flow are useful, or when a needed native tool is available only through Code Mode.
- Reuse context already obtained in this conversation instead of repeating discovery calls unnecessarily.`;
