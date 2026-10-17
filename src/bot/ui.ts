import { InlineKeyboard } from "grammy";
import type { OrderDraft, OrderSide, PairConfig, TriggerDraft } from "../domain.js";
import { escapeHtml } from "../utils/html.js";
import { heading } from "./presentation.js";
import { multiplyDecimals } from "../utils/decimal.js";

export function mainKeyboard(readOnly = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(readOnly ? "📊 Markets" : "📈 Trading", "markets:0").text("💼 Balances", "balances").row()
    .text("📋 Open orders", "orders:open").text("🗂 Order history", "orders:history").row()
    .text("⚡ Strategies", "triggers:list").text("🛡 Security", "safety").row()
    .text("⚙ Configuration", "configuration").text("ℹ️ Help", "help").row()
    .text("↻ Refresh terminal", "home");
  return keyboard;
}

export function pairsKeyboard(pairs: PairConfig[], page: number, prefix: "pair" | "ordpair" | "trpair", pageSize = 8): InlineKeyboard {
  const enabled = pairs.filter((pair) => pair.status === "PAIR_STATUS_ENABLED");
  const pages = Math.max(1, Math.ceil(enabled.length / pageSize));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const keyboard = new InlineKeyboard();
  for (const pair of enabled.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    keyboard.text(pair.symbol.replace("-", "/"), `${prefix}:${pair.symbolId}`);
    if (keyboard.inline_keyboard.at(-1)?.length === 2) keyboard.row();
  }
  keyboard.row();
  if (safePage > 0) keyboard.text("‹", `${prefix === "pair" ? "markets" : `${prefix}page`}:${safePage - 1}`);
  keyboard.text(`${safePage + 1}/${pages}`, "noop");
  if (safePage < pages - 1) keyboard.text("›", `${prefix === "pair" ? "markets" : `${prefix}page`}:${safePage + 1}`);
  keyboard.row().text("‹ Terminal", "home");
  return keyboard;
}

export function orderOptionsKeyboard(draft: Partial<OrderDraft>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (draft.kind === "LIMIT_GTC") keyboard.text(draft.postOnly ? "✅ Maker only · post-only" : "⬜ Maker only · post-only", "ordtoggle:post").row();
  keyboard.text(draft.attachedRisk?.takeProfitPrice ? "✅ Take-profit" : "+ Take-profit", "ordrisk:tp")
    .text(draft.attachedRisk?.stopLossPrice ? "✅ Stop-loss" : "+ Stop-loss", "ordrisk:sl").row()
    .text(draft.attachedRisk?.trailingBps || draft.attachedRisk?.trailingDistance ? "✅ Trailing stop" : "+ Trailing stop", "ordrisk:trail").row();
  if (draft.kind === "MARKET_IOC") keyboard.text("⚙ Maximum slippage", "ordrisk:slippage").row();
  keyboard.text("Continue", "ordpreview").row().text("✎ Change amount", "order:edit:size").row().text("✕ Discard order", "cancel-flow");
  return keyboard;
}

export function orderKindCard(symbol: string, side?: OrderSide, balances = ""): string {
  const displaySymbol = escapeHtml(symbol.replace("-", " / "));
  const sideLabel = side === "BUY" ? "🟢 BUY" : side === "SELL" ? "🔴 SELL" : "—";
  return [
    heading("Order type"),
    `<b>${displaySymbol}</b>  ·  ${sideLabel}`,
    balances,
    "<b>Market</b> — execute at available market prices. Unfilled remainder is cancelled.",
    "<b>Limit</b> — execute at your price or better.",
    "",
    "<b>Limit order choices</b>",
    "• <b>GTC</b> — stays open until filled or cancelled",
    "• <b>GTD</b> — stays open until the time you set",
    "• <b>IOC</b> — fills what is available now; cancels the rest",
    "• <b>FOK</b> — fills the entire amount now or nothing"
  ].join("\n");
}

export function orderKindKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Market · execute now", "ordkind:MARKET_IOC").row()
    .text("🎯 Limit · stays open (GTC)", "ordkind:LIMIT_GTC").row()
    .text("⏳ Limit · until time (GTD)", "ordkind:LIMIT_GTD").row()
    .text("↯ Limit · fill available (IOC)", "ordkind:LIMIT_IOC").row()
    .text("◆ Limit · all or nothing (FOK)", "ordkind:LIMIT_FOK").row()
    .text("✕ Discard order", "cancel-flow");
}

