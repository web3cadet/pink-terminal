import type { ExchangeGateway, OrderDraft, PairConfig } from "../domain.js";
import { decimalToScaled, scaledToDecimal } from "../utils/decimal.js";

/** Floor amount / price to a whole number of quantity steps, without floats. */
export function quantityForQuote(amount: string, price: string, step: string): string {
  const scale = (value: string) => value.split(".")[1]?.length ?? 0;
  const a = BigInt(decimalToScaled(amount, scale(amount)));
  const p = BigInt(decimalToScaled(price, scale(price)));
  const s = BigInt(decimalToScaled(step, scale(step)));
  if (a <= 0n || p <= 0n || s <= 0n) throw new Error("Amount, price and quantity step must be positive.");
  const steps = a * 10n ** BigInt(scale(price) + scale(step)) / (p * s * 10n ** BigInt(scale(amount)));
  if (steps === 0n) throw new Error("This amount is below one quantity step. Enter a larger amount.");
  return scaledToDecimal(steps * s, scale(step));
}

export async function resolveQuoteAmount(gateway: ExchangeGateway, pair: PairConfig, draft: OrderDraft): Promise<void> {
  if (!draft.quoteAmount) return; // Preserve existing base-quantity and legacy budget orders.
  let price = draft.price;
  if (draft.kind === "MARKET_IOC") {
    const market = (await gateway.listMarketOverview()).find(item => item.symbolId === pair.symbolId);
    price = (draft.side === "BUY" ? market?.bestAsk : market?.bestBid) ?? undefined;
  }
  if (!price || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(price) || !/[1-9]/.test(price)) {
    throw new Error("A current execution price is unavailable. Try again or enter the token quantity instead.");
  }
  const qty = quantityForQuote(draft.quoteAmount, price, pair.stepSize);
  draft.qty = qty;
  draft.sizingPrice = price;
  delete draft.maxQuoteDebit;
}
