import { describe, expect, it, vi } from "vitest";
import type { ExchangeGateway } from "../src/domain.js";
import { ReadOnlyGateway } from "../src/polyester/read-only-gateway.js";

describe("read-only gateway", () => {
  it("delegates reads", async () => {
    const listBalances = vi.fn(async () => []);
    const source = { listBalances } as unknown as ExchangeGateway;
    const gateway = new ReadOnlyGateway(source);
    await expect(gateway.listBalances()).resolves.toEqual([]);
    expect(listBalances).toHaveBeenCalledOnce();
  });

  it("blocks every mutation before reaching the source gateway", async () => {
    const source = {
      createOrder: vi.fn(), cancelOrder: vi.fn(), cancelAll: vi.fn(),
      createTrigger: vi.fn(), cancelTrigger: vi.fn(), pauseTrigger: vi.fn(), resumeTrigger: vi.fn()
    } as unknown as ExchangeGateway;
    const gateway = new ReadOnlyGateway(source);
    const order = { symbolId: 1, symbol: "BTC-USDT", side: "BUY", kind: "MARKET_IOC", qty: "1" } as const;
    const trigger = { symbolId: 1, symbol: "BTC-USDT", side: "SELL", kind: "STOP_LOSS", qty: "1", childKind: "MARKET_IOC" } as const;

    await expect(gateway.createOrder(order, "client")).rejects.toThrow("Read-only mode blocks order creation");
    await expect(gateway.cancelOrder("client", 1)).rejects.toThrow("Read-only mode blocks order cancellation");
    await expect(gateway.cancelAll([], true, "request")).rejects.toThrow("Read-only mode blocks bulk order cancellation");
    await expect(gateway.createTrigger(trigger, "trigger")).rejects.toThrow("Read-only mode blocks trigger creation");
    await expect(gateway.cancelTrigger("trigger", 1)).rejects.toThrow("Read-only mode blocks trigger cancellation");
    await expect(gateway.pauseTrigger("trigger", 1)).rejects.toThrow("Read-only mode blocks trigger pause");
    await expect(gateway.resumeTrigger("trigger", 1)).rejects.toThrow("Read-only mode blocks trigger resume");
    expect(source.createOrder).not.toHaveBeenCalled();
    expect(source.cancelOrder).not.toHaveBeenCalled();
    expect(source.cancelAll).not.toHaveBeenCalled();
    expect(source.createTrigger).not.toHaveBeenCalled();
  });
});
