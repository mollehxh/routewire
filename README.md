# Routewire

Routewire exposes the live model-facing tool surface of a local Codex turn as an
MCP server. ChatGPT can remain the reasoning model while Codex executes the
same local tools, skills, Browser/Computer Use runtimes, and subagent surface
available to that turn.

Routewire connects through the OpenAI Secure MCP Tunnel. Its internal HTTP/MCP
listener binds to loopback only; a tunnel ID and runtime API key are required.

## Requirements

- Node.js 22 or newer
- A working Codex installation and authentication
- An OpenAI Secure MCP Tunnel ID and runtime API key with Tunnels Read + Use permissions

## Install

```bash
npm install --global routewire
routewire
```

You can also run it without a global install:

```bash
npx routewire
```

Routewire starts the interactive TUI when attached to a terminal. In headless
mode it uses the same required tunnel and prints the local MCP and provider endpoints.

## Updates

Interactive Routewire checks npm for a newer release at startup. The check is
non-blocking and fails open when the registry is unavailable. A discovered newer
release is cached for one hour, while an up-to-date result is checked again on
the next launch so newly published versions are not hidden by stale cache. When
an update exists, Routewire offers two choices before the main
menu: install the latest release now or continue with the current version.

Continuing does not suppress the release, so Routewire offers the same update
again on a later launch while the installed version is still outdated. Update
installation uses the detected npm-compatible package manager and can be
cancelled by quitting Routewire. Set `ROUTEWIRE_DISABLE_UPDATE_CHECK=1` to disable
the startup check entirely.

## Usage

```text
routewire [options]

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
  -v, --version           Show the Routewire version
  -h, --help              Show help
```

By default Routewire:

- binds to `127.0.0.1` on an available port;
- starts an ephemeral `codex exec` turn;
- points that turn at Routewire's local Responses-compatible provider bridge;
- preserves the user's normal Codex configuration and plugins;
- discovers the live Codex tool surface instead of maintaining a separate copy;
- exposes compatible native tools and skills through MCP;
- keeps Codex sandbox and approval behavior intact unless
  `--danger-full-access` is explicitly selected.

## ChatGPT Project Instructions

For Codex-style agent behavior in ChatGPT, copy
[`CHATGPT_PROJECT_INSTRUCTIONS.md`](./CHATGPT_PROJECT_INSTRUCTIONS.md) into
the ChatGPT Project Instructions field. Routewire's MCP instructions add the
runtime-specific bootstrap, skill-loading, and tool-selection workflow.

## OpenAI Secure MCP Tunnel

The tunnel is always required. Configure Tunnel ID and API key under
Settings > Connection in the TUI, or supply them through flags or environment variables:

Existing settings are migrated automatically on the first launch after updating.
The obsolete `tunnelEnabled` field is removed, including when it was `false`;
saved tunnel IDs and API keys are preserved. Headless mode also uses saved
connection settings. Without an ID or key, startup fails with a configuration error.

```bash
export ROUTEWIRE_TUNNEL_ID=tunnel_...
export CONTROL_PLANE_API_KEY=<runtime-key-with-tunnel-permissions>
routewire
```

A file-backed runtime key is also supported:

```bash
routewire \
  --tunnel-id tunnel_... \
  --tunnel-api-key-file /path/to/runtime-api-key
```

If `--tunnel-client` is not supplied, Routewire downloads the pinned official
tunnel client on first use, verifies the release checksums, and caches the
verified executable under the user's Routewire cache directory.

For migration from the old project name, `SIDEBAND_TUNNEL_ID`,
`SIDEBAND_TUNNEL_API_KEY_FILE`, `SIDEBAND_TUNNEL_CLIENT`, and
`SIDEBAND_DEBUG` are still accepted when the corresponding `ROUTEWIRE_*`
variable is not set.

## Browser and Computer Use

Routewire does not reimplement Browser Use or Computer Use. When the live Codex
turn exposes `node_repl`, `cua_repl`, or compatible plugin-prefixed tools,
Routewire projects those native tools through the MCP surface.

Some native runtimes require broader Codex permissions. For explicit trusted
local testing only:

```bash
routewire --danger-full-access
```

That passes Codex's dangerous full-access mode to the child process and
therefore disables its normal approval prompts and sandboxing.

## Debugging

Enable metadata-only provider diagnostics with:

```bash
ROUTEWIRE_DEBUG=1 routewire
```

The debug log reports provider request sequencing and response metadata. It
does not intentionally log prompts, tool source code, tool output, or tunnel
credentials.

## Development

```bash
git clone https://github.com/mollehxh/routewire.git
cd routewire
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
ROUTEWIRE_REAL_CODEX=1 npm test -- test/real-runtime-smoke.test.ts
```

## Security

See [`SECURITY.md`](./SECURITY.md). Do not commit Codex credentials, tunnel
credentials, local settings, or diagnostic artifacts containing private data.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT © 2026 mollehxh
