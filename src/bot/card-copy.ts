import type { OrderDraft, PairConfig, TriggerDraft } from "../domain.js";
import { escapeHtml } from "../utils/html.js";
import { terminalHeading } from "./presentation.js";
import { orderKindLabel, strategyKindLabel } from "./ui.js";

/** One column definition for headers, levels and dividers in Telegram's monospace block. */
export function orderBookTable(asks: readonly { price: string; qty: string }[], bids: readonly { price: string; qty: string }[]): string {
  const levels = [...asks, ...bids];
  const priceWidth = Math.min(13, Math.max(5, ...levels.map(level => level.price.length)));
  const qtyWidth = Math.min(13, Math.max(3, ...levels.map(level => level.qty.length)));
  const fit = (value: string, width: number) => (value.length > width ? `${value.slice(0, width - 1)}…` : value).padStart(width);
  const row = (side: string, price: string, qty: string) => `${side.padEnd(3)} ${fit(price, priceWidth)} │ ${fit(qty, qtyWidth)}`;
  const divider = `${"─".repeat(4 + priceWidth + 1)}┼${"─".repeat(1 + qtyWidth)}`;
  return `<pre>${escapeHtml([
    row("", "PRICE", "QTY"), divider,
    ...[...asks].reverse().map(level => row("ASK", level.price, level.qty)),
    divider,
    ...bids.map(level => row("BID", level.price, level.qty))
  ].join("\n"))}</pre>`;
}

/** Copy only: units and percentage semantics follow the existing sizing engine. */
export function amountPrompt(pair: PairConfig, draft: Partial<OrderDraft>, quoteMode: boolean): string {
  const base = escapeHtml(pair.baseAsset), quote = escapeHtml(pair.quoteAsset);
  const sell = draft.side === "SELL";
  const percentAsset = sell ? base : quote;
  return [
    quoteMode
      ? `Enter the ${sell ? "sale" : "purchase"} value in <b>${quote}</b>${sell ? " before fees" : ""}, or a percentage of your available <b>${percentAsset}</b>.`
      : `Enter the <b>${base}</b> quantity to ${sell ? "sell" : "buy"}, or a percentage of your available <b>${percentAsset}</b>.`,
    "",
    `Percentage example: <b>10%</b> of your available <b>${percentAsset}</b> ${sell ? "to sell" : "to spend"}.`,
    sell ? "Fees reduce the proceeds." : "Exact amounts: fees are additional.\nPercentages: fees are included in the budget.",
    quoteMode && sell ? `An exact amount sets the sale value in ${quote}; a percentage sells a share of ${base}.` : ""
  ].filter(Boolean).join("\n");
}

export function orderSettingsCard(draft: Partial<OrderDraft>): string {
  const quote = escapeHtml(draft.symbol?.split("-")[1] ?? "quote asset");
  const risk = draft.attachedRisk;
  return [terminalHeading("Order settings"),
    `${escapeHtml((draft.symbol ?? "—").replace("-", " / "))} · ${escapeHtml(draft.side ?? "—")} · ${orderKindLabel(draft.kind)}`, "",
    `Take-profit: ${risk?.takeProfitPrice ? `${escapeHtml(risk.takeProfitPrice)} ${quote}` : "Not set"}`,
    `Stop-loss: ${risk?.stopLossPrice ? `${escapeHtml(risk.stopLossPrice)} ${quote}` : "Not set"}`,
    `Trailing stop: ${risk?.trailingBps ? `${risk.trailingBps} bps` : risk?.trailingDistance ? escapeHtml(String(risk.trailingDistance)) : "Not set"}`,
    risk?.activationPrice ? `Trailing activation: ${escapeHtml(risk.activationPrice)} ${quote}` : null,
    draft.kind === "LIMIT_GTC" ? `Post-only: ${draft.postOnly ? "ON" : "OFF"}` : null,
    draft.kind === "MARKET_IOC" ? `Max. slippage: ${draft.maxSlippageBps ? `${draft.maxSlippageBps} bps` : "Polyester default"}` : null,
    "", "Select a setting to change."
  ].filter(line => line !== null).join("\n");
}

export function strategyPrompt(draft: Partial<TriggerDraft>, title: string, instruction: string): string {
  const [base = "asset", quote = "quote asset"] = (draft.symbol ?? "").split("-");
  return [terminalHeading("New strategy"),
    `${strategyKindLabel(draft.kind)} · ${escapeHtml(draft.side ?? "—")} ${escapeHtml((draft.symbol ?? "—").replace("-", " / "))}`, "",
    `<b>${escapeHtml(title)}</b>`, "",
    escapeHtml(instruction.replaceAll("{base}", base).replaceAll("{quote}", quote))
  ].join("\n");
}
