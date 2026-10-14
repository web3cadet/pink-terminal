export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function shorten(value: string, max = 18): string {
  if (value.length <= max) return value;
  const side = Math.max(3, Math.floor((max - 1) / 2));
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}
