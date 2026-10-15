import type { ExchangeGateway, OrderDraft, PairConfig } from "../domain.js";
import { decimalToScaled, scaledToDecimal, multiplyDecimals, quantityForQuote } from "../utils/decimal.js";
export { quantityForQuote } from "../utils/decimal.js";
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

export async function resolveQuoteAmount(gateway: ExchangeGateway, pair: PairConfig, draft: OrderDraft): Promise<void> {
  if (!draft.quoteAmount) return; // Preserve existing base-quantity and legacy budget orders.
  const percentageBuy = draft.side === "BUY" && draft.balancePercent !== undefined;
  const quoteUnit = percentageBuy ? scaledToDecimal(1n, pair.quoteQuantityScale) : "1";
  const budget = percentageBuy ? quantityForQuote(draft.quoteAmount, "1", quoteUnit) : draft.quoteAmount;
  if (percentageBuy && (draft.kind === "MARKET_IOC" || draft.kind === "LIMIT_IOC")) {
    // Native all-in sizing lets the exchange account for fees and the protected
    // execution price. Never also send baseQty: it would replace this ceiling.
    draft.maxQuoteDebit = budget;
    delete draft.qty; delete draft.sizingPrice;
    return;
  }
  let price = draft.price;
  if (draft.kind === "MARKET_IOC") {
    const market = (await gateway.listMarketOverview()).find(item => item.symbolId === pair.symbolId);
    price = (draft.side === "BUY" ? market?.bestAsk : market?.bestBid) ?? undefined;
  }
  if (!price || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(price) || !/[1-9]/.test(price)) {
    throw new Error("A current execution price is unavailable. Try again or enter the token quantity instead.");
  }
  let sizingAmount = budget, sizingPrice = price;
  if (percentageBuy) {
    // Resting/FOK orders do not support native quote budgets. Reserve the larger
    // current maker/taker fee; never assume VIP 0 or spend rebates in advance.
    const rates = await gateway.getSpotFeeRates?.(pair.symbolId);
    if (!rates || ![rates.maker, rates.taker].every(value => /^-?(0|[1-9]\d*)(?:\.\d+)?$/.test(value))) {
      throw new Error("Fee rates are unavailable. Try again before using a buy percentage.");
    }
    const scale = Math.max(...[rates.maker, rates.taker].map(value => value.split(".")[1]?.length ?? 0));
    const values = [rates.maker, rates.taker].map(value => value.startsWith("-") ? 0n : BigInt(decimalToScaled(value, scale)));
    const rate = values[0]! > values[1]! ? values[0]! : values[1]!;
    const factor = scaledToDecimal(100n * 10n ** BigInt(scale) + rate, scale + 2);
    sizingPrice = multiplyDecimals(price, factor);
    // One quote quantum covers upward fee rounding at the exchange.
    if (rate > 0n) sizingAmount = scaledToDecimal(BigInt(decimalToScaled(budget, pair.quoteQuantityScale)) - 1n, pair.quoteQuantityScale);
  }
  const qty = quantityForQuote(sizingAmount, sizingPrice, pair.stepSize);
  draft.qty = qty;
  draft.sizingPrice = price;
  delete draft.maxQuoteDebit;
}
