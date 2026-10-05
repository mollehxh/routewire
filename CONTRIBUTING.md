# Contributing to Runwire

Runwire is a Node.js 22+ TypeScript project.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Use focused changes and include tests for behavior changes. Before opening a
pull request, make sure all three checks above pass.

## Pull requests

- Keep changes scoped to one concern.
- Explain user-visible behavior changes and compatibility implications.
- Do not commit credentials, local Codex state, generated review artifacts, or
  build output.
- For changes that touch live Codex, Browser Use, Computer Use, or secure
  tunnel behavior, document any manual verification performed.

## Reporting bugs

Open a GitHub issue with a minimal reproduction, platform details, Node.js
version, Codex version, and relevant Runwire logs with credentials and private
content removed.
