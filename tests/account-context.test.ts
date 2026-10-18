import { describe, it, expect, vi } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { TradingService, confirmationAccountContext } from "../src/services/trading.js";
import { Logger } from "../src/log.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway } from "../src/domain.js";

const config = { apiUrl: "https://api.testnet.polyester.com", apiKeyId: "fixture-key", apiSecretHex: "a".repeat(64), subaccountId: "1", tradingMode: "live" } as AppConfig;
const logger = new Logger("error");
function intent(db: AppDatabase, operation: "order" | "trigger", context: string | null, status = "previewed") {
  db.createIntent({ id: operation, chatId: 1, userId: 1, operation, clientId: operation, payload: {}, preview: {}, status, expiresAt: Date.now() + 60000, accountContext: context });
}
describe("account-bound confirmations", () => {
  for (const operation of ["order", "trigger"] as const) {
    for (const change of [{ apiKeyId: "other" }, { apiSecretHex: "b".repeat(64) }, { subaccountId: "2" }, { tradingMode: "paper" }, { tradingMode: "read_only" }, { apiUrl: "https://other.invalid" }]) {
      it(`${operation}: invalidates pending confirmation after changing ${JSON.stringify(change)}`, async () => {
        const db = new AppDatabase(":memory:");
        const send = vi.fn(async () => ({ raw: {} }));
        const gateway = { createOrder: send, createTrigger: send } as unknown as ExchangeGateway;
        try {
          intent(db, operation, confirmationAccountContext(config));
          const service = new TradingService({ ...config, ...change } as AppConfig, gateway, db, logger);
          await expect(operation === "order" ? service.confirmOrder(operation, 1, 1) : service.confirmTrigger(operation, 1, 1)).rejects.toThrow(/configuration changed/);
          expect(db.getIntent(operation)?.status).toBe("superseded");
          const restored = new TradingService(config, gateway, db, logger);
          await expect(operation === "order" ? restored.confirmOrder(operation, 1, 1) : restored.confirmTrigger(operation, 1, 1)).rejects.toThrow(/no longer valid/);
          expect(send).not.toHaveBeenCalled();
        } finally { db.close(); }
      });
    }
    it(`${operation}: allows same-account confirmation exactly once`, async () => {
      const db = new AppDatabase(":memory:");
      const send = vi.fn(async () => ({ raw: {} }));
      try {
        intent(db, operation, confirmationAccountContext(config));
        const service = new TradingService(config, { createOrder: send, createTrigger: send } as unknown as ExchangeGateway, db, logger);
        const confirm = () => operation === "order" ? service.confirmOrder(operation, 1, 1) : service.confirmTrigger(operation, 1, 1);
        await confirm();
        await expect(confirm()).rejects.toThrow(/no longer valid/);
        expect(send).toHaveBeenCalledOnce();
      } finally { db.close(); }
    });
  }
  it("invalidates legacy pending buttons, but does not change already submitted history", () => {
    const db = new AppDatabase(":memory:");
    try {
      intent(db, "order", null);
      intent(db, "trigger", null, "accepted");
      new TradingService(config, {} as ExchangeGateway, db, logger);
      expect(db.getIntent("order")?.status).toBe("superseded");
      expect(db.getIntent("trigger")?.status).toBe("accepted");
    } finally { db.close(); }
  });
});
