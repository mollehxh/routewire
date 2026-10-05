import type { CodexBridgeEvent } from "./bridge.js";

export type RunwireRuntimeComponent = "mcp" | "codex" | "tunnel";
export type RunwireRuntimeComponentState = "starting" | "ready" | "stopped" | "error";

export type RunwireRuntimeEvent =
  | CodexBridgeEvent
  | {
      type: "component";
      component: RunwireRuntimeComponent;
      state: RunwireRuntimeComponentState;
      detail?: string;
    };

