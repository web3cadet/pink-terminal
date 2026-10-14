export type LogLevel = "debug" | "info" | "warn" | "error";

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, fields: Record<string, unknown> = {}): void { this.write("debug", message, fields); }
  info(message: string, fields: Record<string, unknown> = {}): void { this.write("info", message, fields); }
  warn(message: string, fields: Record<string, unknown> = {}): void { this.write("warn", message, fields); }
  error(message: string, fields: Record<string, unknown> = {}): void { this.write("error", message, fields); }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (rank[level] < rank[this.level]) return;
    const safe = Object.fromEntries(Object.entries(fields)
      .filter(([key]) => !/token|secret|signature|authorization|cookie/i.test(key))
      .map(([key, value]) => [key, redactLogValue(value)]));
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message: redactString(message), ...safe });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

export function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/token|secret|signature|authorization|cookie/i.test(key))
      .map(([key, nested]) => [key, redactLogValue(nested)]));
  }
  return value;
}

function redactString(value: string): string {
  return value
    .replace(/\d{8,12}:[A-Za-z0-9_-]{25,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\b(?:0x)?[0-9a-fA-F]{64}\b/g, "[REDACTED_32_BYTE_HEX]");
}
