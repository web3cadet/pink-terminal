import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { MarketOverview, PairConfig } from "../src/domain.js";
import { RiskGuard } from "../src/services/risk.js";

const config: AppConfig = {
  telegramToken: "test", allowedChatIds: new Set([1]), allowedUserIds: new Set(),
  apiUrl: "https://api.testnet.polyester.com", tradingMode: "paper", confirmationTtlSeconds: 90,
  databasePath: ":memory:", pollIntervalMs: 15_000, logLevel: "error"
};

const pair: PairConfig = {
  symbolId: 1, symbol: "BTC-USDT", baseAsset: "BTC", quoteAsset: "USDT", tickSize: "0.01",
  stepSize: "0.00000001", minNotionalQuote: "5", minQtyBase: "0.00001", baseQuantityScale: 8,
  quoteQuantityScale: 6, referencePriceScale: 9, status: "PAIR_STATUS_ENABLED",
  defaultMarketSlippageBpsBuy: 200, defaultMarketSlippageBpsSell: 200, maxClientRefDriftBps: 100
};

describe("local risk guard", () => {
  const guard = new RiskGuard(config);
  it("checks market notional against the execution side instead of a stale last trade", () => {
    const p = { ...pair, symbol: "USDC-USDT", baseAsset: "USDC", stepSize: "0.000001", minQtyBase: "1" };
    const market = { symbolId: 1, lastPrice: "0.63", bestAsk: "0.978", bestBid: "0.62" } as MarketOverview;
    expect(() => guard.validateOrder({ symbolId: 1, symbol: p.symbol, side: "BUY", kind: "MARKET_IOC", qty: "6.34", quoteAmount: "6.2", sizingPrice: "0.978" }, p, market)).not.toThrow();
    expect(() => guard.validateOrder({ symbolId: 1, symbol: p.symbol, side: "SELL", kind: "MARKET_IOC", qty: "6.34" }, p, market)).toThrow(/Minimum notional/);
  });

  it("rejects a ladder whose equal children violate the quantity step", () => {
    const p = { ...pair, baseAsset: "ETC", stepSize: "0.000001", minQtyBase: "0.1" };
    const draft = { symbolId: 1, symbol: "ETC-USDT", kind: "LADDER", side: "BUY", qty: "1.627237", childKind: "LIMIT_GTC", priceMin: "8", priceMax: "9", levels: 2 } as const;
    expect(() => guard.validateTrigger(draft, p)).toThrow(/multiple of 0.000002/);
    expect(() => guard.validateTrigger({ ...draft, qty: "1.627236" }, p)).not.toThrow();
    expect(() => guard.validateTrigger({ ...draft, qty: "1" }, p)).toThrow(/Each ladder level/);
    expect(() => guard.validateTrigger({ ...draft, qty: "2", priceMin: "8.001" }, p)).toThrow(/price step/);
  });

  it("accepts a bounded limit order", () => {
    expect(() => guard.validateOrder({ symbolId: 1, symbol: "BTC-USDT", side: "BUY", kind: "LIMIT_GTC", qty: "0.0001", price: "80000" }, pair, undefined)).not.toThrow();
  });

  it("does not impose an artificial local notional or slippage cap", () => {
    expect(() => guard.validateOrder({ symbolId: 1, symbol: "BTC-USDT", side: "BUY", kind: "LIMIT_GTC", qty: "0.1", price: "80000", maxSlippageBps: 10_000 }, pair, undefined)).not.toThrow();
  });

  it("rejects unsupported BUY market conditional triggers", () => {
    expect(() => guard.validateTrigger({
      kind: "STOP_LOSS",
      symbolId: 1,
      symbol: "BTC-USDT",
      side: "BUY",
      qty: "0.01",
      triggerPrice: "50000",
      childKind: "MARKET_IOC"
    }, pair)).toThrow(/BUY market children/);
  });

  it("does not impose an artificial local trigger slippage cap", () => {
    expect(() => guard.validateTrigger({
      kind: "TRAILING_STOP",
      symbolId: 1,
      symbol: "BTC-USDT",
      side: "SELL",
      qty: "0.01",
      trailingBps: 250,
      childKind: "MARKET_IOC",
      maxSlippageBps: 10_000
    }, pair)).not.toThrow();
  });
});