export function formatOrderDraft(draft: Partial<OrderDraft>): string {
  const risk = draft.attachedRisk;
  const [base = "token", quote = "quote"] = (draft.symbol ?? "").split("-").map(escapeHtml);
  const kind = orderKindLabel(draft.kind);
  const budget = draft.side === "BUY" && (draft.maxQuoteDebit || (draft.balancePercent && draft.quoteAmount));
  const value = draft.qty && (draft.price || draft.sizingPrice)
    ? multiplyDecimals(draft.qty, (draft.price || draft.sizingPrice)!) : undefined;
  return [
    `<b>${escapeHtml(draft.side ?? "—")} ${escapeHtml((draft.symbol ?? "—").replace("-", " / "))} · ${kind}</b>`,
    "",
    draft.balancePercent ? `Balance share: <b>${escapeHtml(draft.balancePercent)}%</b> of available ${escapeHtml(draft.percentageAsset ?? "")}` : null,
    budget ? `Budget: <b>${escapeHtml(draft.maxQuoteDebit ?? draft.quoteAmount!)} ${quote}</b> (including fees)` : null,
    draft.quoteAmount && !budget ? `Entered value: <b>${escapeHtml(draft.quoteAmount)} ${quote}</b> (before fees)` : null,
    draft.qty ? `Quantity: <code>${escapeHtml(draft.qty)} ${base}</code>` : budget ? "Quantity: calculated by Polyester within the budget" : "Quantity: Not set",
    draft.price ? `Limit price: <code>${escapeHtml(draft.price)} ${quote}</code>` : null,
    value && !budget ? `${draft.kind === "MARKET_IOC" ? "Estimated value" : "Order value"}: <code>${value} ${quote}</code> (excluding fees)` : null,
    draft.expireAt ? `Expires: <code>${escapeHtml(draft.expireAt)}</code>` : null,
    draft.postOnly ? "Post-only: ON" : null,
    draft.maxSlippageBps ? `Max. slippage: ${draft.maxSlippageBps} bps` : null,
    risk?.takeProfitPrice ? `Take-profit: <code>${escapeHtml(risk.takeProfitPrice)} ${quote}</code>` : null,
    risk?.stopLossPrice ? `Stop-loss: <code>${escapeHtml(risk.stopLossPrice)} ${quote}</code>` : null,
    risk?.trailingBps ? `Trailing: ${risk.trailingBps} bps` : null,
    risk?.activationPrice ? `Trailing activation: <code>${escapeHtml(risk.activationPrice)} ${quote}</code>` : null,
    "",
    draft.kind === "MARKET_IOC" ? "Final quantity and cost depend on execution." : "Final value depends on filled quantity and execution price.",
    budget ? "Fees are included in the budget. Actual spending may be lower."
      : draft.side === "SELL" ? "Fees reduce the proceeds." : "Fees are additional.",
    draft.quoteAmount || draft.balancePercent ? "Quantity is rounded down to the pair's step." : null
  ].filter(line => line !== null).join("\n");
}

export function orderKindLabel(kind?: string): string {
  return kind === "MARKET_IOC" ? "Market" : kind?.startsWith("LIMIT_") ? `Limit ${escapeHtml(kind.slice(6))}` : "—";
}

export function strategyKindLabel(kind?: string): string {
  return ({ STOP_LOSS: "Stop-loss", TAKE_PROFIT: "Take-profit", TRAILING_STOP: "Trailing stop", TWAP: "TWAP", LADDER: "Ladder" } as Record<string, string>)[kind ?? ""] ?? "Strategy";
}

export function formatTriggerDraft(draft: Partial<TriggerDraft>): string {
  const [baseAsset = "asset", quoteAsset = "quote"] = String(draft.symbol ?? "").split("-");
  const kind = draft.kind === "STOP_LOSS" ? "Stop-loss"
    : draft.kind === "TAKE_PROFIT" ? "Take-profit"
    : draft.kind === "TRAILING_STOP" ? "Trailing stop"
    : draft.kind === "TWAP" ? "TWAP · timed execution"
    : draft.kind === "LADDER" ? "Ladder · price levels" : "Strategy";
  const execution = draft.kind === "LADDER"
    ? `${draft.levels ?? "—"} limit orders across the selected range. Matching prices can fill immediately; other orders stay open until filled or cancelled.`
    : draft.childKind === "LIMIT_GTC"
      ? `Limit order at ${draft.childLimitPrice ?? "—"} ${quoteAsset}; remains open until filled or cancelled.`
      : draft.childKind === "MARKET_IOC"
        ? `${draft.kind === "TWAP" ? "Market execution for each scheduled slice" : "Market execution when triggered"}; any unfilled remainder is cancelled.`
        : null;
  return [
    `<b>${escapeHtml(kind)}</b> · ${escapeHtml(String(draft.symbol ?? "—").replace("-", " / "))}`,
    `Action: <b>${escapeHtml(draft.side === "BUY" ? "Buy" : draft.side === "SELL" ? "Sell" : "—")}</b>`,
    `Total quantity: <code>${escapeHtml(draft.qty ?? "—")} ${escapeHtml(baseAsset)}</code>`,
    draft.triggerPrice ? `Trigger price: <code>${escapeHtml(draft.triggerPrice)} ${escapeHtml(quoteAsset)}</code>` : null,
    draft.trailingBps ? `Trailing: ${draft.trailingBps} bps` : null,
    draft.activationPrice ? `Starts tracking at: <code>${escapeHtml(draft.activationPrice)} ${escapeHtml(quoteAsset)}</code>` : null,
    draft.maxSlippageBps !== undefined ? `Maximum slippage: ${draft.maxSlippageBps} bps` : null,
    draft.durationMs ? `Duration: ${draft.durationMs / 1000}s` : null,
    draft.sliceIntervalMs ? `Order interval: ${draft.sliceIntervalMs / 1000}s` : null,
    draft.priceMin ? `Price range: <code>${escapeHtml(draft.priceMin)}–${escapeHtml(draft.priceMax)} ${escapeHtml(quoteAsset)}</code>` : null,
    execution ? `Execution: ${escapeHtml(execution)}` : null
  ].filter(Boolean).join("\n");
}

export function sparkline(values: number[]): string {
  if (values.length === 0) return "—";
  const chars = "▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return "▄".repeat(values.length);
  return values.map((value) => chars[Math.min(chars.length - 1, Math.floor(((value - min) / (max - min)) * chars.length))]).join("");
}
