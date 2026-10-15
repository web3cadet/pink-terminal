import type { ExchangeGateway, PairConfig } from "../domain.js";
import { scaledToDecimal } from "../utils/decimal.js";
import { escapeHtml } from "../utils/html.js";
import { numberText } from "./presentation.js";

export async function orderFeeLine(gateway: ExchangeGateway, symbolId: number): Promise<string> {
  try {
    const rates = await gateway.getSpotFeeRates?.(symbolId);
    if (!rates) return "Fee: unavailable";
    return `Fee: Maker <b>${escapeHtml(rates.maker)}%</b> · Taker <b>${escapeHtml(rates.taker)}%</b>`;
  } catch {
    return "Fee: unavailable";
  }
}

export async function orderBalances(gateway: ExchangeGateway, pair: PairConfig): Promise<string> {
  try {
    const [catalog, balances] = await Promise.all([gateway.getCatalog(), gateway.listBalances()]);
    const values = [pair.baseAsset, pair.quoteAsset].map(symbol => {
      const asset = catalog.assets.find(item => item.asset === symbol);
      if (!asset) return `${escapeHtml(symbol)}: unavailable`;
      const balance = balances.find(item => item.assetId === asset.ledgerId);
      // Ledger balances always use 18 decimals, independently of order quantity scales.
      return `${escapeHtml(symbol)}: <b>${numberText(scaledToDecimal(balance?.available ?? "0", 18))}</b>`;
    });
    return `\n<b>Available to trade</b>\n${values.join("\n")}\n`;
  } catch {
    return `\n<b>Available to trade</b>\n${escapeHtml(pair.baseAsset)}: unavailable\n${escapeHtml(pair.quoteAsset)}: unavailable\n`;
  }
}

export function orderMinimums(pair: PairConfig, quoteBudget = false): string {
  return [
    `Polyester minimum: <b>${escapeHtml(pair.minQtyBase)} ${escapeHtml(pair.baseAsset)} / ${escapeHtml(pair.minNotionalQuote)} ${escapeHtml(pair.quoteAsset)}</b>.`,
    `Quantity step: ${escapeHtml(pair.stepSize)} ${escapeHtml(pair.baseAsset)}.`,
    quoteBudget ? "The budget includes quote fees. Allow room above the minimum; Polyester checks the final amount in preview." : ""
  ].filter(Boolean).join("\n");
}
