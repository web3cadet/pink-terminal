import type { AppConfig } from "../config.js";
import type { MarketOverview, OrderDraft, PairConfig, TriggerDraft } from "../domain.js";
import { compareDecimals, decimalToScaled, isStepAligned, multiplyDecimals, scaledToDecimal } from "../utils/decimal.js";

export class RiskGuard {
  constructor(private readonly config: AppConfig) {}

  validateOrder(draft: OrderDraft, pair: PairConfig, market: MarketOverview | undefined): void {
    if (pair.status !== "PAIR_STATUS_ENABLED") throw new Error(`${pair.symbol} is not enabled for trading`);
    if (draft.qty) {
      if (compareDecimals(draft.qty, pair.minQtyBase) < 0) throw new Error(`Minimum quantity is ${pair.minQtyBase} ${pair.baseAsset}`);
      if (!isStepAligned(draft.qty, pair.stepSize)) throw new Error(`Quantity must align to step ${pair.stepSize}`);
    }
    if (draft.price) {
      if (!isStepAligned(draft.price, pair.tickSize)) throw new Error(`Price must align to tick ${pair.tickSize}`);
      if (compareDecimals(draft.price, "0") <= 0) throw new Error("Price must be positive");
    }
    const quoteBudget = draft.maxQuoteDebit;
    // Last trade can be far from the current bid/ask (especially on testnet).
    // Use this order's execution side, not an unrelated historical print.
    const price = draft.price ?? (draft.side === "BUY" ? market?.bestAsk : market?.bestBid) ?? draft.sizingPrice ?? market?.lastPrice ?? undefined;
    const estimated = quoteBudget ?? (draft.qty && price ? multiplyDecimals(draft.qty, price) : undefined);
    if (estimated && compareDecimals(estimated, pair.minNotionalQuote) < 0) {
      throw new Error(`Minimum notional is ${pair.minNotionalQuote} ${pair.quoteAsset}`);
    }
    if ((draft.kind === "LIMIT_GTC" || draft.kind === "LIMIT_GTD") && draft.postOnly === undefined) draft.postOnly = false;
    if (draft.kind !== "LIMIT_GTC" && draft.postOnly) throw new Error("Post-only is supported only for LIMIT_GTC");
    if (draft.kind === "LIMIT_GTD") {
      const expiry = Date.parse(draft.expireAt ?? "");
      if (!Number.isFinite(expiry) || expiry < Date.now() + 1_000 || expiry > Date.now() + 30 * 86_400_000) {
        throw new Error("GTD expiry must be between 1 second and 30 days from now");
      }
    }
    if (draft.side === "SELL" && draft.feeAsset === "BASE") throw new Error("SELL orders must pay fees in quote asset");
  }

  validateTrigger(draft: TriggerDraft, pair: PairConfig): void {
    if (pair.status !== "PAIR_STATUS_ENABLED") throw new Error(`${pair.symbol} is not enabled for trading`);
    if (compareDecimals(draft.qty, pair.minQtyBase) < 0 || !isStepAligned(draft.qty, pair.stepSize)) {
      throw new Error(`Quantity must be at least ${pair.minQtyBase} and align to ${pair.stepSize}`);
    }
    for (const [label, value] of [["Trigger price", draft.triggerPrice], ["Limit price", draft.childLimitPrice], ["Activation price", draft.activationPrice], ["Ladder minimum price", draft.priceMin], ["Ladder maximum price", draft.priceMax]] as const) {
      if (value !== undefined && (compareDecimals(value, "0") <= 0 || !isStepAligned(value, pair.tickSize))) {
        throw new Error(`${label} must be positive and align to price step ${pair.tickSize}`);
      }
    }
    if ((draft.kind === "STOP_LOSS" || draft.kind === "TAKE_PROFIT") && !draft.triggerPrice) throw new Error("Trigger price is required");
    if ((draft.kind === "STOP_LOSS" || draft.kind === "TAKE_PROFIT") && draft.side === "BUY" && draft.childKind === "MARKET_IOC") {
      throw new Error("BUY market children are not supported for conditional spot triggers; choose LIMIT_GTC");
    }
    if ((draft.kind === "STOP_LOSS" || draft.kind === "TAKE_PROFIT" || draft.kind === "TWAP") && draft.childKind === "LIMIT_GTC" && !draft.childLimitPrice) {
      throw new Error("Enter the limit execution price before activating this strategy");
    }
    if (draft.kind === "TRAILING_STOP") {
      if (draft.side !== "SELL" || draft.childKind !== "MARKET_IOC") throw new Error("Standalone trailing stop currently supports SELL market-IOC only");
      if (!draft.trailingDistance && !draft.trailingBps) throw new Error("Trailing distance is required");
    }
    if (draft.kind === "TWAP") {
      if ((draft.durationMs ?? 0) < 1_000) throw new Error("TWAP duration must be at least 1000 ms");
      if ((draft.sliceIntervalMs ?? 0) < 100 || (draft.sliceIntervalMs ?? 0) > (draft.durationMs ?? 0)) {
        throw new Error("TWAP slice interval must be at least 100 ms and not exceed duration");
      }
    }
    if (draft.kind === "LADDER") {
      if (!draft.priceMin || !draft.priceMax || compareDecimals(draft.priceMin, draft.priceMax) >= 0) throw new Error("Ladder minimum price must be below maximum price");
      if (!Number.isInteger(draft.levels) || (draft.levels ?? 0) < 2 || (draft.levels ?? 0) > 100) throw new Error("Ladder levels must be between 2 and 100");
      // Equal splitting can produce invalid children even when the parent is step-aligned.
      const totalStep = multiplyDecimals(pair.stepSize, String(draft.levels));
      if (!isStepAligned(draft.qty, totalStep)) {
        throw new Error(`For ${draft.levels} ladder levels, total quantity must be a multiple of ${totalStep} ${pair.baseAsset}, so each child aligns to step ${pair.stepSize}. Change the amount or number of levels.`);
      }
      const scale = Math.max(draft.qty.split(".")[1]?.length ?? 0, pair.stepSize.split(".")[1]?.length ?? 0);
      const childQty = scaledToDecimal(BigInt(decimalToScaled(draft.qty, scale)) / BigInt(draft.levels!), scale);
      if (compareDecimals(childQty, pair.minQtyBase) < 0 || compareDecimals(multiplyDecimals(childQty, draft.priceMin), pair.minNotionalQuote) < 0) {
        throw new Error(`Each ladder level must meet the minimum ${pair.minQtyBase} ${pair.baseAsset} / ${pair.minNotionalQuote} ${pair.quoteAsset}. Increase total quantity or reduce the number of levels.`);
      }
    }
  }
}
