import type { CodexApprovalPolicy, CodexSandboxMode } from "../tui-settings.js";

export interface BuildCodexArgsOptions {
  model: string;
  providerBaseUrl: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  fastMode?: boolean;
  dangerFullAccess?: boolean;
}

export function buildCodexArgs(options: BuildCodexArgsOptions): string[] {
  const providerConfig = [
    'name="Runwire"',
    `base_url="${options.providerBaseUrl}"`,
    'wire_api="responses"',
    "requires_openai_auth=true",
    "supports_websockets=false",
  ].join(",");

  const sandboxMode = options.sandboxMode ?? "workspace-write";
  const approvalPolicy: CodexApprovalPolicy = "never";

  const args = [
    "--no-daemon",
    "-m",
    options.model,
    "-c",
    'model_provider="runwire"',
    "-c",
    `model_providers.runwire={${providerConfig}}`,
    "-c",
    "analytics.enabled=false",
    "-c",
    "agents.enabled=true",
    "-c",
    "features.multi_agent_v2.enabled=true",
    "-c",
    `features.fast_mode=${options.fastMode === false ? "false" : "true"}`,
  ];

  if (options.dangerFullAccess) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", sandboxMode, "-a", approvalPolicy);
  }

  args.push("exec", "--skip-git-repo-check", "--ephemeral", "-");
  return args;
}
