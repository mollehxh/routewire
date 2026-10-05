import type { CodexBridgeEvent } from "./bridge.js";

export type RoutewireRuntimeComponent = "mcp" | "codex" | "tunnel";
export type RoutewireRuntimeComponentState = "starting" | "ready" | "stopped" | "error";

export type RoutewireRuntimeEvent =
  | CodexBridgeEvent
  | {
      type: "component";
      component: RoutewireRuntimeComponent;
      state: RoutewireRuntimeComponentState;
      detail?: string;
    };

