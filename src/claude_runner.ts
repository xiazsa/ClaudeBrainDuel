import { runProcess } from "./command_runner";
import { ClaudeRunInput, ClaudeRunResult } from "./types";
import { coerceString, parseJsonObjectFromText, redactSensitive, safeJsonStringify } from "./utils";

export class ClaudeRunner {
  constructor(private readonly command: string) {}

  async run(input: ClaudeRunInput): Promise<ClaudeRunResult> {
    if (input.dryRun) {
      return {
        ok: true,
        text: `[dry-run] Claude was not invoked for ${input.role}.\n\nPrompt preview:\n${input.prompt.slice(0, 4000)}`,
        raw: "",
        durationMs: 0,
        attempts: 0
      };
    }

    let last: ClaudeRunResult | undefined;
    const maxAttempts = Math.max(1, input.maxRetries + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await this.runOnce(input, attempt);
      if (result.ok) return result;
      last = result;
      if (result.errorKind === "auth" || result.errorKind === "missing_command" || result.errorKind === "json_parse") {
        break;
      }
    }
    return last ?? {
      ok: false,
      text: "",
      raw: "",
      errorKind: "process_error",
      errorMessage: "Claude runner did not produce a result.",
      durationMs: 0,
      attempts: maxAttempts
    };
  }

  private async runOnce(input: ClaudeRunInput, attempt: number): Promise<ClaudeRunResult> {
    const args = ["-p", "--output-format", input.outputFormat, "--permission-mode", input.permissionMode];
    if (input.outputFormat === "stream-json") {
      args.push("--verbose", "--include-partial-messages");
    }
    if (input.allowedTools.length) {
      args.push("--allowedTools", input.allowedTools.join(","));
    } else {
      args.push("--tools", "");
    }
    args.push("--no-session-persistence");

    let streamBuffer = "";
    const handleStdout = (chunk: string) => {
      if (input.outputFormat !== "stream-json") {
        input.onChunk?.(chunk);
        return;
      }
      streamBuffer += chunk;
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const formatted = formatStreamProgressLine(line);
        if (formatted) input.onChunk?.(formatted);
      }
    };

    const processResult = await runProcess(this.command, args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      input: input.prompt,
      signal: input.signal,
      onStdout: handleStdout,
      onStderr: input.onChunk
    });
    if (streamBuffer.trim()) {
      const formatted = formatStreamProgressLine(streamBuffer);
      if (formatted) input.onChunk?.(formatted);
    }

    const unredactedRaw = processResult.combined;
    const raw = redactSensitive(unredactedRaw);
    const base = {
      raw,
      durationMs: processResult.durationMs,
      attempts: attempt,
      exitCode: processResult.exitCode
    };

    if (processResult.errorMessage?.toLowerCase().includes("enoent")) {
      return {
        ok: false,
        text: "",
        ...base,
        errorKind: "missing_command",
        errorMessage: processResult.errorMessage
      };
    }

    if (processResult.timedOut) {
      return {
        ok: false,
        text: raw,
        ...base,
        errorKind: "timeout",
        errorMessage: processResult.errorMessage
      };
    }

    if (looksLikeAuthFailure(unredactedRaw)) {
      return {
        ok: false,
        text: raw,
        ...base,
        errorKind: "auth",
        errorMessage: "Claude authentication failed or is not configured."
      };
    }

    if (!processResult.ok) {
      return {
        ok: false,
        text: raw,
        ...base,
        errorKind: "process_error",
        errorMessage: processResult.errorMessage || `Claude exited with code ${processResult.exitCode}.`
      };
    }

    const parsed = parseClaudeResult(unredactedRaw, input.outputFormat);
    if (!parsed.ok) {
      return {
        ok: false,
        text: redactSensitive(parsed.text || raw),
        raw,
        json: parsed.json,
        durationMs: processResult.durationMs,
        attempts: attempt,
        exitCode: processResult.exitCode,
        errorKind: parsed.errorKind,
        errorMessage: parsed.errorMessage
      };
    }

    return {
      ok: true,
      text: redactSensitive(parsed.text),
      raw,
      json: parsed.json,
      durationMs: processResult.durationMs,
      attempts: attempt,
      exitCode: processResult.exitCode
    };
  }
}

function looksLikeAuthFailure(output: string): boolean {
  return /(not authenticated|authentication|auth failed|login required|invalid api key|api key.*missing|oauth)/i.test(output);
}

