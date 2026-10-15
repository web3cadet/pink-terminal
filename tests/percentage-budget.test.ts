import { describe, expect, it, vi } from "vitest";
import { applyOrderAmountInput, resolveQuoteAmount } from "../src/bot/order-sizing.js";
import { formatOrderDraft } from "../src/bot/ui.js";
import { PolyesterGateway } from "../src/polyester/gateway.js";
import { Logger } from "../src/log.js";
import { compareDecimals, multiplyDecimals } from "../src/utils/decimal.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway, OrderDraft, PairConfig } from "../src/domain.js";

const pair = { symbolId: 1, symbol: "AVAX-USDT", baseAsset: "AVAX", quoteAsset: "USDT", stepSize: "0.000001", quoteQuantityScale: 6, baseQuantityScale: 6, referencePriceScale: 6 } as PairConfig;
const gateway = {
  getCatalog: async () => ({ assets: [{ asset: "USDT", ledgerId: 1 }], pairs: [pair], tsSec: "0" }),
  listBalances: async () => [{ assetId: 1, available: "2976474247000000000000", reserved: "100000000000000000000" }],
  listMarketOverview: async () => [{ symbolId: 1, bestAsk: "9.909", bestBid: "9.9" }],
  getSpotFeeRates: async () => ({ maker: "0.1", taker: "0.15" })
} as unknown as ExchangeGateway;

describe("all-in percentage buy budgets", () => {
  for (const percent of ["10%", "96%", "100%"]) for (const kind of ["MARKET_IOC", "LIMIT_IOC", "LIMIT_GTC", "LIMIT_GTD", "LIMIT_FOK"] as const) {
    it(`${kind} ${percent} reserves Fee inside the chosen share`, async () => {
      const draft = { symbolId: 1, symbol: pair.symbol, side: "BUY", kind, ...(kind !== "MARKET_IOC" ? { price: "9.909" } : {}) } as OrderDraft;
      await applyOrderAmountInput(gateway, pair, draft, percent, "base");
      await resolveQuoteAmount(gateway, pair, draft);
      const ceiling = multiplyDecimals("2976.474247", String(Number(percent.slice(0, -1)) / 100));
      if (kind === "MARKET_IOC" || kind === "LIMIT_IOC") {
        expect(draft.qty).toBeUndefined();
        expect(draft.sizingPrice).toBeUndefined();
        expect(compareDecimals(draft.maxQuoteDebit!, ceiling)).toBeLessThanOrEqual(0);
        expect(compareDecimals(draft.maxQuoteDebit!, "2976.474247")).toBeLessThanOrEqual(0);
        // Check actual ConnectRPC payloads for both preview and submission.
        const real = new PolyesterGateway({ apiUrl: "https://fixture.invalid" } as AppConfig, new Logger("error"));
        real.getCatalog = gateway.getCatalog;
        const call = vi.fn().mockResolvedValue({ admissible: true });
        (real as unknown as { transport: { call: typeof call } }).transport.call = call;
        await real.previewOrder(draft, "preview"); await real.createOrder(draft, "create");
        for (const [, payload] of call.mock.calls) {
          expect(payload.order.maxQuoteDebitScaled).toBeDefined();
          expect(payload.order.baseQtyScaled).toBeUndefined();
          expect(payload.order.feeAsset).toBe("QUOTE");
        }
      } else {
        expect(draft.maxQuoteDebit).toBeUndefined();
        expect(compareDecimals(multiplyDecimals(multiplyDecimals(draft.qty!, "9.909"), "1.0015"), ceiling)).toBeLessThanOrEqual(0);
        expect(compareDecimals(draft.qty!, "0")).toBeGreaterThan(0);
      }
      const card = formatOrderDraft(draft);
      expect(card).toContain("including Fee");
      expect(card).not.toContain("Fee is charged in addition");
      const frozen = structuredClone(draft);
      await resolveQuoteAmount({ ...gateway, listBalances: async () => { throw Error("Must not reread percentage balance"); } }, pair, draft);
      expect(draft).toEqual(frozen);
    });
  }
  it.each([{ maker: "0.5", taker: "0.1" }, { maker: "-0.05", taker: "0.05" }, { maker: "0", taker: "0" }])("uses current effective rates %j", async rates => {
    const draft = { symbolId: 1, side: "BUY", kind: "LIMIT_GTC", price: "10", quoteAmount: "100", balancePercent: "100" } as OrderDraft;
    await resolveQuoteAmount({ ...gateway, getSpotFeeRates: async () => rates }, pair, draft);
    const total = Number(draft.qty) * 10 * (1 + Math.max(0, Number(rates.maker), Number(rates.taker)) / 100);
    expect(total).toBeLessThanOrEqual(100);
    expect(total).toBeGreaterThan(99.99);
  });
  it("fails closed when fee rates are unavailable for a resting limit", async () => {
    const draft = { symbolId: 1, side: "BUY", kind: "LIMIT_GTC", price: "10", quoteAmount: "100", balancePercent: "100" } as OrderDraft;
    await expect(resolveQuoteAmount({ ...gateway, getSpotFeeRates: undefined }, pair, draft)).rejects.toThrow("Fee rates are unavailable");
    expect(draft.qty).toBeUndefined();
  });
  it("native budgets do not depend on best Ask or locally fetched fees", async () => {
    const draft = { symbolId: 1, side: "BUY", kind: "MARKET_IOC", quoteAmount: "100.123456789", balancePercent: "100", qty: "50", sizingPrice: "2" } as OrderDraft;
    await resolveQuoteAmount({ ...gateway, listMarketOverview: async () => { throw Error("offline"); }, getSpotFeeRates: undefined }, pair, draft);
    expect(draft.maxQuoteDebit).toBe("100.123456");
    expect(draft.qty).toBeUndefined(); expect(draft.sizingPrice).toBeUndefined();
  });
});
