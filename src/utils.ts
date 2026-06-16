import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix = "id"): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function slugify(value: string, fallback = "goal"): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (ascii || fallback).slice(0, 48).replace(/-$/g, "") || fallback;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeTextFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

export function appendTextFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content, "utf8");
}

export function readTextFileIfExists(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  } catch {
    return "";
  }
}

export function readJsonFileIfExists<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function copyFileIfMissing(from: string, to: string): boolean {
  if (fs.existsSync(to)) return false;
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
  return true;
}

export function writeFileIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  writeTextFile(filePath, content);
  return true;
}

export function tailLines(text: string, maxLines = 120): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

export function truncateText(text: string, maxChars = 40000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[cbduel truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, null, space);
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) }, null, space);
  }
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

export function parseJsonObjectFromText(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fall through.
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function coerceString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export function redactSensitive(text: string): string {
  if (!text) return text;
  const lineRedacted = text
    .split(/\r?\n/)
    .map((line) => {
      if (
        /(^|[\\/])\.env(\.|$)|private[_-]?key|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(line) ||
        /\b(api[_-]?key|secret|password|authorization)\b\s*[:=]/i.test(line) ||
        /\b(token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i.test(line)
      ) {
        return line.replace(/(.{0,80}).*/, "$1 [cbduel redacted sensitive line]");
      }
      return line;
    })
    .join("\n");

  return lineRedacted
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[cbduel-redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[cbduel-redacted-private-key]");
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    /(^|\/)\.env(\.|$)/.test(normalized) ||
    /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(normalized) ||
    /\.(pem|key|p12|pfx)$/.test(normalized) ||
    /(token|secret|credential|password)/.test(normalized)
  );
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function resolvePackageRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export function resolveTemplatePath(name: string): string {
  return path.join(resolvePackageRoot(), "templates", name);
}
