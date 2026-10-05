import type { CodexBridgeEvent } from "./bridge.js";

export type SidebandRuntimeComponent = "mcp" | "codex" | "tunnel";
export type SidebandRuntimeComponentState = "starting" | "ready" | "stopped" | "error";

export type SidebandRuntimeEvent =
  | CodexBridgeEvent
  | {
      type: "component";
      component: SidebandRuntimeComponent;
      state: SidebandRuntimeComponentState;
      detail?: string;
    };

