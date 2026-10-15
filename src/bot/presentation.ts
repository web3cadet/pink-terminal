import { escapeHtml } from "../utils/html.js";

export const WEBSITE = "https://testnet.polyester.com";
export const pairUrl = (symbol: string) => `${WEBSITE}/trade/spot/${encodeURIComponent(symbol)}`;
export const pairLink = (symbol: string) => `<a href="${pairUrl(symbol)}">${escapeHtml(symbol.replace("-", " / "))} ↗</a>`;
export const assetLink = (asset: string, marketSymbol?: string) => marketSymbol
  ? `<a href="${pairUrl(marketSymbol)}"><b>${escapeHtml(asset)}</b> ↗</a>`
  : `<b>${escapeHtml(asset)}</b>`;
export const heading = (label: string) => `💗 <b>PINK TERMINAL</b>\n<b>${escapeHtml(label)}</b>`;
const TERMINAL_WORDMARK = "💗 𝗣𝗜𝗡𝗞 𝗧𝗘𝗥𝗠𝗜𝗡𝗔𝗟";
export const terminalHeading = (label = "") => TERMINAL_WORDMARK + (label ? `\n<b>${escapeHtml(label)}</b>` : "");
export const section = (label: string) => `<b>${escapeHtml(label)}</b>`;
/** Display only: preserve exact decimal strings in drafts and requests. */
export function numberText(value: string | number | null | undefined, places = 6): string {
  if (value == null || value === "") return "—";
  const raw = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return escapeHtml(raw);
  const [whole = "0", fraction = ""] = raw.split(".");
  const trimmed = fraction.slice(0, places).replace(/0+$/, "");
  if (/^-?0$/.test(whole) && !trimmed && /[1-9]/.test(fraction)) return `${raw.startsWith("-") ? "−" : ""}<${places ? `0.${"0".repeat(places - 1)}1` : "1"}`.replace("<", "&lt;");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (trimmed ? `.${trimmed}` : "");
}
export const modeText = (mode: string) => mode === "paper" ? "🧪 Paper · simulated funds" : mode === "read_only" ? "🔒 Testnet · view & draft" : "🟢 Testnet · trading enabled";
export function positiveInput(text: string): string {
  const value = text.trim().replace(",", ".");
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value) || !/[1-9]/.test(value)) throw new Error("Enter a positive amount, e.g. 1 or 0.25 (0,25 also works).");
  return value;
}
