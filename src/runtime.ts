import { CodexTurnBridge } from "./bridge.js";
import { startCodexProcess, type CodexExit } from "./codex/process.js";
import { RoutewireHttpSurface } from "./http-surface.js";
import { selectCollaborationTools } from "./mcp/collaboration-tools.js";
import { discoverProjectedNativeTools, projectedToolsFingerprint } from "./mcp/projected-tools.js";
import { createRoutewireMcpServer, updateRoutewireProjectedTools } from "./mcp/server.js";
import { discoverNativeSkillTools } from "./mcp/skill-tools.js";
import {
  loadCodexModelCatalog,
  type CodexModelCatalogEntry,
} from "./model-catalog.js";
import type { ExecToolSpec } from "./provider/protocol.js";
import type { RoutewireRuntimeEvent } from "./runtime-events.js";
import type { CodexApprovalPolicy, CodexSandboxMode } from "./tui-settings.js";
import { ensureTunnelClient } from "./tunnel/install.js";
import { startTunnelClient, type StartTunnelClientOptions, type TunnelClientHandle } from "./tunnel/process.js";

export type RoutewireTunnelOptions = Omit<StartTunnelClientOptions, "mcpUrl">;

export interface StartRoutewireOptions {
  cwd: string;
  model?: string;
  host?: string;
  port?: number;
  codexHome?: string;
  dangerFullAccess?: boolean;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  fastMode?: boolean;
  allowedSubagentModels?: readonly string[];
  modelCatalog?: readonly CodexModelCatalogEntry[];
  quietCodex?: boolean;
  codexCommand?: string;
  startupTimeoutMs?: number;
  tunnel?: RoutewireTunnelOptions;
  onEvent?: (event: RoutewireRuntimeEvent) => void;
}

export interface RoutewireRuntime {
  readonly model: string;
  readonly cwd: string;
  readonly mcpUrl: string;
  readonly providerBaseUrl: string;
  readonly execSpec: ExecToolSpec;
  readonly tunnelHealthUrl?: string;
  readonly codexExited: Promise<CodexExit>;
  close(): Promise<void>;
}

