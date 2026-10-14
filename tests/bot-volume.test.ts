import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway } from "../src/domain.js";
import { Logger } from "../src/log.js";
import { TradingService } from "../src/services/trading.js";
import { AppDatabase } from "../src/storage/database.js";

describe("bot trading volume", () => {
  it("counts completed executions, not admitted order size, without double counting", async () => {
    const database = new AppDatabase(":memory:");
    database.createIntent({
      id: "intent-1", chatId: 1, userId: 42, operation: "order", clientId: "tg-order-1",
      payload: { symbolId: 1 }, preview: {}, status: "accepted", expiresAt: Date.now() + 60_000
    });
    const getOrderByClientId = vi.fn(async () => ({
      orderId: "order-1", clientOrderId: "tg-order-1", symbolId: 1, side: "BUY", status: "ORDER_STATUS_FILLED", raw: {}
    }));
    const getOrderDetails = vi.fn(async () => ({
      order: { orderId: "order-1", clientOrderId: "tg-order-1", symbolId: 1, side: "BUY", status: "ORDER_STATUS_FILLED", raw: {} },
      executions: [
        { matchId: "match-1", price: "100", qty: "0.5" },
        { matchId: "match-2", price: "80", qty: "1.25" }
      ],
      executionCount: 2, transferCount: 0, raw: {}
    }));
    const gateway = { getOrderByClientId, getOrderDetails } as unknown as ExchangeGateway;
    const service = new TradingService({ tradingMode: "live" } as AppConfig, gateway, database, new Logger("error"));

    expect(await service.syncBotTradingVolume()).toBe(2);
    expect(database.getBotTradingVolume(42)).toBe("150");
    expect(await service.syncBotTradingVolume()).toBe(0);
    expect(getOrderByClientId).toHaveBeenCalledOnce();
    expect(getOrderDetails).toHaveBeenCalledOnce();
    database.close();
  });

  it("attributes child-order fills to a strategy created by this bot", async () => {
    const database = new AppDatabase(":memory:");
    database.createIntent({
      id: "trigger-intent", chatId: 1, userId: 77, operation: "trigger", clientId: "tr-local",
      payload: { symbolId: 1 }, preview: null, status: "accepted", expiresAt: Date.now() + 60_000
    });
    database.finishIntent("trigger-intent", "accepted", { triggerId: "9001" }, null);
    const childOrder = {
      orderId: "child-1", symbolId: 1, side: "BUY", status: "ORDER_STATUS_FILLED",
      raw: { origin: { triggerId: "9001", childSeq: 1 } }
    };
    const gateway = {
      listOrderHistory: vi.fn(async () => [childOrder]),
      getOrderDetails: vi.fn(async () => ({
        order: childOrder,
        executions: [{ matchId: "strategy-match", price: "25", qty: "4" }],
        executionCount: 1, transferCount: 0, raw: {}
      }))
    } as unknown as ExchangeGateway;
    const service = new TradingService({ tradingMode: "live" } as AppConfig, gateway, database, new Logger("error"));

    expect(await service.syncBotTradingVolume()).toBe(1);
    expect(database.getBotTradingVolume(77)).toBe("100");
    expect(await service.syncBotTradingVolume()).toBe(0);
    database.close();
  });
});
