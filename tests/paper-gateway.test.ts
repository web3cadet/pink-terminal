import { describe, expect, it } from "vitest";
import type { ExchangeGateway, SpotCatalog } from "../src/domain.js";
import { PaperGateway } from "../src/polyester/paper-gateway.js";

const catalog: SpotCatalog = {
  assets: [{ asset: "BTC", ledgerId: 1, name: "Bitcoin", quantityDisplayDecimals: 8, quantityScale: 8 }],
  pairs: [{
    symbolId: 1, symbol: "BTC-USDT", baseAsset: "BTC", quoteAsset: "USDT", tickSize: "0.01",
    stepSize: "0.00000001", minNotionalQuote: "5", minQtyBase: "0.00001", baseQuantityScale: 8,
    quoteQuantityScale: 6, referencePriceScale: 6, status: "PAIR_STATUS_ENABLED",
    defaultMarketSlippageBpsBuy: 200, defaultMarketSlippageBpsSell: 200, maxClientRefDriftBps: 100
  }],
  tsSec: "1"
};

const publicGateway = { getCatalog: async () => catalog } as unknown as ExchangeGateway;

describe("paper gateway state", () => {
  it("uses the fixed 18-decimal ledger scale", async () => {
    const gateway = new PaperGateway(publicGateway);
    expect((await gateway.listBalances())[0]?.available).toBe("1000000000000000000000");
  });

  it("exposes order details and removes canceled orders from the open list", async () => {
    const gateway = new PaperGateway(publicGateway);
    const receipt = await gateway.createOrder({
      symbolId: 1, symbol: "BTC-USDT", side: "BUY", kind: "LIMIT_GTC", qty: "0.01", price: "50000"
    }, "client-1");
    const details = await gateway.getOrderDetails(receipt.orderId!);
    expect(details?.order.totalQty).toBe("0.01");
    expect(details?.order.cumulativeQty).toBe("0");
    expect(details?.order.leavesQty).toBe("0.01");
    expect(details?.executions).toEqual([]);
    await gateway.cancelOrder("client-1", 1);
    expect(await gateway.listOpenOrders()).toHaveLength(0);
    expect(await gateway.listOrderHistory()).toHaveLength(1);
  });
});
