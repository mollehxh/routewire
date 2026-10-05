import {createElement} from "react";
import {render as renderInk, type Instance as InkInstance} from "ink";

import {
  catalogEntry,
  type CodexModelCatalogEntry,
} from "./model-catalog.js";
import type { RunwireRuntimeEvent } from "./runtime-events.js";
import {RunwireInkApp, type RunwireInkState} from "./tui-ink.js";
import {
  hasStoredApiKey,
  loadRunwireSettings,
  saveApiKey,
  saveRunwireSettings,
  type RunwireSettings,
} from "./tui-settings.js";

const CSI = "\u001b[";
const RESET = `${CSI}0m`;

export type RunwireRuntimeState = "stopped" | "starting" | "running" | "stopping" | "error";
type View =
  | "menu"
  | "settings"
  | "settings_connection"
  | "settings_codex"
  | "agent_models"
  | "activity";
type EditingField = "tunnelId" | "apiKey";

type ActivityKind =
  | "shell"
  | "read"
  | "edit"
  | "image"
  | "terminal"
  | "script"
  | "ui"
  | "tool"
  | "spawn"
  | "message"
  | "followup"
  | "interrupt"
  | "skill"
  | "done";

interface Activity {
  callId: string;
  namespace: string;
  name: string;
  kind: ActivityKind;
  target: string;
  detail?: string;
  startedAt: number;
  durationMs?: number;
  isError?: boolean;
  output?: string;
  agentTaskName?: string;
}

interface AgentActivity {
  taskName: string;
  model: string;
  reasoning: string;
  status: "starting" | "working" | "done" | "interrupted" | "error";
  startedAt: number;
  durationMs?: number;
}

export interface RunwireTuiOptions {
  cwd: string;
  model: string;
  modelCatalog: readonly CodexModelCatalogEntry[];
  loadModelCatalog?: () => readonly CodexModelCatalogEntry[];
  initialSettings?: Partial<RunwireSettings>;
  externalApiKey?: boolean;
  output?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  onStart?: (settings: RunwireSettings) => void;
  onStop?: () => void;
  onQuit?: () => void;
}

export class RunwireTui {
  readonly #cwd: string;
  readonly #model: string;
  #modelCatalog: readonly CodexModelCatalogEntry[];
  readonly #loadModelCatalog?: () => readonly CodexModelCatalogEntry[];
  readonly #output: NodeJS.WriteStream;
  readonly #input: NodeJS.ReadStream;
  readonly #onStart?: (settings: RunwireSettings) => void;
  readonly #onStop?: () => void;
  readonly #onQuit?: () => void;
  readonly #components = new Map<string, string>();
  readonly #active = new Map<string, Activity>();
  readonly #recent: Activity[] = [];
  readonly #agents = new Map<string, AgentActivity>();
  readonly #settings: RunwireSettings;
  #apiKeyConfigured: boolean;
  #runtimeState: RunwireRuntimeState = "stopped";
  #runtimeMessage = "";
  #appliedSettings = "";
  #credentialDirty = false;
  #view: View = "menu";
  #selection = 0;
  #editing?: EditingField;
  #inputBuffer = "";
  #started = false;
  #ink?: InkInstance;

