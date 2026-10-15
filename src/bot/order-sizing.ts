import type { ExchangeGateway, OrderDraft, PairConfig } from "../domain.js";
import { decimalToScaled, scaledToDecimal } from "../utils/decimal.js";
import { positiveInput } from "./presentation.js";

/** Snapshot available funds at input time; percentages always follow the spend asset. */
export async function applyOrderAmountInput(gateway: ExchangeGateway, pair: PairConfig, draft: OrderDraft, input: string, mode: "base" | "quote"): Promise<void> {
  const text = input.trim();
  let amount: string;
  let currencyMode = mode;
  let percent: string | undefined, asset: string | undefined, balance: string | undefined;
  if (text.endsWith("%")) {
    percent = positiveInput(text.slice(0, -1).trim());
    const places = percent.split(".")[1]?.length ?? 0;
    const numerator = BigInt(decimalToScaled(percent, places));
    const denominator = 100n * 10n ** BigInt(places);
    if (numerator > denominator) throw new Error("Enter a percentage greater than 0 and at most 100%.");
    asset = draft.side === "BUY" ? pair.quoteAsset : pair.baseAsset;
    const [catalog, balances] = await Promise.all([gateway.getCatalog(), gateway.listBalances()]);
    const ledger = catalog.assets.find(item => item.asset === asset);
    if (!ledger) throw new Error(`The available ${asset} balance could not be identified. Try again.`);
    const raw = BigInt(balances.find(item => item.assetId === ledger.ledgerId)?.available ?? "0");
    if (raw <= 0n) throw new Error(`No available ${asset} to ${draft.side === "BUY" ? "spend" : "sell"}.`);
    balance = scaledToDecimal(raw, 18);
    amount = scaledToDecimal(raw * numerator / denominator, 18);
    currencyMode = draft.side === "BUY" ? "quote" : "base";
    if (currencyMode === "base") amount = quantityForQuote(amount, "1", pair.stepSize);
    if (!/[1-9]/.test(amount)) throw new Error("This percentage is too small. Enter a larger amount.");
  } else {
    amount = positiveInput(text);
  }
  // Do not modify a previous valid draft unless the whole input was validated.
  delete draft.qty; delete draft.quoteAmount; delete draft.maxQuoteDebit; delete draft.sizingPrice;
  delete draft.balancePercent; delete draft.percentageAsset; delete draft.percentageBalance;
  if (currencyMode === "quote") draft.quoteAmount = amount;
  else draft.qty = amount;
  if (percent !== undefined) { draft.balancePercent = percent; draft.percentageAsset = asset!; draft.percentageBalance = balance!; }
}

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
