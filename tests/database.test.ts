import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/storage/database.js";

describe("durable intent journal", () => {
  it("permits only one confirmation transition", () => {
    const db = new AppDatabase(":memory:");
    db.createIntent({
      id: "intent-1", chatId: 1, userId: 2, operation: "order", clientId: "client-1",
      payload: { symbolId: 1 }, preview: { admissible: true }, status: "previewed", expiresAt: Date.now() + 1000
    });
    expect(db.transitionIntent("intent-1", ["previewed"], "sending")).toBe(true);
    expect(db.transitionIntent("intent-1", ["previewed"], "sending")).toBe(false);
    expect(db.getIntent("intent-1")?.status).toBe("sending");
    db.close();
  });

  it("stores each bot fill once and sums exact quote volume", () => {
    const db = new AppDatabase(":memory:");
    expect(db.recordBotFillVolume(2, "tg-1", "fill-1", "10.25")).toBe(true);
    expect(db.recordBotFillVolume(2, "tg-1", "fill-1", "10.25")).toBe(false);
    expect(db.recordBotFillVolume(2, "tg-1", "fill-2", "2.09")).toBe(true);
    expect(db.getBotTradingVolume(2)).toBe("12.34");
    expect(db.getBotTradingVolume(3)).toBe("0");
    db.close();
  });
});
