import type { OrderDraft, OrderPreview, PairConfig } from "../domain.js";

export function orderRejection(preview: OrderPreview, pair: PairConfig, draft: OrderDraft): string {
  if (preview.rejectionCode?.endsWith("MAX_QUOTE_DEBIT_TOO_SMALL")) {
    return `Polyester rejected the budget of ${draft.maxQuoteDebit ?? "—"} ${pair.quoteAsset} as too small.\n` +
      `The pair's minimum order value is ${pair.minNotionalQuote} ${pair.quoteAsset}, but your total budget must also cover quote fees and a valid rounded quantity at the protected price.\n` +
      "Increase the budget or choose Buy amount. The exact minimum budget was not provided by the API. Your amount has not been changed.";
  }
  return `Order rejected by Polyester: ${preview.rejectionCode ?? "UNKNOWN"} ${preview.rejectionMessage ?? ""}`.trim();
}
