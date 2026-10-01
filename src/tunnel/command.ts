export interface BuildTunnelClientArgsOptions {
  tunnelId: string;
  mcpUrl: string;
  healthUrlFile: string;
  apiKeyFile?: string;
}

export function buildTunnelClientArgs(options: BuildTunnelClientArgsOptions): string[] {
  const args = [
    "run",
    "--control-plane.tunnel-id",
    options.tunnelId,
  ];

  if (options.apiKeyFile) {
    args.push("--control-plane.api-key", `file:${options.apiKeyFile}`);
  }

  args.push(
    "--mcp.server-url",
    `url=${options.mcpUrl},channel=main`,
    "--mcp.startup-wait-timeout",
    "10s",
    "--health.listen-addr",
    "127.0.0.1:0",
    "--health.url-file",
    options.healthUrlFile,
    "--log.format",
    "struct-text",
    "--log.level",
    "info",
  );

  return args;
}
