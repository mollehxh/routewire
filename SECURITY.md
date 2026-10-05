# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose local
files, credentials, Codex authentication, MCP tunnel credentials, or command
execution.

Report security issues privately through GitHub Security Advisories for this
repository. Include reproduction steps, affected versions, and the expected
impact.

## Security model

Runwire binds its local HTTP/MCP surface to loopback addresses only. Native
Codex tools still run under the Codex sandbox and approval policy selected by
the user. The `--danger-full-access` option deliberately bypasses those
protections and should be used only in trusted local environments.

Tunnel credentials are read from the environment or a user-provided file and
must never be committed to the repository.
