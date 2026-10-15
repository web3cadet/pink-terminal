import { describe, expect, it } from "vitest";
import { quantityForQuote, resolveQuoteAmount } from "../src/bot/order-sizing.js";
import { formatOrderDraft } from "../src/bot/ui.js";
import type { ExchangeGateway, OrderDraft, PairConfig } from "../src/domain.js";

const pair = { symbolId: 1, symbol: "BNB-USDT", stepSize: "0.001" } as PairConfig;
const gateway = { listMarketOverview: async () => [{ symbolId: 1, bestAsk: "500", bestBid: "400" }] } as unknown as ExchangeGateway;
describe("quote-value order sizing", () => {
  it("does not assume that a testnet stablecoin trades at one USDT", async () => {
    const p = { ...pair, symbol: "USDC-USDT", stepSize: "0.000001" };
    const g = { listMarketOverview: async () => [{ symbolId: 1, bestBid: "0.82" }] } as unknown as ExchangeGateway;
    const draft = { symbolId: 1, symbol: p.symbol, side: "SELL", kind: "MARKET_IOC", quoteAmount: "412" } as OrderDraft;
    await resolveQuoteAmount(g, p, draft);
    expect(draft.qty).toBe("502.439024");
    expect(draft.sizingPrice).toBe("0.82");
    const exact = { symbolId: 1, symbol: p.symbol, side: "SELL", kind: "MARKET_IOC", qty: "412" } as OrderDraft;
    await resolveQuoteAmount(g, p, exact);
    expect(exact.qty).toBe("412");
    expect(exact.quoteAmount).toBeUndefined();
  });
  it("divides and floors to steps exactly, including large and tiny decimals", () => {
    expect(quantityForQuote("100", "500", "0.001")).toBe("0.2");
    expect(quantityForQuote("5", "0.07324", "0.000001")).toBe("68.268705");
    expect(quantityForQuote("1", "3", "0.05")).toBe("0.3");
    expect(quantityForQuote("9007199254740993", "1", "1")).toBe("9007199254740993");
    expect(quantityForQuote("0.000000000000000002", "2", "0.000000000000000001")).toBe("0.000000000000000001");
    for (const args of [["0", "1", "1"], ["1", "0", "1"], ["1", "1", "0"], ["0.1", "1", "1"], ["NaN", "1", "1"]]) {
      expect(() => quantityForQuote(args[0]!, args[1]!, args[2]!)).toThrow();
    }
  });
  for (const side of ["BUY", "SELL"] as const) for (const kind of ["MARKET_IOC", "LIMIT_GTC", "LIMIT_GTD", "LIMIT_IOC", "LIMIT_FOK"] as const) {
    it(`${side} ${kind}: resolves quote value without treating it as token quantity or fee-inclusive budget`, async () => {
      const draft: OrderDraft = { symbolId: 1, symbol: "BNB-USDT", side, kind, quoteAmount: "100", ...(kind === "MARKET_IOC" ? {} : { price: "250" }) };
      await resolveQuoteAmount(gateway, pair, draft);
      expect(draft.qty).toBe(kind === "MARKET_IOC" ? side === "BUY" ? "0.2" : "0.25" : "0.4");
      expect(draft.quoteAmount).toBe("100");
      expect(draft.maxQuoteDebit).toBeUndefined();
      const text = formatOrderDraft(draft);
      expect(text).toContain("100 USDT");
      expect(text).toContain(`${draft.qty} BNB`);
      expect(text).toContain("before Fee");
      expect(text).toContain(side === "SELL" ? "Fee reduces your proceeds" : "Fee is charged in addition");
    });
  }
  it("does not fall back to a last price when the execution side is missing", async () => {
    const draft = { symbolId: 1, side: "SELL", kind: "MARKET_IOC", quoteAmount: "100" } as OrderDraft;
    await expect(resolveQuoteAmount({ listMarketOverview: async () => [{ symbolId: 1, lastPrice: "100" }] } as unknown as ExchangeGateway, pair, draft)).rejects.toThrow("unavailable");
    expect(draft.qty).toBeUndefined();
  });
  it("preserves legacy explicit quantity and quote budget payloads", async () => {
    for (const sizing of [{ qty: "1" }, { maxQuoteDebit: "10" }]) {
      const draft = { symbolId: 1, side: "BUY", kind: "MARKET_IOC", ...sizing } as OrderDraft;
      const before = structuredClone(draft);
      await resolveQuoteAmount(gateway, pair, draft);
      expect(draft).toEqual(before);
    }
  });
});
