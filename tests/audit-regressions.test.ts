import { describe, it, expect, vi } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { TradingService, confirmationAccountContext } from "../src/services/trading.js";
import { Logger } from "../src/log.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway } from "../src/domain.js";

const logger = new Logger("error");
const config = { tradingMode: "live" } as AppConfig;
function intent(db: AppDatabase, operation: "order" | "trigger" = "order") {
  db.createIntent({ id: "one", chatId: 1, userId: 1, operation, clientId: "client", payload: {}, preview: {}, status: "previewed", expiresAt: Date.now() + 90_000, accountContext: confirmationAccountContext(config) });
}
describe("audit regressions", () => {
  it("cancelled or edited confirmations cannot submit, even when clicked again", async () => {
    const db = new AppDatabase(":memory:"); intent(db);
    const createOrder = vi.fn();
    const service = new TradingService(config, { createOrder } as unknown as ExchangeGateway, db, logger);
    db.invalidateConfirmations(1, 1);
    await expect(service.confirmOrder("one", 1, 1)).rejects.toThrow("no longer valid");
    expect(createOrder).not.toHaveBeenCalled(); db.close();
  });
  it("keeps uncertain strategy submissions for reconciliation, without a second write", async () => {
    const db = new AppDatabase(":memory:"); intent(db, "trigger");
    const createTrigger = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const service = new TradingService(config, { createTrigger, listTriggers: async () => [{ clientTriggerId: "client", raw: { triggerId: "42" } }] } as unknown as ExchangeGateway, db, logger);
    await expect(service.confirmTrigger("one", 1, 1)).rejects.toThrow("unknown");
    expect(db.getIntent("one")?.status).toBe("unknown");
    await expect(service.confirmTrigger("one", 1, 1)).rejects.toThrow("no longer valid");
    expect(await service.reconcileUnknownOrders()).toBe(1);
    expect(db.getIntent("one")?.status).toBe("reconciled");
    expect(createTrigger).toHaveBeenCalledOnce(); db.close();
  });
  it("finds attached-risk fills after the parent is fully indexed and paginates executions", async () => {
    const db = new AppDatabase(":memory:"); intent(db);
    db.finishIntent("one", "accepted", { orderId: "99" }, null);
    db.markBotVolumeOrderComplete("client", 1, "FILLED");
    const child = { orderId: "child", status: "FILLED", cumulativeQty: "2", raw: { origin: { parentOrderId: "99", triggerId: "88" } } };
    const getOrderDetails = vi.fn(async (_id: string, token?: string) => ({ order: child, executions: [{ matchId: token ? "b" : "a", price: "10", qty: "1" }], nextPageToken: token ? "" : "next" }));
    const service = new TradingService(config, { listOrderHistory: async () => [child], getOrderDetails } as unknown as ExchangeGateway, db, logger);
    expect(await service.syncBotTradingVolume()).toBe(2);
    expect(db.getBotTradingVolume(1)).toBe("20");
    expect(await service.syncBotTradingVolume()).toBe(0);
    expect(getOrderDetails).toHaveBeenCalledTimes(2); db.close();
  });
  it("does not finalize volume before delayed executions become visible", async () => {
    const db = new AppDatabase(":memory:"); intent(db); db.finishIntent("one", "accepted", {}, null);
    const order = { orderId: "order", status: "FILLED", cumulativeQty: "1", raw: {} };
    let visible = false;
    const service = new TradingService(config, { getOrderByClientId: async () => order, getOrderDetails: async () => ({ order, executions: visible ? [{ matchId: "fill", price: "7", qty: "1" }] : [] }) } as unknown as ExchangeGateway, db, logger);
    expect(await service.syncBotTradingVolume()).toBe(0);
    expect(db.isBotVolumeOrderComplete("client")).toBe(false);
    visible = true;
    expect(await service.syncBotTradingVolume()).toBe(1);
    expect(db.getBotTradingVolume(1)).toBe("7"); db.close();
  });
});
