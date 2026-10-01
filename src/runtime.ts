import { CodexTurnBridge } from "./bridge.js";
import { startCodexProcess, type CodexExit } from "./codex/process.js";
import { SidebandHttpSurface } from "./http-surface.js";
import { createSidebandMcpServer } from "./mcp/server.js";
import type { ExecToolSpec } from "./provider/protocol.js";

export interface StartSidebandOptions {
  cwd: string;
  model?: string;
  host?: string;
  port?: number;
  dangerFullAccess?: boolean;
  quietCodex?: boolean;
  codexCommand?: string;
}

export interface SidebandRuntime {
  readonly model: string;
  readonly cwd: string;
  readonly mcpUrl: string;
  readonly providerBaseUrl: string;
  readonly execSpec: ExecToolSpec;
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
    dangerFullAccess: options.dangerFullAccess,
    quiet: options.quietCodex,
    command: options.codexCommand,
  });

  let closing = false;
  try {
    const execSpec = await Promise.race([
      bridge.ready(),
      codex.exited.then(exit => {
        throw codexExitedBeforeReady(exit);
      }),
    ]);

    surface.setMcpServer(createSidebandMcpServer({ bridge, execSpec }));

    void codex.exited.then(exit => {
      if (!closing) {
        bridge.close(
          exit.error
            ? `Codex process failed: ${exit.error.message}`
            : `Codex process exited (code=${String(exit.code)}, signal=${String(exit.signal)})`,
        );
      }
    });

    return {
      model,
      cwd: options.cwd,
      mcpUrl: surface.mcpUrl,
      providerBaseUrl: surface.providerBaseUrl,
      execSpec,
      codexExited: codex.exited,
      async close() {
        if (closing) return;
        closing = true;
        bridge.close("Sideband shutting down");

        const exitedNaturally = await Promise.race([
          codex.exited.then(() => true),
          delay(750).then(() => false),
        ]);
        if (!exitedNaturally) codex.terminate();

        await surface.close();
      },
    };
  } catch (error) {
    closing = true;
    bridge.close("Sideband startup failed");
    codex.terminate();
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
