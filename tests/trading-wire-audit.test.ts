import { afterEach, describe, expect, it, vi } from "vitest";
import { PolyesterGateway } from "../src/polyester/gateway.js";
import { TradingService } from "../src/services/trading.js";
import { AppDatabase } from "../src/storage/database.js";
import { Logger } from "../src/log.js";
import type { AppConfig } from "../src/config.js";
import type { OrderDraft, TriggerDraft } from "../src/domain.js";

const pair = { symbolId: 1, symbol: "TEST-USDT", baseAsset: "TEST", quoteAsset: "USDT", status: "PAIR_STATUS_ENABLED", minQtyBase: "0.01", minNotionalQuote: "5", stepSize: "0.01", tickSize: "0.01", baseQuantityScale: 2, quoteQuantityScale: 2, referencePriceScale: 2 };
const config = { apiUrl: "https://fixture.invalid", apiKeyId: "fixture", apiSecretHex: "ab".repeat(32), subaccountId: "7", tradingMode: "live", confirmationTtlSeconds: 90 } as AppConfig;
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const writes: Array<{ path: string; body: Record<string, any> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(String(options.body));
    let result: unknown;
    if (pathname.endsWith("GetSpotConfig")) result = { assets: [], pairs: [pair] };
    else if (pathname.endsWith("ListMarketOverview")) result = { markets: [{ symbolId: 1, lastPriceTicks: "1000" }] };
    else if (pathname.endsWith("PreviewOrder")) result = { admissible: true };
    else if (pathname.endsWith("CreateOrder") || pathname.endsWith("CreateTrigger")) {
      expect((options.headers as Record<string, string>)["X-API-SIGNATURE"]).toBeTruthy();
      writes.push({ path: pathname, body }); result = { orderId: "123", triggerId: "124" };
    } else throw Error(`Unexpected mocked endpoint: ${pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  }));
  const db = new AppDatabase(":memory:");
  const logger = new Logger("error");
  const service = new TradingService(config, new PolyesterGateway(config, logger), db, logger);
  return { db, service, writes };
}
describe("offline signed trading pipeline audit", () => {
  for (const side of ["BUY", "SELL"] as const) {
    for (const kind of ["MARKET_IOC", "LIMIT_GTC", "LIMIT_GTD", "LIMIT_IOC", "LIMIT_FOK"] as const) {
      it(`${side} ${kind}: preview then exactly one account-scoped write`, async () => {
        const { db, service, writes } = fixture();
        try {
          const draft: OrderDraft = { symbolId: 1, symbol: pair.symbol, side, kind, qty: "1.25" };
          if (kind !== "MARKET_IOC") draft.price = "10";
          if (kind === "LIMIT_GTD") draft.expireAt = new Date(Date.now() + 60000).toISOString();
          const prepared = await service.prepareOrder(1, 1, draft);
          expect(writes).toHaveLength(0);
          expect(db.getIntent(prepared.id)?.accountContext).toMatch(/^[a-f0-9]{64}$/);
          await expect(service.confirmOrder(prepared.id, 1, 2)).rejects.toThrow("Confirmation not found");
          await service.confirmOrder(prepared.id, 1, 1);
          await expect(service.confirmOrder(prepared.id, 1, 1)).rejects.toThrow(/no longer valid/);
          expect(writes).toHaveLength(1);
          expect(writes[0]?.body.subaccountId).toBe("7");
          expect(writes[0]?.body.order.baseQtyScaled).toBe("125");
          expect(writes[0]?.body.order.side).toBe(side);
          const wireKind = { MARKET_IOC: "marketIoc", LIMIT_GTC: "limitGtc", LIMIT_GTD: "limitGtd", LIMIT_IOC: "limitIoc", LIMIT_FOK: "limitFok" }[kind];
          expect(writes[0]?.body.order[wireKind]).toBeDefined();
          expect(JSON.stringify(writes)).not.toContain(config.apiSecretHex);
          expect(JSON.stringify(writes)).not.toContain("accountContext");
        } finally { db.close(); }
      });
    }
    for (const kind of ["STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP", "TWAP", "LADDER"] as const) {
      if (kind === "TRAILING_STOP" && side === "BUY") continue;
      it(`${side} ${kind}: confirmation sends one strategy without altering account history`, async () => {
        const { db, service, writes } = fixture();
        try {
          const draft: TriggerDraft = { symbolId: 1, symbol: pair.symbol, side, kind, qty: "1", childKind: kind === "TRAILING_STOP" ? "MARKET_IOC" : "LIMIT_GTC", childLimitPrice: "10", triggerPrice: "9", trailingBps: 200, durationMs: 60000, sliceIntervalMs: 10000, priceMin: "9", priceMax: "11", levels: 3 };
          if (kind === "LADDER") draft.qty = "3";
          const prepared = await service.prepareTrigger(1, 1, draft);
          expect(writes).toHaveLength(0);
          await service.confirmTrigger(prepared.id, 1, 1);
          await expect(service.confirmTrigger(prepared.id, 1, 1)).rejects.toThrow(/no longer valid/);
          expect(writes).toHaveLength(1);
          expect(writes[0]?.body.subaccountId).toBe("7");
          expect(writes[0]?.body.trigger.qtyScaled).toBe(kind === "LADDER" ? "300" : "100");
          const wireKind = { STOP_LOSS: "stopLoss", TAKE_PROFIT: "takeProfit", TRAILING_STOP: "trailingStop", TWAP: "twap", LADDER: "ladder" }[kind];
          expect(writes[0]?.body.trigger[wireKind].side).toBe(side);
          expect(db.getIntent(prepared.id)?.status).toBe("accepted");
        } finally { db.close(); }
      });
    }
  }
});
