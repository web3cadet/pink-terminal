import { describe, expect, it } from "vitest";
import { applyOrderAmountInput, resolveQuoteAmount } from "../src/bot/order-sizing.js";
import type { ExchangeGateway, OrderDraft, PairConfig } from "../src/domain.js";

const pair = { symbolId: 1, symbol: "ETH-USDC", baseAsset: "ETH", quoteAsset: "USDC", stepSize: "0.001", quoteQuantityScale: 6 } as PairConfig;
const gateway = {
  getCatalog: async () => ({ assets: [{ asset: "ETH", ledgerId: 1 }, { asset: "USDC", ledgerId: 2 }] }),
  listBalances: async () => [{ assetId: 1, available: "412383096000000000000", reserved: "990000000000000000000" }, { assetId: 2, available: "500000000000000000000" }],
  listMarketOverview: async () => [{ symbolId: 1, bestAsk: "25", bestBid: "20" }]
} as unknown as ExchangeGateway;
const draft = (side: "BUY" | "SELL" = "SELL") => ({ symbolId: 1, symbol: pair.symbol, side, kind: "MARKET_IOC" } as OrderDraft);

describe("percentage sizing safety", () => {
  it("floors a fractional sell percentage to quantity step without using reserved funds", async () => {
    const d = draft(); await applyOrderAmountInput(gateway, pair, d, " 2,5 % ", "quote");
    expect(d).toMatchObject({ balancePercent: "2.5", percentageBalance: "412.383096", percentageAsset: "ETH", qty: "10.309" });
    expect(d.quoteAmount).toBeUndefined();
  });
  it("100% sells only available step-aligned quantity", async () => {
    const d = draft(); await applyOrderAmountInput(gateway, pair, d, "100%", "base");
    expect(d.qty).toBe("412.383");
  });
  it("a 10% buy budgets 50 of 500 quote units including Fee regardless of configured units", async () => {
    for (const mode of ["base", "quote"] as const) {
      const d = draft("BUY"); await applyOrderAmountInput(gateway, pair, d, "10%", mode);
      expect(d.quoteAmount).toBe("50"); await resolveQuoteAmount(gateway, pair, d);
      expect(d.maxQuoteDebit).toBe("50"); expect(d.qty).toBeUndefined();
    }
  });
  it.each(["0%", "-1%", "100.0001%", "NaN%", "1e2%", "10%%", "%", "0.000000000000000000001%"])("rejects invalid/zero-sized %s atomically", async input => {
    const d = { ...draft(), qty: "5" }; const before = structuredClone(d);
    await expect(applyOrderAmountInput(gateway, pair, d, input, "base")).rejects.toThrow();
    expect(d).toEqual(before);
  });
  it("clears percentage metadata when an exact amount replaces it", async () => {
    const d = draft(); await applyOrderAmountInput(gateway, pair, d, "10%", "quote");
    await applyOrderAmountInput(gateway, pair, d, "50", "quote");
    expect(d.quoteAmount).toBe("50"); expect(d.qty).toBeUndefined();
    expect(d.balancePercent).toBeUndefined(); expect(d.percentageAsset).toBeUndefined(); expect(d.percentageBalance).toBeUndefined();
  });
  it("does not treat an unavailable balance as zero or fall back to total funds", async () => {
    const d = draft();
    await expect(applyOrderAmountInput({ ...gateway, listBalances: async () => { throw Error("offline"); } }, pair, d, "10%", "quote")).rejects.toThrow("offline");
    expect(d.qty).toBeUndefined();
    await expect(applyOrderAmountInput({ ...gateway, listBalances: async () => [] }, pair, d, "10%", "quote")).rejects.toThrow("No available ETH");
  });
});
