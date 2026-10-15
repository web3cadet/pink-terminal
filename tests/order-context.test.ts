import { describe, expect, it } from "vitest";
import type { ExchangeGateway, PairConfig, OrderDraft } from "../src/domain.js";
import { orderBalances, orderMinimums } from "../src/bot/order-context.js";
import { orderRejection } from "../src/services/order-rejection.js";

const pair = { baseAsset: "AVAX", quoteAsset: "USDT", minNotionalQuote: "5", minQtyBase: "0.1", stepSize: "0.000001", quoteQuantityScale: 6 } as PairConfig;
describe("order context", () => {
  it("shows available ledger balances using 18 decimals, not order scales", async () => {
    const gateway = {
      getCatalog: async () => ({ assets: [{ asset: "AVAX", ledgerId: "a" }, { asset: "USDT", ledgerId: "u" }] }),
      listBalances: async () => [{ assetId: "a", available: "1250000000000000000", locked: "9000000000000000000" }, { assetId: "u", available: "5000000000000000000" }]
    } as unknown as ExchangeGateway;
    expect(await orderBalances(gateway, pair)).toContain("AVAX: <b>1.25</b> · USDT: <b>5</b>");
  });
  it("does not misrepresent failed balance reads as zero", async () => {
    const gateway = { getCatalog: async () => { throw new Error("offline"); }, listBalances: async () => [] } as unknown as ExchangeGateway;
    expect(await orderBalances(gateway, pair)).toContain("AVAX: unavailable · USDT: unavailable");
  });
  it("uses pair minimums without inventing a minimum budget", () => {
    expect(orderMinimums(pair, true)).toContain("5 USDT");
    expect(orderMinimums(pair, true)).toContain("includes quote fees");
    const draft = { maxQuoteDebit: "5" } as OrderDraft;
    const message = orderRejection({ admissible: false, rejectionCode: "ERROR_CODE_MAX_QUOTE_DEBIT_TOO_SMALL", raw: {} }, pair, draft);
    expect(message).toContain("budget of 5 USDT");
    expect(message).toContain("exact minimum budget was not provided");
    expect(draft.maxQuoteDebit).toBe("5");
  });
});