function parseClaudeResult(
  raw: string,
  format: ClaudeRunInput["outputFormat"]
): { ok: boolean; text: string; json?: unknown; errorKind?: "json_parse" | "empty_output"; errorMessage?: string } {
  const stdout = raw.trim();
  if (!stdout) {
    return { ok: false, text: "", errorKind: "empty_output", errorMessage: "Claude returned empty output." };
  }

  if (format === "text") {
    return { ok: true, text: stdout };
  }

  if (format === "stream-json") {
    const parsedLines: unknown[] = [];
    const textParts: string[] = [];
    const failedLines: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        parsedLines.push(parsed);
        const text = extractText(parsed);
        if (text) textParts.push(text);
      } catch {
        failedLines.push(trimmed);
      }
    }
    if (!parsedLines.length) {
      return {
        ok: false,
        text: stdout,
        errorKind: "json_parse",
        errorMessage: "No stream-json line could be parsed."
      };
    }
    const text = textParts.join("\n").trim() || stdout;
    return {
      ok: failedLines.length === 0,
      text,
      json: parsedLines,
      errorKind: failedLines.length ? "json_parse" : undefined,
      errorMessage: failedLines.length ? `${failedLines.length} stream-json lines failed to parse.` : undefined
    };
  }

  const parsed = parseJsonObjectFromText(stdout);
  if (!parsed) {
    return {
      ok: false,
      text: stdout,
      errorKind: "json_parse",
      errorMessage: "Claude JSON output could not be parsed."
    };
  }
  const text = extractText(parsed) || safeJsonStringify(parsed);
  return { ok: true, text, json: parsed };
}

function extractText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";

  if (Array.isArray(value)) {
    return value.map((item) => extractText(item, depth + 1)).filter(Boolean).join("\n");
  }

  const record = value as Record<string, unknown>;
  const directKeys = ["result", "text", "content", "message", "summary", "response"];
  for (const key of directKeys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  if (Array.isArray(record.content)) {
    const contentText = record.content.map((item) => extractText(item, depth + 1)).filter(Boolean).join("\n");
    if (contentText.trim()) return contentText;
  }

  if (record.message) {
    const messageText = extractText(record.message, depth + 1);
    if (messageText.trim()) return messageText;
  }

  if (record.delta) {
    const deltaText = extractText(record.delta, depth + 1);
    if (deltaText.trim()) return deltaText;
  }

  if (record.type === "text" && record.text) {
    return coerceString(record.text);
  }

  return "";
}

function formatStreamProgressLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return "";
  }

  const type = parsed.type;
  if (type === "system") {
    const subtype = coerceString(parsed.subtype);
    if (subtype === "init") {
      const model = coerceString(parsed.model, "unknown");
      const tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
      return `[claude] session started model=${model} tools=${tools}\n`;
    }
    if (subtype === "status") {
      return `[claude] status=${coerceString(parsed.status, "unknown")}\n`;
    }
  }

  if (type === "stream_event") {
    const event = parsed.event as Record<string, unknown> | undefined;
    if (!event) return "";
    const eventType = coerceString(event.type);
    if (eventType === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      const model = coerceString(message?.model);
      return model ? `[claude] model=${model}\n` : "";
    }
    if (eventType === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      const blockType = coerceString(block?.type);
      if (blockType === "thinking") return `[claude] thinking...\n`;
      if (blockType === "text") return `[claude] writing answer...\n`;
      if (blockType === "tool_use") {
        return `[tool] ${coerceString(block?.name, "tool")} started\n`;
      }
    }
    if (eventType === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      const deltaType = coerceString(delta?.type);
      if (deltaType === "text_delta") {
        const text = coerceString(delta?.text);
        return text ? `[text] ${text.replace(/\s+/g, " ").slice(0, 220)}\n` : "";
      }
      if (deltaType === "input_json_delta") {
        const partial = coerceString(delta?.partial_json);
        return partial ? `[tool-input] ${partial.replace(/\s+/g, " ").slice(0, 220)}\n` : "";
      }
    }
    if (eventType === "message_delta") {
      const usage = event.usage as Record<string, unknown> | undefined;
      const inputTokens = usage?.input_tokens;
      const outputTokens = usage?.output_tokens;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        return `[tokens] input=${inputTokens ?? "?"} output=${outputTokens ?? "?"}\n`;
      }
    }
    if (eventType === "message_stop") return `[claude] message complete\n`;
  }

  if (type === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      const tool = content.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "tool_use") as
        | Record<string, unknown>
        | undefined;
      if (tool) return `[tool] ${coerceString(tool.name, "tool")} requested\n`;
    }
  }

  if (type === "result") {
    const subtype = coerceString(parsed.subtype);
    const duration = parsed.duration_ms;
    const cost = parsed.total_cost_usd;
    const usage = parsed.usage as Record<string, unknown> | undefined;
    const tokens =
      usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)
        ? ` tokens=${usage.input_tokens ?? "?"}/${usage.output_tokens ?? "?"}`
        : "";
    return `[result] ${subtype || "done"} duration=${duration ?? "?"}ms cost=${cost ?? "?"}${tokens}\n`;
  }

  return "";
}
