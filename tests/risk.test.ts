import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { PairConfig } from "../src/domain.js";
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
