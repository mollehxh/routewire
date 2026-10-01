import { CodexTurnBridge } from "./bridge.js";
import { startCodexProcess, type CodexExit } from "./codex/process.js";
import { SidebandHttpSurface } from "./http-surface.js";
import { createSidebandMcpServer } from "./mcp/server.js";
import type { ExecToolSpec } from "./provider/protocol.js";
import { ensureTunnelClient } from "./tunnel/install.js";
import { startTunnelClient, type StartTunnelClientOptions, type TunnelClientHandle } from "./tunnel/process.js";

export type SidebandTunnelOptions = Omit<StartTunnelClientOptions, "mcpUrl">;

export interface StartSidebandOptions {
  cwd: string;
  model?: string;
  host?: string;
  port?: number;
  codexHome?: string;
  dangerFullAccess?: boolean;
  quietCodex?: boolean;
  codexCommand?: string;
  tunnel?: SidebandTunnelOptions;
}

export interface SidebandRuntime {
  readonly model: string;
  readonly cwd: string;
  readonly mcpUrl: string;
  readonly providerBaseUrl: string;
  readonly execSpec: ExecToolSpec;
  readonly tunnelHealthUrl?: string;
  readonly codexExited: Promise<CodexExit>;
  close(): Promise<void>;
}

export async function startSideband(options: StartSidebandOptions): Promise<SidebandRuntime> {
  const model = options.model ?? "gpt-5.6-sol";
  const bridge = new CodexTurnBridge({ model });
  const surface = new SidebandHttpSurface({
    bridge,
    host: options.host,
    port: options.port,
  });
  await surface.start();

  const codex = startCodexProcess({
    cwd: options.cwd,
    model,
    providerBaseUrl: surface.providerBaseUrl,
    codexHome: options.codexHome,
    dangerFullAccess: options.dangerFullAccess,
    quiet: options.quietCodex,
    command: options.codexCommand,
  });

  let closing = false;
  let tunnel: TunnelClientHandle | undefined;
  try {
    const execSpec = await Promise.race([
      bridge.ready(),
      codex.exited.then(exit => {
        throw codexExitedBeforeReady(exit);
      }),
    ]);

    surface.setMcpServer(createSidebandMcpServer({ bridge, execSpec }), execSpec);

    const codexExitWatch = codex.exited.then(exit => {
      if (!closing) {
        bridge.close(
          exit.error
            ? `Codex process failed: ${exit.error.message}`
            : `Codex process exited (code=${String(exit.code)}, signal=${String(exit.signal)})`,
        );
      }
      return exit;
    });

    if (options.tunnel) {
      const tunnelStartup = (async () => {
        const tunnelCommand =
          options.tunnel!.command ?? (await ensureTunnelClient());
        return startTunnelClient({
          ...options.tunnel!,
          command: tunnelCommand,
          mcpUrl: surface.mcpUrl,
        });
      })();
      const startupResult = await Promise.race([
        tunnelStartup.then(handle => ({ kind: "tunnel" as const, handle })),
        codexExitWatch.then(exit => ({ kind: "codex_exit" as const, exit })),
      ]);
      if (startupResult.kind === "codex_exit") {
        void tunnelStartup.then(handle => handle.close()).catch(() => undefined);
        throw codexExitedDuringTunnelStartup(startupResult.exit);
      }
      tunnel = startupResult.handle;
    }

    return {
      model,
      cwd: options.cwd,
      mcpUrl: surface.mcpUrl,
      providerBaseUrl: surface.providerBaseUrl,
      execSpec,
      tunnelHealthUrl: tunnel?.healthUrl,
      codexExited: codex.exited,
      async close() {
        if (closing) return;
        closing = true;
        await tunnel?.close();
        bridge.close("Sideband shutting down");

        const exitedNaturally = await Promise.race([
          codex.exited.then(() => true),
          delay(750).then(() => false),
        ]);
        if (!exitedNaturally) {
          codex.terminate();
          const exitedAfterTerminate = await Promise.race([
            codex.exited.then(() => true),
            delay(1_000).then(() => false),
          ]);
          if (!exitedAfterTerminate) {
            codex.forceTerminate();
            await Promise.race([codex.exited, delay(1_000)]);
          }
        }

        await surface.close();
      },
    };
  } catch (error) {
    closing = true;
    await tunnel?.close();
    bridge.close("Sideband startup failed");
    codex.forceTerminate();
    await surface.close();
    throw error;
  }
}

function codexExitedBeforeReady(exit: CodexExit): Error {
  if (exit.error) return new Error(`Failed to start Codex: ${exit.error.message}`, { cause: exit.error });
  return new Error(
    `Codex exited before exposing its tool surface (code=${String(exit.code)}, signal=${String(exit.signal)})`,
  );
}

function codexExitedDuringTunnelStartup(exit: CodexExit): Error {
  if (exit.error) {
    return new Error(`Codex failed while Sideband was starting the tunnel: ${exit.error.message}`, {
      cause: exit.error,
    });
  }
  return new Error(
    `Codex exited while Sideband was starting the tunnel (code=${String(exit.code)}, signal=${String(exit.signal)})`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
