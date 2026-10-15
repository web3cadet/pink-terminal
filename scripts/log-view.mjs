const titles = {
  bot_starting: "Starting Pink Terminal", bot_started: "Bot is online",
  shutdown_started: "Stopping bot", orders_reconciled: "Order status recovered",
  bot_volume_updated: "Trade history updated", maintenance_loop_failed: "Background check needs attention",
  telegram_access_denied: "Telegram access denied", bot_update_failed: "Telegram action failed",
  live_terminal_update_failed: "Live prices could not refresh", order_submitted: "Order submitted",
  order_submission_needs_review: "Check order status before retrying"
};
const secretKey = /token|secret|signature|authorization|cookie|password|private.?key/i;
function clean(value) {
  return String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\d{8,12}:[A-Za-z0-9_-]{25,}\b/g, "[REDACTED]")
    .replace(/\b(?:0x)?[0-9a-fA-F]{64}\b/g, "[REDACTED]")
    .replace(/((?:token|secret|password|authorization|private.?key)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}
function safeValue(value) {
  if (Array.isArray(value)) return value.map(safeValue).join(", ");
  if (value && typeof value === "object") return Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, v]) => `${clean(key)}: ${safeValue(v)}`).join(" · ");
  return clean(value);
}
function wrap(text, width) {
  const lines = [];
  for (const source of text.split(/\r?\n/)) {
    let remaining = source;
    while (remaining.length > width) {
      const space = remaining.lastIndexOf(" ", width);
      const cut = space > width / 2 ? space : width;
      lines.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

/** Display only: original structured log files remain unchanged for diagnostics. */
export function formatLogs(raw, { color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, width = 88 } = {}) {
  width = Math.max(40, Math.min(120, width));
  const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const output = ["", paint("1;95", "PINK TERMINAL  /  RECENT LOGS"), paint("90", "─".repeat(width)), ""];
  let sqliteNote = false, skipTrace = false, entries = 0;
  for (const original of String(raw).split(/\r?\n/)) {
    const line = original.trim();
    if (/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/.test(line)) { sqliteNote = true; skipTrace = true; continue; }
    if (skipTrace && /^\(Use .+--trace-warnings/.test(line)) { skipTrace = false; continue; }
    skipTrace = false;
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { /* Preserve non-JSON errors and stack traces. */ }
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.message !== "string" || !["debug", "info", "warn", "error"].includes(record.level)) {
      output.push(...wrap(clean(line), width).map(text => `  ${text}`)); entries++; continue;
    }
    const { ts, level, message, ...fields } = record;
    const code = { info: "32", warn: "33", error: "31", debug: "90" }[level];
    const time = typeof ts === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(ts) ? `${ts.slice(0, 10)} ${ts.slice(11, 19)} UTC` : "";
    const title = titles[message] ?? clean(message).replaceAll("_", " ");
    output.push(`${paint("90", time)}  ${paint(`1;${code}`, `[${level.toUpperCase()}]`)}  ${title}`);
    // Startup plumbing is useful in the raw log, not on every operator screen.
    for (const [key, value] of Object.entries(fields)) {
      if (secretKey.test(key) || ["apiUrl", "authenticated", "allowedChats", "allowedUsers"].includes(key)) continue;
      const label = clean(key).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
      output.push(...wrap(`${label}: ${safeValue(value)}`, width - 4).map(text => `  ${paint("90", "│")} ${text}`));
    }
    output.push(""); entries++;
  }
  if (!entries) output.push("  No events yet.", "");
  if (sqliteNote) output.push(paint("90", "Runtime note: Node marks SQLite as experimental; this is not a bot error."), "");
  output.push(paint("90", "─".repeat(width)));
  return output.join("\n");
}
