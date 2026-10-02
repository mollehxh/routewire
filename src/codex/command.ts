export interface BuildCodexArgsOptions {
  model: string;
  providerBaseUrl: string;
  dangerFullAccess?: boolean;
}

export function buildCodexArgs(options: BuildCodexArgsOptions): string[] {
  const providerConfig = [
    'name="Sideband"',
    `base_url="${options.providerBaseUrl}"`,
    'wire_api="responses"',
    "requires_openai_auth=true",
    "supports_websockets=false",
  ].join(",");

  const args = [
    "--no-daemon",
    "-m",
    options.model,
    "-c",
    'model_provider="sideband"',
    "-c",
    `model_providers.sideband={${providerConfig}}`,
    "-c",
    "analytics.enabled=false",
    "-c",
    "agents.enabled=true",
    "-c",
    "features.multi_agent_v2.enabled=true",
  ];

  if (options.dangerFullAccess) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  args.push("exec", "--skip-git-repo-check", "--ephemeral", "-");
  return args;
}
