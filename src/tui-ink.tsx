import {useEffect, useMemo, useState} from "react";
import {Box, Text, useInput, useStdout} from "ink";

import type {CodexModelCatalogEntry} from "./model-catalog.js";
import type {RunwireSettings} from "./tui-settings.js";

export type InkRuntimeState = "stopped" | "starting" | "running" | "stopping" | "error";
export type InkView =
  | "update_check"
  | "update"
  | "menu"
  | "settings"
  | "settings_connection"
  | "settings_codex"
  | "agent_models"
  | "activity";
export type InkEditingField = "tunnelId" | "apiKey";

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

export interface InkActivity {
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

export interface InkAgentActivity {
  taskName: string;
  model: string;
  reasoning: string;
  status: "starting" | "working" | "done" | "interrupted" | "error";
  startedAt: number;
  durationMs?: number;
}

export interface RunwireInkState {
  cwd: string;
  model: string;
  modelCatalog: readonly CodexModelCatalogEntry[];
  runtimeState: InkRuntimeState;
  runtimeMessage: string;
  runtimeDirty: boolean;
  view: InkView;
  selection: number;
  editing?: InkEditingField;
  inputBuffer: string;
  settings: RunwireSettings;
  apiKeyConfigured: boolean;
  components: Map<string, string>;
  active: InkActivity[];
  recent: InkActivity[];
  agents: InkAgentActivity[];
  update?: {
    currentVersion: string;
    latestVersion: string;
    command: string;
    status: "available" | "installing" | "error";
    message?: string;
  };
}

export interface RunwireInkAppProps {
  state: RunwireInkState;
  onKey: (key: string) => void;
}

export function RunwireInkApp({state, onKey}: RunwireInkAppProps) {
  const {stdout} = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const onResize = () => setTerminalSize({
      columns: stdout.columns ?? 80,
      rows: stdout.rows ?? 24,
    });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const hasLiveTime = state.runtimeState === "starting" ||
    state.runtimeState === "stopping" ||
    state.active.length > 0 ||
    state.agents.some(agent => agent.status === "starting" || agent.status === "working");

  useEffect(() => {
    if (!hasLiveTime) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasLiveTime]);

  useInput((input, key) => {
    if (state.view === "activity") {
      if (key.upArrow || key.downArrow) return;
      if (input.toLowerCase() === "g") return;
    }
    if (key.ctrl && input.toLowerCase() === "c") return onKey("\u0003");
    if (key.upArrow) return onKey("\u001b[A");
    if (key.downArrow) return onKey("\u001b[B");
    if (key.leftArrow) return onKey("\u001b[D");
    if (key.rightArrow) return onKey("\u001b[C");
    if (key.return) return onKey("\r");
    if (key.escape) return onKey("\u001b");
    if (key.backspace || key.delete) return onKey("\u007f");
    for (const char of input) onKey(char);
  });

  if (terminalSize.columns < 60 || terminalSize.rows < 18) {
    return (
      <Box width="100%" height={terminalSize.rows} alignItems="center" justifyContent="center" flexDirection="column">
        <Text bold>runwire</Text>
        <Text dimColor>Terminal too small — resize to at least 60×18.</Text>
      </Box>
    );
  }

  if (state.view === "update_check") {
    return (
      <Box width="100%" height={terminalSize.rows} flexDirection="column" paddingX={2}>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Box flexDirection="column" alignItems="center">
            <Text color={RUNWIRE_ACCENT} bold>{RUNWIRE_MARK}</Text>
            <Text> </Text>
            <Text bold>Checking for updates…</Text>
          </Box>
        </Box>
        <Box justifyContent="center">
          <Footer items={["q quit"]} permissions={state.settings.sandboxMode}/>
        </Box>
      </Box>
    );
  }

  if (state.view === "update" && state.update) {
    return (
      <Box width="100%" height={terminalSize.rows} flexDirection="column" paddingX={2}>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Box width={Math.min(62, terminalSize.columns - 6)} flexDirection="column">
            <UpdateView state={state}/>
          </Box>
        </Box>
        <Box justifyContent="center">
          <Footer
            items={state.update.status === "installing"
              ? ["installing update…", "q quit"]
              : ["↑↓ move", "enter select", "q quit"]}
            permissions={state.settings.sandboxMode}
          />
        </Box>
      </Box>
    );
  }

  if (state.view === "activity") {
    return (
      <Box width="100%" height={terminalSize.rows} flexDirection="column" paddingX={2} paddingTop={1}>
        <ActivityView
          state={state}
          now={now}
          terminalRows={terminalSize.rows}
          terminalColumns={terminalSize.columns}
        />
      </Box>
    );
  }

  if (state.view === "menu") {
    const width = Math.min(66, terminalSize.columns - 6);
    const action = mainAction(state);
    const enterAction = state.selection === 0
      ? action.replace("…", "")
      : state.selection === 3
        ? "Quit"
        : "Open";
    return (
      <Box width="100%" height={terminalSize.rows} flexDirection="column" paddingX={2}>
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Box width={width} flexDirection="column">
            <MenuView state={state}/>
          </Box>
        </Box>
        <Box justifyContent="center">
          <Footer
            items={["↑↓ move", `enter ${enterAction.toLowerCase()}`, "q quit"]}
            permissions={state.settings.sandboxMode}
          />
        </Box>
      </Box>
    );
  }

  if (isSettingsWorkspaceView(state.view)) {
    return (
      <Box width="100%" height={terminalSize.rows} flexDirection="column" paddingX={2} paddingTop={1}>
        <SettingsWorkspace state={state}/>
      </Box>
    );
  }

  return null;
}

function UpdateView({state}: {state: RunwireInkState}) {
  const update = state.update!;
  const installing = update.status === "installing";
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color={RUNWIRE_ACCENT} bold>{RUNWIRE_MARK}</Text>
      <Text> </Text>
      <Text bold>Update available</Text>
      <Text><Text dimColor>{update.currentVersion}</Text>  →  <Text color={RUNWIRE_ACCENT} bold>{update.latestVersion}</Text></Text>

      <Box width={46} marginTop={2} flexDirection="column">
        {installing ? (
          <MenuRow label={`Installing ${update.latestVersion}…`} selected icon="…"/>
        ) : (
          <>
            <MenuRow label="Update now" selected={state.selection === 0} icon="↑"/>
            <MenuRow
              label={`Continue with ${update.currentVersion}`}
              selected={state.selection === 1}
              icon="→"
            />
          </>
        )}
      </Box>

      <Box width={52} marginTop={1} flexDirection="column">
        <Text dimColor>{installing ? "Running" : "Update command"}</Text>
        <Text color={RUNWIRE_ACCENT}>{update.command}</Text>
        {update.status === "error" && update.message ? (
          <Text color="red">Update failed: {update.message}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

function MenuView({state}: {state: RunwireInkState}) {
  const action = mainAction(state);
  const eventCount = state.active.length + state.recent.length;

  return (
    <Box flexDirection="column" alignItems="center">
      <Box flexDirection="column" alignItems="center">
        <Text color={RUNWIRE_ACCENT} bold>{RUNWIRE_MARK}</Text>
        <Text> </Text>
        <Text bold>R U N W I R E</Text>
        <Text dimColor>Local Codex bridge for ChatGPT</Text>
      </Box>

      <Box width={44} marginTop={3} flexDirection="column">
        <MenuRow label={action} hint="enter" selected={state.selection === 0} icon={mainActionIcon(state)}/>
        <MenuRow label="Settings" selected={state.selection === 1} icon="≡"/>
        <MenuRow
          label="Activity"
          hint={eventCount === 0 ? "no events" : `${eventCount} events`}
          selected={state.selection === 2}
          icon="▤"
        />
        <MenuRow label="Quit" selected={state.selection === 3} icon="×"/>
      </Box>

      {state.runtimeMessage ? (
        <Box width={52} marginTop={1}>
          <Text color={state.runtimeState === "error" ? "red" : undefined}>{state.runtimeMessage}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function SettingsWorkspace({state}: {state: RunwireInkState}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <SettingsBreadcrumb view={state.view}/>
      <Box width={60} marginTop={2} flexDirection="column">
        {state.view === "settings" ? <SettingsMenuView state={state}/> : null}
        {state.view === "settings_connection" ? <ConnectionSettingsView state={state}/> : null}
        {state.view === "settings_codex" ? <CodexSettingsView state={state}/> : null}
        {state.view === "agent_models" ? <AgentModelsView state={state}/> : null}
      </Box>
      <Box flexGrow={1}/>
      <Footer items={settingsFooterItems(state)} permissions={state.settings.sandboxMode}/>
    </Box>
  );
}

function SettingsBreadcrumb({view}: {view: InkView}) {
  const segments = view === "settings"
    ? ["settings"]
    : view === "settings_connection"
      ? ["settings", "connection"]
      : view === "settings_codex"
        ? ["settings", "codex"]
        : ["settings", "codex", "subagent models"];
  return <InternalBreadcrumb segments={segments}/>;
}

function InternalBreadcrumb({
  segments,
  rightText,
}: {
  segments: readonly string[];
  rightText?: string;
}) {
  return (
    <Box
      width="100%"
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderBottomDimColor
      justifyContent="space-between"
    >
      <Box>
        <Text color={RUNWIRE_ACCENT} bold>//&gt;</Text>
        <Text>  </Text>
        {segments.map((segment, index) => (
          <Box key={`${segment}-${index}`}>
            {index > 0 ? <Text dimColor> / </Text> : null}
            <Text bold={index === segments.length - 1} dimColor={index < segments.length - 1}>{segment}</Text>
          </Box>
        ))}
      </Box>
      {rightText ? <Text dimColor>{rightText}</Text> : null}
    </Box>
  );
}

function SettingsMenuView({state}: {state: RunwireInkState}) {
  return (
    <Box width={44} flexDirection="column">
      <SettingsNavRow label="Connection" selected={state.selection === 0}/>
      <SettingsNavRow label="Codex" selected={state.selection === 1}/>
    </Box>
  );
}

function ConnectionSettingsView({state}: {state: RunwireInkState}) {
  return (
    <Box flexDirection="column">
      <SettingsValueRow
        label="Tunnel ID"
        value={state.editing === "tunnelId" ? editValue(state.inputBuffer, false) : state.settings.tunnelId || "Not set"}
        selected={state.selection === 0}
        dimValue={!state.settings.tunnelId && state.editing !== "tunnelId"}
      />
      <SettingsValueRow
        label="API key"
        value={state.editing === "apiKey" ? editValue(state.inputBuffer, true) : state.apiKeyConfigured ? "Configured" : "Missing"}
        selected={state.selection === 1}
        valueColor={!state.apiKeyConfigured && state.editing !== "apiKey" ? "red" : undefined}
        dimValue={state.apiKeyConfigured && state.editing !== "apiKey"}
      />
      {state.runtimeDirty ? <SettingsDirtyNotice/> : null}
    </Box>
  );
}

function CodexSettingsView({state}: {state: RunwireInkState}) {
  return (
    <Box flexDirection="column">
      <SettingsValueRow
        label="Permissions"
        value={sandboxLabel(state.settings.sandboxMode)}
        selected={state.selection === 0}
        adjustable
        valueColor={state.settings.sandboxMode === "danger-full-access" ? "yellow" : undefined}
      />
      <SettingsValueRow label="Fast mode" value={state.settings.fastMode ? "On" : "Off"} selected={state.selection === 1} adjustable/>
      <SettingsValueRow
        label="Subagent models"
        value={`${state.settings.allowedSubagentModels.length}/${state.modelCatalog.length} available`}
        selected={state.selection === 2}
      />
      {state.runtimeDirty ? <SettingsDirtyNotice/> : null}
    </Box>
  );
}

function AgentModelsView({state}: {state: RunwireInkState}) {
  const selected = state.modelCatalog[state.selection];
  const available = state.settings.allowedSubagentModels.length;
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {state.modelCatalog.map((model, index) => {
          const checked = state.settings.allowedSubagentModels.includes(model.id);
          return (
            <SettingsValueRow
              key={model.id}
              label={model.id}
              value={checked ? "Available" : "Blocked"}
              selected={state.selection === index}
              dimValue={!checked}
            />
          );
        })}
      </Box>

      {selected ? (
        <Box marginTop={2} width={60} flexDirection="column">
          {selected.description ? <Text dimColor wrap="wrap">{selected.description}</Text> : null}
          <Text dimColor>{available}/{state.modelCatalog.length} models available to subagents.</Text>
          <Box marginTop={1}>
            <Text color={RUNWIRE_ACCENT} bold>! </Text>
            <Text color={RUNWIRE_ACCENT} bold>Subagents consume your Codex plan usage.</Text>
          </Box>
        </Box>
      ) : null}
      {state.runtimeDirty ? <SettingsDirtyNotice/> : null}
    </Box>
  );
}

function ActivityView({
  state,
  now,
  terminalRows,
  terminalColumns,
}: {
  state: RunwireInkState;
  now: number;
  terminalRows: number;
  terminalColumns: number;
}) {
  const events = useMemo(
    () => [...state.active, ...state.recent].sort((a, b) => a.startedAt - b.startedAt),
    [state.active, state.recent],
  );
  const activeAgents = state.agents.filter(agent => agent.status === "starting" || agent.status === "working");
  const agentPanelWidth = activeAgents.length > 0
    ? Math.min(
        44,
        Math.max(
          34,
          ...activeAgents.map(agent => {
            const elapsed = formatDuration(agent.durationMs ?? Math.max(0, now - agent.startedAt));
            return agent.taskName.length + elapsed.length + 10;
          }),
        ),
      )
    : 0;
  const splitLayout = activeAgents.length > 0 && terminalColumns >= agentPanelWidth + 58;
  const agentRows = !splitLayout && activeAgents.length > 0 ? activeAgents.length + 2 : 0;
  const visibleCount = Math.max(4, terminalRows - 8 - agentRows);
  const maxScrollTop = Math.max(0, events.length - visibleCount);
  const initialScrollTop = state.selection > 0
    ? Math.min(state.selection, maxScrollTop)
    : maxScrollTop;
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [followTail, setFollowTail] = useState(state.selection === 0 || initialScrollTop === maxScrollTop);

  useEffect(() => {
    setScrollTop(current => followTail ? maxScrollTop : Math.min(current, maxScrollTop));
  }, [followTail, maxScrollTop]);

  useInput((input, key) => {
    if (key.upArrow) {
      if (maxScrollTop === 0) return;
      setFollowTail(false);
      setScrollTop(current => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setScrollTop(current => {
        const next = Math.min(maxScrollTop, current + 1);
        if (next === maxScrollTop) setFollowTail(true);
        return next;
      });
      return;
    }
    if (input.toLowerCase() === "g") {
      setFollowTail(true);
      setScrollTop(maxScrollTop);
    }
  });

  const visibleEvents = events.slice(scrollTop, scrollTop + visibleCount);

  const activityColumn = (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1}>
        {events.length === 0 ? (
          <Text dimColor>No activity yet.</Text>
        ) : (
          visibleEvents.map(item => <ActivityRow key={item.callId} item={item} now={now}/>)
        )}
      </Box>
    </Box>
  );

  const agentsPanel = activeAgents.length > 0 ? (
    <Box
      width={Math.min(agentPanelWidth, terminalColumns - 4)}
      flexShrink={0}
      marginTop={splitLayout ? 0 : 1}
      marginLeft={splitLayout ? 1 : 0}
      alignSelf="flex-start"
      borderStyle="round"
      borderDimColor
      paddingX={1}
    >
      <AgentsRail agents={activeAgents} now={now}/>
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <InternalBreadcrumb
        segments={["activity"]}
        rightText={`${events.length} event${events.length === 1 ? "" : "s"}`}
      />
      <Box flexGrow={1} flexDirection="column">
        {splitLayout ? (
          <Box flexDirection="row" flexGrow={1} alignItems="flex-start">
            <Box flexDirection="column" flexGrow={1} paddingRight={2}>
              {activityColumn}
            </Box>
            {agentsPanel}
          </Box>
        ) : (
          <>
            {activityColumn}
            {agentsPanel}
          </>
        )}
      </Box>

      <Footer
        items={["↑↓ scroll", "g latest", "esc back", "q quit"]}
        permissions={state.settings.sandboxMode}
      />
    </Box>
  );
}

function MenuRow({
  label,
  hint,
  selected,
  icon,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  icon: string;
}) {
  return (
    <Box
      width="100%"
      paddingX={1}
      backgroundColor={selected ? RUNWIRE_SELECTION : undefined}
    >
      <Box width={3}><Text color={selected ? RUNWIRE_ACCENT : undefined}>{selected ? "›" : " "}</Text></Box>
      <Box width={3}><Text color={selected ? RUNWIRE_ACCENT : undefined} dimColor={!selected}>{icon}</Text></Box>
      <Box flexGrow={1}><Text color={selected ? RUNWIRE_ACCENT : undefined} bold={selected}>{label}</Text></Box>
      {hint ? <Text color={selected ? RUNWIRE_ACCENT : undefined} dimColor={!selected}>{hint}</Text> : null}
    </Box>
  );
}

function SettingsNavRow({label, selected}: {label: string; selected: boolean}) {
  return (
    <Box width="100%" paddingX={1} backgroundColor={selected ? RUNWIRE_SELECTION : undefined}>
      <Box width={3}><Text color={selected ? RUNWIRE_ACCENT : undefined}>{selected ? "›" : " "}</Text></Box>
      <Text color={selected ? RUNWIRE_ACCENT : undefined} bold={selected}>{label}</Text>
    </Box>
  );
}

function SettingsValueRow({
  label,
  value,
  selected,
  adjustable = false,
  dimValue = false,
  valueColor,
}: {
  label: string;
  value: string;
  selected: boolean;
  adjustable?: boolean;
  dimValue?: boolean;
  valueColor?: string;
}) {
  return (
    <Box width="100%" paddingX={1} backgroundColor={selected ? RUNWIRE_SELECTION : undefined}>
      <Box width={3}><Text color={selected ? RUNWIRE_ACCENT : undefined}>{selected ? "›" : " "}</Text></Box>
      <Box width={24}>
        <Text color={selected ? RUNWIRE_ACCENT : undefined} bold={selected}>{label}</Text>
      </Box>
      <Box flexGrow={1} justifyContent="flex-end">
        {adjustable ? <Text dimColor>‹ </Text> : null}
        <Text color={valueColor ?? (selected ? RUNWIRE_ACCENT : undefined)} dimColor={dimValue}>{value}</Text>
        {adjustable ? <Text dimColor> ›</Text> : null}
      </Box>
    </Box>
  );
}

function SettingsDirtyNotice() {
  return (
    <Box marginTop={2}>
      <Text color={RUNWIRE_ACCENT}>Changes apply after restart.</Text>
    </Box>
  );
}

function isSettingsWorkspaceView(view: InkView): boolean {
  return view === "settings" ||
    view === "settings_connection" ||
    view === "settings_codex" ||
    view === "agent_models";
}

function settingsFooterItems(state: RunwireInkState): string[] {
  if (state.editing) return ["type value", "enter save", "esc cancel"];
  if (state.view === "settings") return ["↑↓ move", "enter open", "esc back", "q quit"];
  if (state.view === "settings_connection") {
    return ["↑↓ move", "enter edit", "esc back", "q quit"];
  }
  if (state.view === "settings_codex") {
    return [
      "↑↓ move",
      state.selection === 2 ? "enter open" : "←→ / enter change",
      "esc back",
      "q quit",
    ];
  }
  return ["↑↓ move", "space/enter toggle", "esc back", "q quit"];
}

function CheckRow({label, checked, selected}: {label: string; checked: boolean; selected: boolean}) {
  return (
    <Box>
      <Marker selected={selected}/>
      <Text bold={selected}>{checked ? "[x]" : "[ ]"} {label}</Text>
    </Box>
  );
}

function ActivityRow({item, now}: {item: InkActivity; now: number}) {
  const running = item.durationMs === undefined;
  const status = running ? "running" : item.isError ? "failed" : "";
  const duration = formatDuration(item.durationMs ?? Math.max(0, now - item.startedAt));
  const kindColor = activityKindColor(item.kind, item.isError);
  const statusColor = item.isError ? ACTIVITY_FAILED : running ? ACTIVITY_RUNNING : undefined;

  return (
    <Box width="100%">
      <Box width={9} flexShrink={0}>
        <Text color={kindColor} bold>{item.kind}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} paddingRight={1}>
        {item.agentTaskName
          ? (
            <Box flexGrow={1} flexShrink={1}>
              <Box width={Math.min(28, item.agentTaskName.length + 2)} flexShrink={0}>
                <AgentIdentity taskName={item.agentTaskName} bold={false} truncate/>
              </Box>
              {item.kind === "spawn" && item.detail ? (
                <Box flexGrow={1} flexShrink={1} marginLeft={1}>
                  <Text dimColor wrap="truncate-end">{item.detail}</Text>
                </Box>
              ) : null}
            </Box>
          )
          : <Text dimColor wrap="truncate-end">{item.target}</Text>}
      </Box>
      <Box width={7} flexShrink={0}>
        <Text color={statusColor} bold={Boolean(status)}>{status}</Text>
      </Box>
      <Box width={8} flexShrink={0} paddingLeft={1}>
        <Text dimColor>{duration}</Text>
      </Box>
    </Box>
  );
}

function AgentsRail({agents, now}: {agents: InkAgentActivity[]; now: number}) {
  return (
    <Box flexDirection="column" width="100%">
      <Box gap={1}>
        <Text color={RUNWIRE_ACCENT} bold>Agents</Text>
        <Text dimColor>{agents.length} active</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {agents.map(agent => <AgentRailRow key={agent.taskName} agent={agent} now={now}/>)}
      </Box>
    </Box>
  );
}

function AgentRailRow({agent, now}: {agent: InkAgentActivity; now: number}) {
  const duration = formatDuration(agent.durationMs ?? Math.max(0, now - agent.startedAt));
  return (
    <Box width="100%">
      <Box flexGrow={1} flexShrink={1} paddingRight={1}>
        <AgentIdentity taskName={agent.taskName} truncate/>
      </Box>
      <Box width={8} flexShrink={0}>
        <Text dimColor>{duration}</Text>
      </Box>
    </Box>
  );
}

function AgentIdentity({
  taskName,
  bold = true,
  truncate = false,
}: {
  taskName: string;
  bold?: boolean;
  truncate?: boolean;
}) {
  const visual = agentVisual(taskName);
  return <Text color={visual.color} bold={bold} wrap={truncate ? "truncate-end" : undefined}>{visual.symbol} {taskName}</Text>;
}

function Marker({selected}: {selected: boolean}) {
  return <Box width={2}><Text>{selected ? "›" : " "}</Text></Box>;
}

function Footer({
  items,
  permissions,
}: {
  items: string[];
  permissions: RunwireSettings["sandboxMode"];
}) {
  return (
    <Box
      width="100%"
      marginTop={1}
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderTopDimColor
      justifyContent="space-between"
    >
      <Box gap={3} flexWrap="wrap" flexShrink={1}>
        {items.map(item => <Text key={item} dimColor>{item}</Text>)}
      </Box>
      <Box marginLeft={2} flexShrink={0}>
        <Text dimColor>permissions  </Text>
        <Text
          color={permissions === "danger-full-access" ? "yellow" : undefined}
          dimColor={permissions !== "danger-full-access"}
          bold={permissions === "danger-full-access"}
        >
          {sandboxLabel(permissions)}
        </Text>
      </Box>
    </Box>
  );
}

const RUNWIRE_ACCENT = "#F6B453";
const RUNWIRE_SELECTION = "#2A2115";
const RUNWIRE_MARK = "//>";

const ACTIVITY_NEUTRAL = "#C1C8D0";
const ACTIVITY_READ = "#6FA8D8";
const ACTIVITY_EDIT = "#D1A75F";
const ACTIVITY_SPAWN = "#A990D8";
const ACTIVITY_MESSAGE = "#74B1AB";
const ACTIVITY_FOLLOWUP = "#6E9FD2";
const ACTIVITY_INTERRUPT = "#D39A6C";
const ACTIVITY_SKILL = "#68B5B2";
const ACTIVITY_DONE = "#76B083";
const ACTIVITY_FAILED = "#D98282";
const ACTIVITY_RUNNING = "#C1A06E";

const AGENT_SYMBOLS = ["◆", "◇", "●", "◈", "✦", "✶", "✳", "✹"] as const;
const AGENT_COLORS = ["#6AA9FF", "#A78BFA", "#F28CC6", "#E9B872", "#7FCFA4", "#67C7D9"] as const;

function agentVisual(taskName: string): {
  symbol: (typeof AGENT_SYMBOLS)[number];
  color: (typeof AGENT_COLORS)[number];
} {
  let hash = 2_166_136_261;
  for (const character of taskName) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return {
    symbol: AGENT_SYMBOLS[hash % AGENT_SYMBOLS.length] ?? "◆",
    color: AGENT_COLORS[Math.floor(hash / AGENT_SYMBOLS.length) % AGENT_COLORS.length] ?? "cyan",
  };
}

function activityKindColor(kind: ActivityKind, isError?: boolean): string {
  if (isError) return ACTIVITY_FAILED;
  if (kind === "read") return ACTIVITY_READ;
  if (kind === "edit") return ACTIVITY_EDIT;
  if (kind === "spawn") return ACTIVITY_SPAWN;
  if (kind === "message") return ACTIVITY_MESSAGE;
  if (kind === "followup") return ACTIVITY_FOLLOWUP;
  if (kind === "interrupt") return ACTIVITY_INTERRUPT;
  if (kind === "skill") return ACTIVITY_SKILL;
  if (kind === "done") return ACTIVITY_DONE;
  return ACTIVITY_NEUTRAL;
}

function mainAction(state: RunwireInkState): string {
  if (state.runtimeState === "starting") return "Starting…";
  if (state.runtimeState === "stopping") return "Stopping…";
  if (state.runtimeState === "running" && state.runtimeDirty) return "Apply & restart";
  if (state.runtimeState === "running") return "Stop";
  return "Start";
}

function mainActionIcon(state: RunwireInkState): string {
  if (state.runtimeState === "running" && state.runtimeDirty) return "↻";
  if (state.runtimeState === "running") return "Ⅱ";
  if (state.runtimeState === "starting" || state.runtimeState === "stopping") return "…";
  return "▶";
}

function connectionStatus(state: RunwireInkState): string {
  if (!state.settings.tunnelEnabled) return "Local only";
  if (!state.settings.tunnelId) return "Tunnel ID missing";
  if (!state.apiKeyConfigured) return "API key missing";
  if (state.runtimeState === "running" && state.components.get("tunnel") === "ready") return "Connected";
  return "Configured";
}

function sandboxLabel(value: RunwireSettings["sandboxMode"]): string {
  if (value === "read-only") return "Read only";
  if (value === "danger-full-access") return "Full access";
  return "Workspace write";
}

function editValue(value: string, secret: boolean): string {
  const visible = secret ? "*".repeat(Math.min(value.length, 24)) : value;
  return `${visible}_`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
