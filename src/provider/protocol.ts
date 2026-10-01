export interface ExecToolSpec {
  type: "custom";
  name: "exec";
  description: string;
  format?: unknown;
}

export type ProviderReply =
  | {
      kind: "tool_call";
      callId: string;
      namespace: "functions";
      name: "exec";
      input: string;
    }
  | {
      kind: "complete";
      text: string;
    };

export type BridgeContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export interface BridgeCallResult {
  content: BridgeContent[];
  isError: boolean;
}

export function cleanCodeModeResult(result: BridgeCallResult): BridgeCallResult {
  const content = [...result.content];
  const first = content[0];
  if (
    first?.type === "text" &&
    /^Script (?:completed|failed)\nWall time [^\n]+\nOutput:$/.test(first.text.trim())
  ) {
    content.shift();
  }
  return { content, isError: result.isError };
}

export function extractExecToolSpec(body: unknown): ExecToolSpec | undefined {
  if (!isRecord(body) || !Array.isArray(body.input)) return undefined;

  for (const item of body.input) {
    if (!isRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) {
      continue;
    }

    for (const namespace of item.tools) {
      if (
        !isRecord(namespace) ||
        namespace.type !== "namespace" ||
        namespace.name !== "functions" ||
        !Array.isArray(namespace.tools)
      ) {
        continue;
      }

      for (const tool of namespace.tools) {
        if (
          isRecord(tool) &&
          tool.type === "custom" &&
          tool.name === "exec" &&
          typeof tool.description === "string"
        ) {
          return {
            type: "custom",
            name: "exec",
            description: tool.description,
            format: tool.format,
          };
        }
      }
    }
  }

  return undefined;
}

export function extractCustomToolCallOutput(body: unknown, callId: string): unknown | undefined {
  if (!isRecord(body) || !Array.isArray(body.input)) return undefined;

  for (const item of body.input) {
    if (
      isRecord(item) &&
      item.type === "custom_tool_call_output" &&
      item.call_id === callId
    ) {
      return item.output;
    }
  }

  return undefined;
}

export function bridgeResultFromCodexOutput(output: unknown): BridgeCallResult {
  const content = mapOutputContent(output);
  const text = content
    .filter((item): item is Extract<BridgeContent, { type: "text" }> => item.type === "text")
    .map(item => item.text)
    .join("\n");

  return {
    content,
    isError:
      text.includes("Script failed") ||
      text.includes("Script error") ||
      text.includes("exec_command failed"),
  };
}

function mapOutputContent(output: unknown): BridgeContent[] {
  if (Array.isArray(output)) {
    return output.flatMap(mapSingleOutputItem);
  }

  return mapSingleOutputItem(output);
}

function mapSingleOutputItem(item: unknown): BridgeContent[] {
  if (typeof item === "string") return [{ type: "text", text: item }];

  if (!isRecord(item)) {
    return [{ type: "text", text: JSON.stringify(item) }];
  }

  if (item.type === "input_text" && typeof item.text === "string") {
    return [{ type: "text", text: item.text }];
  }

  if (item.type === "input_image" && typeof item.image_url === "string") {
    const data = parseDataUrl(item.image_url);
    if (data && data.mimeType.startsWith("image/")) {
      return [{ type: "image", data: data.data, mimeType: data.mimeType }];
    }
  }

  if (item.type === "input_audio" && typeof item.audio_url === "string") {
    const data = parseDataUrl(item.audio_url);
    if (data && data.mimeType.startsWith("audio/")) {
      return [{ type: "audio", data: data.data, mimeType: data.mimeType }];
    }
  }

  return [{ type: "text", text: JSON.stringify(item) }];
}

function parseDataUrl(value: string): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match) return undefined;

  return { mimeType: match[1], data: match[2] };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