  constructor(options: RunwireTuiOptions) {
    this.#cwd = options.cwd;
    this.#model = options.model;
    this.#modelCatalog = options.modelCatalog;
    this.#loadModelCatalog = options.loadModelCatalog;
    this.#output = options.output ?? process.stdout;
    this.#input = options.input ?? process.stdin;
    this.#onStart = options.onStart;
    this.#onStop = options.onStop;
    this.#onQuit = options.onQuit;
    const storedSettings = loadRunwireSettings();
    this.#settings = normalizeSettings({
      ...storedSettings,
      ...options.initialSettings,
      allowedSubagentModels:
        options.initialSettings?.allowedSubagentModels ?? storedSettings.allowedSubagentModels,
    });
    this.#apiKeyConfigured = options.externalApiKey === true || hasStoredApiKey();
  }

  settings(): RunwireSettings {
    return structuredClone(this.#settings);
  }

  setRuntimeState(state: RunwireRuntimeState, message = ""): void {
    if (state === "starting" && this.#runtimeState !== "starting") {
      this.#components.clear();
      this.#active.clear();
      this.#recent.splice(0);
      this.#agents.clear();
    }
    this.#runtimeState = state;
    this.#runtimeMessage = message;
    if (state === "running") {
      this.#appliedSettings = settingsFingerprint(this.#settings);
      this.#credentialDirty = false;
    }
    this.render();
  }

  handle(event: RunwireRuntimeEvent): void {
    if (event.type === "component") {
      this.#components.set(event.component, event.state);
      this.render();
      return;
    }

    if (event.type === "agent_message") {
      this.#completeAgentFromMessage(event.text, false);
      this.render();
      return;
    }

    if (this.#components.get("codex") !== "ready") return;

    if (event.type === "call_started") {
      if (event.namespace === "collaboration" && event.name === "spawn_agent") {
        const taskName = agentTaskReference(stringArg(event.arguments, "task_name") ?? "agent");
        this.#removeAgentActivity(taskName);
      }
      const activity = describeActivityEvent(event);
      if (activity) {
        this.#active.set(event.callId, activity);
      }
      if (event.namespace === "collaboration" && event.name === "spawn_agent") {
        const taskName = agentTaskReference(stringArg(event.arguments, "task_name") ?? "agent");
        const childModel = stringArg(event.arguments, "model") ?? "inherit";
        this.#agents.set(taskName, {
          taskName,
          model: childModel,
          reasoning: stringArg(event.arguments, "reasoning_effort") ?? "inherit",
          status: "starting",
          startedAt: event.startedAt,
        });
      } else if (event.namespace === "collaboration" && event.name === "followup_task") {
        const taskName = agentTaskReference(stringArg(event.arguments, "target") ?? "agent");
        const agent = this.#agents.get(taskName);
        if (agent) {
          const wasActive = agent.status === "starting" || agent.status === "working";
          agent.status = "working";
          if (!wasActive) {
            agent.startedAt = event.startedAt;
            agent.durationMs = undefined;
          }
        }
      }
      this.render();
      return;
    }

    const active = this.#active.get(event.callId);
    const spawnFailed =
      event.namespace === "collaboration" &&
      event.name === "spawn_agent" &&
      (event.isError || collaborationOutputFailed(event.output));
    if (active) {
      active.durationMs = event.durationMs;
      active.isError = event.isError || spawnFailed;
      active.output = event.output;
      this.#active.delete(event.callId);
      this.#recent.unshift(active);
      this.#recent.splice(40);
    }

    if (event.namespace === "collaboration" && event.name === "spawn_agent" && active) {
      const taskName = active.target;
      const agent = this.#agents.get(taskName);
      if (agent) {
        if (spawnFailed) {
          agent.status = "error";
          agent.durationMs = Date.now() - agent.startedAt;
        } else if (agent.status === "starting") {
          agent.status = "working";
        }
      }
    }

    if (event.namespace === "collaboration" && event.name === "wait_agent" && event.output) {
      this.#completeAgentFromMessage(event.output, event.isError);
    }
    if (event.namespace === "collaboration" && event.name === "interrupt_agent") {
      const taskName = active?.agentTaskName;
      const agent = taskName ? this.#agents.get(taskName) : undefined;
      if (agent && !event.isError) {
        agent.status = "interrupted";
        agent.durationMs = Date.now() - agent.startedAt;
      }
    }
    this.render();
  }

  #removeAgentActivity(taskName: string): void {
    for (const [callId, item] of this.#active) {
      if (item.agentTaskName === taskName && item.name === "spawn_agent") this.#active.delete(callId);
    }
    for (let index = this.#recent.length - 1; index >= 0; index -= 1) {
      const item = this.#recent[index];
      if (item?.agentTaskName === taskName && item.name === "spawn_agent") this.#recent.splice(index, 1);
    }
  }

  #completeAgentFromMessage(text: string, isError: boolean): void {
    const sender = agentSenderTaskName(text);
    if (!sender) return;
    for (const [taskName, agent] of this.#agents) {
      if (sender !== taskName) continue;
      if (!isError && !/Message Type:\s*FINAL_ANSWER/i.test(text)) continue;
      if (agent.status !== "starting" && agent.status !== "working") continue;
      agent.status = isError ? "error" : "done";
      agent.durationMs = Date.now() - agent.startedAt;
      this.#recent.unshift({
        callId: `agent-done:${taskName}:${Date.now()}`,
        namespace: "collaboration",
        name: "agent_message",
        kind: "done",
        target: taskName,
        detail: [agent.model, agent.reasoning].filter(Boolean).join("  "),
        startedAt: Date.now(),
        durationMs: agent.durationMs,
        isError,
        output: text,
        agentTaskName: taskName,
      });
      this.#recent.splice(40);
    }
  }

  start(): void {
    if (this.#started || !this.#output.isTTY) return;
    this.#started = true;
    this.#output.write(`${CSI}?1049h${CSI}?25l${CSI}2J${CSI}H`);
    process.on("exit", this.#restoreTerminal);
    this.#ink = renderInk(
      createElement(RunwireInkApp, {state: this.#snapshot(), onKey: this.#onInkKey}),
      {
        stdout: this.#output,
        stdin: this.#input,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
        maxFps: 30,
      },
    );
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    const ink = this.#ink;
    this.#ink = undefined;
    ink?.unmount();
    process.off("exit", this.#restoreTerminal);
    this.#restoreTerminal();
  }

  render(): void {
    if (!this.#started || !this.#output.isTTY) return;
    this.#ink?.rerender(
      createElement(RunwireInkApp, {state: this.#snapshot(), onKey: this.#onInkKey}),
    );
  }

  #runtimeDirty(): boolean {
    return this.#runtimeState === "running" && (
      this.#credentialDirty || this.#appliedSettings !== settingsFingerprint(this.#settings)
    );
  }

  readonly #onInkKey = (key: string) => this.#handleKey(key);
  readonly #restoreTerminal = () => {
    if (this.#output.isTTY) this.#output.write(`${RESET}${CSI}?25h${CSI}?1049l`);
  };

  #snapshot(): RunwireInkState {
    return {
      cwd: this.#cwd,
      model: this.#model,
      modelCatalog: this.#agentModelCatalog().map(entry => ({...entry, efforts: [...entry.efforts]})),
      runtimeState: this.#runtimeState,
      runtimeMessage: this.#runtimeMessage,
      runtimeDirty: this.#runtimeDirty(),
      view: this.#view,
      selection: this.#selection,
      editing: this.#editing,
      inputBuffer: this.#inputBuffer,
      settings: structuredClone(this.#settings),
      apiKeyConfigured: this.#apiKeyConfigured,
      components: new Map(this.#components),
      active: [...this.#active.values()].map(item => ({...item})),
      recent: this.#recent.map(item => ({...item})),
      agents: [...this.#agents.values()].map(agent => ({...agent})),
    };
  }

  #handleKey(key: string): void {
    if (this.#editing) {
      this.#handleTextInput(key);
      return;
    }
    if (key === "\u0003" || key === "q") {
      this.#onQuit?.();
      return;
    }
    if (key === "\u001b") {
      this.#back();
      return;
    }

    if (this.#view === "menu") this.#handleMenuKey(key);
    else if (this.#view === "settings") this.#handleSettingsMenuKey(key);
    else if (this.#view === "settings_connection") this.#handleConnectionSettingsKey(key);
    else if (this.#view === "settings_codex") this.#handleCodexSettingsKey(key);
    else if (this.#view === "agent_models") this.#handleAgentModelsKey(key);
    else if (this.#view === "activity") this.#handleActivityKey(key);
  }

  #handleMenuKey(key: string): void {
    const count = 4;
    if (isUp(key)) this.#selection = wrap(this.#selection - 1, count);
    else if (isDown(key)) this.#selection = wrap(this.#selection + 1, count);
    else if (isEnter(key)) {
      if (this.#selection === 0) {
        if (this.#runtimeState === "running" && !this.#runtimeDirty()) this.#onStop?.();
        else if (this.#runtimeState !== "starting" && this.#runtimeState !== "stopping") {
          this.#onStart?.(this.settings());
        }
      }
      if (this.#selection === 1) this.#open("settings");
      if (this.#selection === 2) this.#open("activity");
      if (this.#selection === 3) this.#onQuit?.();
    }
    this.render();
  }

  #handleSettingsMenuKey(key: string): void {
    const count = 2;
    if (isUp(key)) this.#selection = wrap(this.#selection - 1, count);
    else if (isDown(key)) this.#selection = wrap(this.#selection + 1, count);
    else if (isEnter(key)) {
      if (this.#selection === 0) this.#open("settings_connection");
      else if (this.#selection === 1) this.#open("settings_codex");
    }
    this.render();
  }

  #handleConnectionSettingsKey(key: string): void {
    const count = 2;
    if (isUp(key)) this.#selection = wrap(this.#selection - 1, count);
    else if (isDown(key)) this.#selection = wrap(this.#selection + 1, count);
    else if (isEnter(key)) {
      if (this.#selection === 0) {
        this.#editing = "tunnelId";
        this.#inputBuffer = this.#settings.tunnelId;
      } else if (this.#selection === 1) {
        this.#editing = "apiKey";
        this.#inputBuffer = "";
      }
    }
    this.render();
  }

  #handleCodexSettingsKey(key: string): void {
    const count = 3;
    if (isUp(key)) this.#selection = wrap(this.#selection - 1, count);
    else if (isDown(key)) this.#selection = wrap(this.#selection + 1, count);
    else if (isLeft(key) || isRight(key) || isEnter(key)) {
      const direction = isLeft(key) ? -1 : 1;
      if (this.#selection === 0) {
        this.#settings.sandboxMode = cycle(
          ["read-only", "workspace-write", "danger-full-access"] as const,
          this.#settings.sandboxMode,
          direction,
        );
        this.#settings.approvalPolicy = "never";
        this.#persistSettings();
      } else if (this.#selection === 1) {
        this.#settings.fastMode = !this.#settings.fastMode;
        this.#persistSettings();
      } else if (this.#selection === 2 && isEnter(key)) {
        this.#open("agent_models");
      }
    }
    this.render();
  }

  #handleAgentModelsKey(key: string): void {
    const catalog = this.#agentModelCatalog();
    const count = catalog.length;
    if (count === 0) return;
    if (isUp(key)) this.#selection = wrap(this.#selection - 1, count);
    else if (isDown(key)) this.#selection = wrap(this.#selection + 1, count);
    else {
      const entry = catalog[this.#selection];
      if (!entry) return;
      if (key === " " || isEnter(key)) {
        this.#toggleSubagentModel(entry.id);
        this.#selection = Math.min(this.#selection, Math.max(0, this.#agentModelCatalog().length - 1));
        this.#persistSettings();
      }
    }
    this.render();
  }

  #handleActivityKey(key: string): void {
    void key;
    this.render();
  }

  #handleTextInput(key: string): void {
    if (key === "\u001b") {
      this.#editing = undefined;
      this.#inputBuffer = "";
      this.render();
      return;
    }
    if (isEnter(key)) {
      if (this.#editing === "tunnelId") {
        this.#settings.tunnelId = this.#inputBuffer.trim();
        this.#persistSettings();
      } else if (this.#editing === "apiKey" && this.#inputBuffer.trim()) {
        try {
          saveApiKey(this.#inputBuffer);
          this.#apiKeyConfigured = true;
          if (this.#runtimeState === "running") this.#credentialDirty = true;
          this.#runtimeMessage = "";
        } catch (error) {
          this.#runtimeMessage = error instanceof Error ? error.message : String(error);
        }
      }
      this.#editing = undefined;
      this.#inputBuffer = "";
      this.render();
      return;
    }
    if (key === "\u007f" || key === "\b") {
      this.#inputBuffer = this.#inputBuffer.slice(0, -1);
    } else if (/^[\x20-\x7E]$/.test(key)) {
      this.#inputBuffer += key;
    }
    this.render();
  }

  #toggleSubagentModel(model: string): void {
    const selected = new Set(this.#settings.allowedSubagentModels);
    if (selected.has(model)) selected.delete(model);
    else selected.add(model);
    this.#settings.allowedSubagentModels = [...selected];
  }

  #agentModelCatalog(): readonly CodexModelCatalogEntry[] {
    const knownModels = new Set(this.#modelCatalog.map(entry => entry.id));
    const missing = this.#settings.allowedSubagentModels
      .filter(model => !knownModels.has(model))
      .map((model): CodexModelCatalogEntry => ({
        id: model,
        displayName: model,
        description: "Saved selection; model metadata is currently unavailable",
        efforts: [],
        defaultEffort: "high",
        fastMode: false,
      }));
    return [...this.#modelCatalog, ...missing];
  }

  #persistSettings(): void {
    try {
      saveRunwireSettings(this.#settings);
      this.#runtimeMessage = "";
    } catch (error) {
      this.#runtimeMessage = error instanceof Error ? error.message : String(error);
    }
  }

  #open(view: View): void {
    if (view === "settings_codex" || view === "agent_models") this.#refreshModelCatalog();
    this.#view = view;
    this.#selection = 0;
  }

  #refreshModelCatalog(): void {
    if (!this.#loadModelCatalog) return;
    const next = this.#loadModelCatalog();
    if (next.length === 0) return;
    this.#modelCatalog = next;
  }

  #back(): void {
    if (this.#view === "menu") return;
    if (this.#view === "agent_models") this.#view = "settings_codex";
    else if (this.#view === "settings_connection" || this.#view === "settings_codex") this.#view = "settings";
    else this.#view = "menu";
    this.#selection = 0;
    this.render();
  }

}

export function describeActivityEvent(
  event: Extract<RunwireRuntimeEvent, { type: "call_started" }>,
): Activity | undefined {
  if (event.namespace === "runwire" && event.name === "get_skill") {
    const names = Array.isArray(event.arguments?.names)
      ? event.arguments.names.filter((value): value is string => typeof value === "string")
      : [];
    return {
      callId: event.callId,
      namespace: event.namespace,
      name: event.name,
      kind: "skill",
      target: names.length > 0 ? names.join(", ") : "skill",
      startedAt: event.startedAt,
    };
  }
  if (event.namespace === "collaboration") return describeCollaborationEvent(event);
  if (!event.input) return undefined;
  if (isInternalRunwireCode(event.input)) return undefined;

  const projected = parseProjectedInvocation(event.input);
  if (projected) {
    return activityFromTool(event, projected.name, projected.arguments);
  }

  const calls = extractToolCalls(event.input);
  if (calls.length === 1) {
    return activityFromTool(event, calls[0] ?? "tool", undefined, event.input);
  }
  if (calls.length > 1) {
    const names = [...new Set(calls.map(friendlyToolName))];
    const target = names.length <= 2 ? names.join(" + ") : `${names.slice(0, 2).join(" + ")} +${names.length - 2}`;
    return {
      callId: event.callId,
      namespace: event.namespace,
      name: event.name,
      kind: "script",
      target,
      detail: `${calls.length} tool calls`,
      startedAt: event.startedAt,
    };
  }

  return {
    callId: event.callId,
    namespace: event.namespace,
    name: event.name,
    kind: "script",
    target: "Code Mode",
    detail: "JavaScript executed inside the Codex tool runtime",
    startedAt: event.startedAt,
  };
}

function describeCollaborationEvent(
  event: Extract<RunwireRuntimeEvent, { type: "call_started" }>,
): Activity | undefined {
  if (event.name === "wait_agent" || event.name === "list_agents") return undefined;
  const task = agentTaskReference(
    stringArg(event.arguments, "task_name") ?? stringArg(event.arguments, "target") ?? "agent",
  );
  const model = stringArg(event.arguments, "model");
  const effort = stringArg(event.arguments, "reasoning_effort");
  const kind: ActivityKind = event.name === "spawn_agent"
    ? "spawn"
    : event.name === "interrupt_agent"
      ? "interrupt"
      : event.name === "send_message"
        ? "message"
        : event.name === "followup_task"
          ? "followup"
          : "tool";
  return {
    callId: event.callId,
    namespace: event.namespace,
    name: event.name,
    kind,
    target: task,
    detail: [model, effort].filter(Boolean).join("  ") || undefined,
    startedAt: event.startedAt,
    agentTaskName: task,
  };
}

function isInternalRunwireCode(code: string): boolean {
  return (
    code.includes("const __runwireInventory = ALL_TOOLS") ||
    code.includes("const __runwireSkillTools = ALL_TOOLS") ||
    code.includes("const __runwireCatalog = __runwireNative") ||
    code.includes("const __runwireContent = String(__runwireNative")
  );
}

function parseProjectedInvocation(code: string): { name: string; arguments: unknown } | undefined {
  const match = code.match(
    /const __runwireNativeResult = await tools\[("(?:\\.|[^"\\])*")\]\(([^\n]*)\);/,
  );
  if (!match?.[1] || match[2] === undefined) return undefined;
  try {
    return { name: JSON.parse(match[1]) as string, arguments: JSON.parse(match[2]) as unknown };
  } catch {
    return undefined;
  }
}

function activityFromTool(
  event: Extract<RunwireRuntimeEvent, { type: "call_started" }>,
  rawName: string,
  arguments_: unknown,
  source = "",
): Activity {
  const name = friendlyToolName(rawName);
  const record = isPlainRecord(arguments_) ? arguments_ : undefined;
  let kind: ActivityKind = "tool";
  let target = name;
  let detail: string | undefined;

  if (/exec_command$/i.test(rawName)) {
    const command = stringValue(record?.cmd) ?? extractCommand(source) ?? "shell command";
    kind = looksLikeReadCommand(command) ? "read" : "shell";
    target = firstLine(command);
    const workdir = stringValue(record?.workdir);
    if (workdir) detail = `in ${workdir}`;
  } else if (/apply_patch$/i.test(rawName)) {
    const patch = typeof arguments_ === "string" ? arguments_ : stringValue(record?.patch) ?? source;
    const files = extractPatchFiles(patch);
    kind = "edit";
    target = files.length === 1 ? files[0] ?? "patch" : files.length > 1 ? `${files.length} files` : "patch";
    detail = files.length > 1 ? files.join(", ") : undefined;
  } else if (/view_image$/i.test(rawName)) {
    kind = "image";
    target = stringValue(record?.path) ?? extractStringField(source, "path") ?? "image";
  } else if (/write_stdin$/i.test(rawName)) {
    kind = "terminal";
    const session = numberValue(record?.session_id) ?? extractNumberField(source, "session_id");
    target = session === undefined ? "terminal session" : `session ${session}`;
    const chars = stringValue(record?.chars);
    if (chars) detail = chars === "\u0003" ? "send Ctrl+C" : `write ${printableInput(chars)}`;
  } else if (/cua_repl__js$/i.test(rawName)) {
    kind = "ui";
    target = stringValue(record?.title) ?? "Computer Use";
    detail = firstLine(stringValue(record?.code) ?? "");
  } else if (/node_repl__js$/i.test(rawName)) {
    kind = "script";
    target = stringValue(record?.title) ?? "Node REPL";
    detail = firstLine(stringValue(record?.code) ?? "");
  } else if (/cua_repl/i.test(rawName)) {
    kind = "ui";
    target = name;
  }

  return {
    callId: event.callId,
    namespace: event.namespace,
    name: event.name,
    kind,
    target: truncate(target, 120),
    detail: detail ? truncate(detail, 180) : undefined,
    startedAt: event.startedAt,
  };
}

function extractToolCalls(code: string): string[] {
  const names: string[] = [];
  for (const match of code.matchAll(/\btools\.([A-Za-z0-9_]+)/g)) if (match[1]) names.push(match[1]);
  for (const match of code.matchAll(/\btools\[["']([^"']+)["']\]/g)) if (match[1]) names.push(match[1]);
  return names;
}

function friendlyToolName(name: string): string {
  if (/exec_command$/i.test(name)) return "exec_command";
  if (/apply_patch$/i.test(name)) return "apply_patch";
  if (/view_image$/i.test(name)) return "view_image";
  if (/write_stdin$/i.test(name)) return "write_stdin";
  if (/cua_repl__js$/i.test(name)) return "computer_use";
  if (/node_repl__js$/i.test(name)) return "node_repl";
  return name.split("__").at(-1) ?? name;
}

function looksLikeReadCommand(command: string): boolean {
  return /^(?:cat\b|sed\b|rg\b|grep\b|find\b|ls\b|head\b|tail\b|git\s+(?:status|diff|show|log)\b)/i.test(command.trim());
}

function extractPatchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)]
    .map(match => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function extractCommand(code: string): string | undefined {
  const match = code.match(/["']?cmd["']?\s*:\s*(["'`])([^\n]*?)\1/);
  return match?.[2];
}

function extractStringField(code: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = code.match(new RegExp(`["']?${escaped}["']?\\s*:\\s*(["'\\x60])([^\\n]*?)\\1`));
  return match?.[2];
}

function extractNumberField(code: string, field: string): number | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = code.match(new RegExp(`["']?${escaped}["']?\\s*:\\s*(\\d+)`));
  return match?.[1] ? Number(match[1]) : undefined;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function printableInput(value: string): string {
  const normalized = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return JSON.stringify(truncate(normalized, 48));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const item = value?.[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function collaborationOutputFailed(output: string | undefined): boolean {
  if (!output) return false;
  return /(?:collab(?:oration)?\s+spawn\s+failed|fatal error|failed to load model context|spawn_agent.*failed)/i.test(output);
}

export function agentSenderTaskName(text: string): string | undefined {
  const match = text.match(/^Sender:\s*(\/root\/[^\s]+)\s*$/m);
  return match?.[1] ? agentTaskReference(match[1]) : undefined;
}

export function agentTaskReference(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/root/") ? trimmed.slice("/root/".length) : trimmed;
}

function settingsFingerprint(settings: RunwireSettings): string {
  return JSON.stringify(settings);
}

function normalizeSettings(
  settings: RunwireSettings,
): RunwireSettings {
  return {
    ...settings,
    approvalPolicy: "never",
    allowedSubagentModels: [...new Set(settings.allowedSubagentModels)],
  };
}

function cycle<T>(values: readonly T[], current: T, direction: number): T {
  const index = Math.max(0, values.indexOf(current));
  return values[wrap(index + direction, values.length)] ?? current;
}

function wrap(value: number, length: number): number {
  return (value + length) % length;
}

function isUp(key: string): boolean {
  return key === "\u001b[A" || key === "k";
}
function isDown(key: string): boolean {
  return key === "\u001b[B" || key === "j";
}
function isLeft(key: string): boolean {
  return key === "\u001b[D" || key === "h";
}
function isRight(key: string): boolean {
  return key === "\u001b[C" || key === "l";
}
function isEnter(key: string): boolean {
  return key === "\r" || key === "\n";
}


function truncate(value: string, max: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= max) return value;
  if (max <= 1) return "…";
  return `${plain.slice(0, max - 1)}…`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
