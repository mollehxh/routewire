# Runwire

Runwire exposes the live model-facing tool surface of a local Codex turn as an
MCP server. ChatGPT can remain the reasoning model while Codex executes the
same local tools, skills, Browser/Computer Use runtimes, and subagent surface
available to that turn.

Runwire is local-first: the HTTP/MCP surface binds to loopback only unless you
explicitly connect it through the OpenAI Secure MCP Tunnel.

## Requirements

- Node.js 22 or newer
- A working Codex installation and authentication

## Install

```bash
npm install --global runwire
runwire
```

You can also run it without a global install:

```bash
npx runwire
```

Runwire starts the interactive TUI when attached to a terminal. In headless
mode it prints the local MCP and provider endpoints.

## Usage

```text
runwire [options]

Options:
  --host <host>           Loopback bind address (default: 127.0.0.1)
  --port <port>           Local port, 0 chooses an available port (default: 0)
  --model <model>         Codex model identity (default: gpt-5.6-sol)
  --codex-home <path>     Override CODEX_HOME for the child Codex process
  --tunnel-id <id>        OpenAI Secure MCP Tunnel ID
  --tunnel-api-key-file <path>
                           Runtime API key file
  --tunnel-client <path>  Override the pinned auto-downloaded tunnel-client
  --danger-full-access    Start Codex with no approvals or filesystem sandbox
  -v, --version           Show the Runwire version
  -h, --help              Show help
```

By default Runwire:

- binds to `127.0.0.1` on an available port;
- starts an ephemeral `codex exec` turn;
- points that turn at Runwire's local Responses-compatible provider bridge;
- preserves the user's normal Codex configuration and plugins;
- discovers the live Codex tool surface instead of maintaining a separate copy;
- exposes compatible native tools and skills through MCP;
- keeps Codex sandbox and approval behavior intact unless
  `--danger-full-access` is explicitly selected.

## ChatGPT Project Instructions

For Codex-style agent behavior in ChatGPT, copy
[`CHATGPT_PROJECT_INSTRUCTIONS.md`](./CHATGPT_PROJECT_INSTRUCTIONS.md) into
the ChatGPT Project Instructions field. Runwire's MCP instructions add the
runtime-specific bootstrap, skill-loading, and tool-selection workflow.

## OpenAI Secure MCP Tunnel

Set a tunnel ID to connect Runwire's local MCP surface through the official
OpenAI tunnel client:

```bash
export RUNWIRE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=<runtime-key-with-tunnel-permissions>
runwire
```

A file-backed runtime key is also supported:

```bash
runwire \
  --tunnel-id tunnel_... \
  --tunnel-api-key-file /path/to/runtime-api-key
```

If `--tunnel-client` is not supplied, Runwire downloads the pinned official
tunnel client on first use, verifies the release checksums, and caches the
verified executable under the user's Runwire cache directory.

For migration from the old project name, `SIDEBAND_TUNNEL_ID`,
`SIDEBAND_TUNNEL_API_KEY_FILE`, `SIDEBAND_TUNNEL_CLIENT`, and
`SIDEBAND_DEBUG` are still accepted when the corresponding `RUNWIRE_*`
variable is not set.

## Browser and Computer Use

Runwire does not reimplement Browser Use or Computer Use. When the live Codex
turn exposes `node_repl`, `cua_repl`, or compatible plugin-prefixed tools,
Runwire projects those native tools through the MCP surface.

Some native runtimes require broader Codex permissions. For explicit trusted
local testing only:

```bash
runwire --danger-full-access
```

That passes Codex's dangerous full-access mode to the child process and
therefore disables its normal approval prompts and sandboxing.

## Debugging

Enable metadata-only provider diagnostics with:

```bash
RUNWIRE_DEBUG=1 runwire
```

The debug log reports provider request sequencing and response metadata. It
does not intentionally log prompts, tool source code, tool output, or tunnel
credentials.

## Development

```bash
git clone https://github.com/mollehxh/runwire.git
cd runwire
npm ci
npm run typecheck
npm test
npm run build
```

Run the development CLI from the project directory Codex should operate on:

```bash
npm run dev
```

The normal test suite is hermetic. An opt-in live smoke test is available for
a configured Codex installation:

```bash
RUNWIRE_REAL_CODEX=1 npm test -- test/real-runtime-smoke.test.ts
```

## Security

See [`SECURITY.md`](./SECURITY.md). Do not commit Codex credentials, tunnel
credentials, local settings, or diagnostic artifacts containing private data.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT © 2026 mollehxh
