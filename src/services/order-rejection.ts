import type { OrderDraft, OrderPreview, PairConfig } from "../domain.js";

export function orderRejection(preview: OrderPreview, pair: PairConfig, draft: OrderDraft): string {
  if (preview.rejectionCode?.endsWith("INSUFFICIENT_FUNDS")) {
    const amount = draft.qty ? `${draft.qty} ${pair.baseAsset}` : `${draft.maxQuoteDebit ?? "—"} ${pair.quoteAsset}`;
    return `Not enough available funds to ${draft.side === "SELL" ? "sell" : "buy"} ${amount}.\n` +
      (draft.side === "SELL" ? `Check your available ${pair.baseAsset} balance and any funds reserved by open orders.`
        : `Your available ${pair.quoteAsset} must cover the trade, Fee and any required price protection. Reduce the amount or release funds reserved by open orders.`);
  }
  if (preview.rejectionCode?.endsWith("MAX_QUOTE_DEBIT_TOO_SMALL")) {
    return `Polyester rejected the budget of ${draft.maxQuoteDebit ?? "—"} ${pair.quoteAsset} as too small.\n` +
      `The pair's minimum order value is ${pair.minNotionalQuote} ${pair.quoteAsset}, but your total budget must also cover quote fees and a valid rounded quantity at the protected price.\n` +
      "Increase the budget or choose Buy amount. The exact minimum budget was not provided by the API. Your amount has not been changed.";
  }
  return `Order rejected by Polyester: ${preview.rejectionCode ?? "UNKNOWN"} ${preview.rejectionMessage ?? ""}`.trim();
}
