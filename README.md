# Sideband

Sideband exposes the **live model-facing tool surface of a local Codex turn** as a local MCP server. ChatGPT can be the reasoning model while Codex executes its native tools.

## ChatGPT Project Instructions

For Codex-style agent behavior in ChatGPT, copy the contents of
[`CHATGPT_PROJECT_INSTRUCTIONS.md`](./CHATGPT_PROJECT_INSTRUCTIONS.md) into the
ChatGPT Project Instructions field. That file contains stable agent behavior;
Sideband's MCP server instructions provide the current runtime preflight,
bootstrap, skill-loading, and tool-selection workflow dynamically.

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

### OpenAI Secure MCP Tunnel

When a tunnel ID is configured, the same Sideband process starts the official
`tunnel-client`, waits for its local `/readyz` endpoint, and stops that child
when Sideband shuts down:

```bash
export SIDEBAND_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=<runtime-key-with-tunnel-permissions>
npm run dev
```

The runtime API key is read by `tunnel-client` from the environment and is not
placed in Sideband's child-process argv. A file-backed runtime key is also
supported:

```bash
npm run dev -- \
  --tunnel-id tunnel_... \
  --tunnel-api-key-file /path/to/runtime-api-key
```

`tunnel-client` binds the OpenAI-hosted tunnel to the local Sideband `/mcp`
endpoint. When `--tunnel-client` is not supplied, Sideband downloads the pinned
official `v0.0.15` platform ZIP from OpenAI's public release storage on first
use, verifies the pinned `SHA256SUMS.txt` digest and the selected archive digest,
and caches only the verified executable in the user's cache directory. Without
a tunnel ID, Sideband stays local-only and prints that the tunnel is not
configured.

If Sideband itself is launched from a process that has a different `CODEX_HOME`
(for example another Codex wrapper), point the child explicitly at the desired
Codex installation state:

```bash
npm run dev -- --codex-home ~/.codex
```

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

### Debugging provider traffic

If a live Codex turn fails, enable metadata-only provider diagnostics:

```bash
SIDEBAND_DEBUG=1 npm run dev
```

PowerShell:

```powershell
$env:SIDEBAND_DEBUG = "1"
node .\dist\cli.js --codex-home "$env:USERPROFILE\.codex" --danger-full-access
```

The debug log prints provider request sequence numbers, request kind, input item
types, and Sideband reply kind. It does not log prompts, `exec` source code, tool
outputs, or tunnel credentials.

Sideband serves both the legacy MCP handshake used by current local SDK clients
and the stateless MCP `2026-07-28` HTTP surface used by current ChatGPT tunnel
traffic (`server/discover`, `tools/list`, and `tools/call`).