export async function startRoutewire(options: StartRoutewireOptions): Promise<RoutewireRuntime> {
  const model = options.model ?? "gpt-5.6-sol";
  const modelCatalog = options.modelCatalog ?? loadCodexModelCatalog(options.codexHome);
  const allowedSubagentModels = options.allowedSubagentModels ?? ["gpt-6-luna"];
  const subagentModelEfforts = Object.fromEntries(
    modelCatalog.map(entry => [entry.id, entry.efforts] as const),
  );
  const emit = (event: RoutewireRuntimeEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Runtime observers must not affect transport or Codex lifecycle behavior.
    }
  };
  const bridge = new CodexTurnBridge({ model, onEvent: emit });
  const surface = new RoutewireHttpSurface({
    bridge,
    host: options.host,
    port: options.port,
    allowedSubagentModels,
    subagentModelEfforts,
    onEvent: emit,
  });
  emit({ type: "component", component: "mcp", state: "starting" });
  await surface.start();
  emit({ type: "component", component: "mcp", state: "ready", detail: surface.mcpUrl });

  emit({ type: "component", component: "codex", state: "starting" });
  const codex = startCodexProcess({
    cwd: options.cwd,
    model,
    providerBaseUrl: surface.providerBaseUrl,
    codexHome: options.codexHome,
    dangerFullAccess: options.dangerFullAccess,
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    fastMode: options.fastMode,
    quiet: options.quietCodex,
    command: options.codexCommand,
  });

  let closing = false;
  let startupComplete = false;
  let tunnel: TunnelClientHandle | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      // Every resource gets cleanup even if another cleanup rejects.
      const tunnelClose = Promise.allSettled([tunnel?.close()]);
      bridge.close("Routewire shutting down");
      const exitedNaturally = await Promise.race([codex.exited.then(() => true), delay(750).then(() => false)]);
      if (!exitedNaturally) {
        codex.terminate();
        const terminated = await Promise.race([codex.exited.then(() => true), delay(1_000).then(() => false)]);
        if (!terminated) {
          codex.forceTerminate();
          await Promise.race([codex.exited, delay(1_000)]);
        }
      }
      const results = (await Promise.all([tunnelClose, Promise.allSettled([surface.close()])])).flat();
      if (tunnel) emit({ type: "component", component: "tunnel", state: "stopped" });
      emit({ type: "component", component: "codex", state: "stopped" });
      emit({ type: "component", component: "mcp", state: "stopped" });
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return closePromise;
  };
  // Observe exits before the first provider request, including discovery.
  const codexExitWatch = codex.exited.then(exit => {
    if (!closing) {
      const error = startupComplete
        ? new Error(exit.error?.message ?? `Codex process exited (code=${String(exit.code)}, signal=${String(exit.signal)})`)
        : codexExitedBeforeReady(exit);
      emit({ type: "component", component: "codex", state: "error", detail: error.message });
      bridge.close(error.message);
      if (startupComplete) void close().catch(error => emit({
        type: "component", component: "mcp", state: "error", detail: String(error),
      }));
    }
    return exit;
  });
  let startupTimer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    startupTimer = setTimeout(() => reject(new Error("Routewire startup timed out")), options.startupTimeoutMs ?? 60_000);
  });
  const initialize = async (): Promise<RoutewireRuntime> => {
    const execSpec = await bridge.ready();

    let projectedTools = await discoverProjectedNativeTools(bridge);
    const nativeSkillTools = await discoverNativeSkillTools(bridge, {
      cwd: options.cwd,
      codexHome: options.codexHome,
      codexCommand: options.codexCommand,
    });
    if (closing) throw new Error("Routewire startup cancelled");
    const collaborationTools = selectCollaborationTools(bridge.collaborationTools(), {
      allowedModels: allowedSubagentModels,
      catalog: modelCatalog,
    });

    let refresh: Promise<typeof projectedTools> | undefined;
    const refreshProjectedTools = (): Promise<typeof projectedTools> => {
      if (refresh) return refresh;
      if (!bridge.idle || closing) return Promise.resolve(projectedTools);
      refresh = discoverProjectedNativeTools(bridge).then(tools => {
        if (closing) return projectedTools;
        const changed = projectedToolsFingerprint(tools) !== projectedToolsFingerprint(projectedTools);
        if (changed) {
          projectedTools = tools;
          updateRoutewireProjectedTools(mcpServer, tools);
          surface.updateProjectedTools(tools);
        }
        return projectedTools;
      }).catch(error => {
        if (closing) return projectedTools;
        throw error;
      }).finally(() => {refresh = undefined;});
      return refresh;
    };
    const mcpServer = createRoutewireMcpServer({
      bridge, execSpec, projectedTools, nativeSkillTools, collaborationTools, onEvent: emit,
      refreshProjectedTools,
    });
    surface.setMcpServer(mcpServer, execSpec, projectedTools, nativeSkillTools, collaborationTools, refreshProjectedTools);
    emit({ type: "component", component: "codex", state: "ready", detail: model });

    if (options.tunnel) {
      emit({ type: "component", component: "tunnel", state: "starting" });
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
      if (closing) {
        await startupResult.handle.close();
        throw new Error("Routewire startup cancelled");
      }
      tunnel = startupResult.handle;
      emit({
        type: "component",
        component: "tunnel",
        state: "ready",
        detail: tunnel.healthUrl,
      });
      void tunnel.exited.then(exit => {
        if (closing) return;
        emit({
          type: "component",
          component: "tunnel",
          state: "error",
          detail: exit.error?.message ?? `exited with code ${String(exit.code)}`,
        });
      });
      void tunnel.unhealthy.then(error => {
        if (closing) return;
        emit({
          type: "component",
          component: "tunnel",
          state: "error",
          detail: error.message,
        });
      });
    } else {
      emit({ type: "component", component: "tunnel", state: "stopped" });
    }

    return {
      model,
      cwd: options.cwd,
      mcpUrl: surface.mcpUrl,
      providerBaseUrl: surface.providerBaseUrl,
      execSpec,
      tunnelHealthUrl: tunnel?.healthUrl,
      codexExited: codex.exited,
      close,
    };
  };
  try {
    const runtime = await Promise.race([
      initialize(),
      timeout,
      codexExitWatch.then(exit => { throw codexExitedBeforeReady(exit); }),
    ]);
    startupComplete = true;
    return runtime;
  } catch (error) {
    emit({ type: "component", component: "codex", state: "error", detail: String(error) });
    await close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(startupTimer);
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
    return new Error(`Codex failed while Routewire was starting the tunnel: ${exit.error.message}`, {
      cause: exit.error,
    });
  }
  return new Error(
    `Codex exited while Routewire was starting the tunnel (code=${String(exit.code)}, signal=${String(exit.signal)})`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
