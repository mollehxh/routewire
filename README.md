# Sideband

Sideband exposes the **live model-facing tool surface of a local Codex turn** as a local MCP server. ChatGPT can be the reasoning model while Codex executes its native tools.

The current implementation is the local façade only. OpenAI Secure MCP Tunnel lifecycle management is not wired yet.

## Development

```bash
npm install
npm run build
npm test
```

Run Sideband from the project directory Codex should operate on:

```bash
npm run dev
```

By default Sideband:

- binds to `127.0.0.1` on an available port;
- starts a real ephemeral `codex exec` turn;
- forces Codex model identity to `gpt-5.6-sol`;
- overrides only `model_provider` for that child process, pointing it at Sideband's local Responses-compatible endpoint;
- keeps the user's normal Codex config/plugins available;
- waits for Codex to emit its real `functions.exec` declaration, then publishes that declaration as the MCP `exec` tool;
- leaves Codex's normal permission/sandbox policy intact.

The CLI prints the local MCP URL after Codex has exposed the tool surface.

### Browser / Computer Use

Browser Use and Computer Use are not reimplemented in Sideband. If the live Codex turn exposes `node_repl`, `cua_repl`, or plugin-prefixed equivalents inside `functions.exec`, ChatGPT can invoke them through Sideband by writing the same Code Mode JavaScript Codex's own model would write.

Some Browser/CUA runtimes require Codex full access. For explicit local testing only:

```bash
npm run dev -- --danger-full-access
```

That passes `--dangerously-bypass-approvals-and-sandbox` to the child Codex process and therefore disables Codex approval prompts and sandboxing for native tool execution.

### Live smoke tests

The normal suite is hermetic. To verify the complete MCP → Sideband → live Codex → native tool → Sideband round-trip:

```bash
SIDEBAND_REAL_CODEX=1 npm test -- test/real-runtime-smoke.test.ts
```

That live smoke verifies all three paths in the same persistent Codex turn:

- native `exec_command` execution;
- the real `node_repl` Browser runtime discovered from `ALL_TOOLS`;
- the real `cua_repl` Computer Use runtime discovered from `ALL_TOOLS`.

The test resolves the runtime tool names dynamically instead of assuming a fixed MCP namespace.
