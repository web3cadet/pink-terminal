import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { PolyesterGateway } from "../src/polyester/gateway.js";
import { PolyesterApiError } from "../src/polyester/transport.js";
import { Logger } from "../src/log.js";

describe("order read-model consistency", () => {
  for (const details of [false, true]) {
    it(`returns null for an order not yet indexed (${details ? "order ID" : "client ID"})`, async () => {
      const gateway = new PolyesterGateway({ apiUrl: "https://fixture.invalid" } as AppConfig, new Logger("error"));
      gateway.getCatalog = async () => ({ assets: [], pairs: [], tsSec: "0" });
      const call = vi.fn().mockRejectedValue(new PolyesterApiError("order not found", 404, "not_found"));
      (gateway as unknown as { transport: { call: typeof call } }).transport.call = call;
      await expect(details ? gateway.getOrderDetails("2") : gateway.getOrderByClientId("pending")).resolves.toBeNull();
      expect(call).toHaveBeenCalledOnce();
    });
  }
  it("does not hide authentication or server errors", async () => {
    const gateway = new PolyesterGateway({ apiUrl: "https://fixture.invalid" } as AppConfig, new Logger("error"));
    gateway.getCatalog = async () => ({ assets: [], pairs: [], tsSec: "0" });
    const error = new PolyesterApiError("unauthorized", 401, "SIGNATURE_INVALID");
    const call = vi.fn().mockRejectedValue(error);
    (gateway as unknown as { transport: { call: typeof call } }).transport.call = call;
    await expect(gateway.getOrderByClientId("pending")).rejects.toBe(error);
  });
});
