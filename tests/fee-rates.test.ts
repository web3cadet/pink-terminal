import { afterEach, describe, expect, it, vi } from "vitest";
import { PolyesterGateway } from "../src/polyester/gateway.js";
import { ConnectJsonTransport } from "../src/polyester/transport.js";
import { orderFeeLine } from "../src/bot/order-context.js";
import { Logger } from "../src/log.js";
import type { AppConfig } from "../src/config.js";
import type { ExchangeGateway } from "../src/domain.js";

afterEach(() => vi.restoreAllMocks());
const gateway = () => new PolyesterGateway({ apiUrl: "https://example.invalid", subaccountId: "123" } as AppConfig, new Logger("error"));
describe("confirmation fee rates", () => {
  it("requests authenticated rates for the exact pair and subaccount", async () => {
    const call = vi.spyOn(ConnectJsonTransport.prototype, "call").mockResolvedValue({
      feeRates: [{ symbolId: 99, makerFeeRatePercent: "9", takerFeeRatePercent: "9" },
        { symbolId: 15, makerFeeRatePercent: "0.1", takerFeeRatePercent: "0.15" }]
    });
    expect(await orderFeeLine(gateway(), 15)).toBe("Fee: Maker <b>0.1%</b> · Taker <b>0.15%</b>");
    expect(call).toHaveBeenCalledWith("/fees.v1.FeeService/GetSpotFeeRates", { symbolId: [15], subaccountId: "123" }, { authenticated: true, timeoutMs: 4000 });
  });
  it("preserves a maker rebate and zero taker rate", async () => {
    vi.spyOn(ConnectJsonTransport.prototype, "call").mockResolvedValue({ feeRates: [{ symbolId: 15, makerFeeRatePercent: "-0.01", takerFeeRatePercent: "0" }] });
    expect(await orderFeeLine(gateway(), 15)).toBe("Fee: Maker <b>-0.01%</b> · Taker <b>0%</b>");
  });
  it.each([{}, { feeRates: [{ symbolId: 15, makerFeeRatePercent: "bad", takerFeeRatePercent: "0.15" }] }, { feeRates: [{ symbolId: 15, makerFeeRatePercent: "0.1", takerFeeRatePercent: "-1" }] }])("does not fabricate missing or invalid rates", async raw => {
    vi.spyOn(ConnectJsonTransport.prototype, "call").mockResolvedValue(raw);
    expect(await orderFeeLine(gateway(), 15)).toBe("Fee: unavailable");
  });
  it("does not block confirmation on API failure or unsupported gateways", async () => {
    vi.spyOn(ConnectJsonTransport.prototype, "call").mockRejectedValue(new Error("offline"));
    expect(await orderFeeLine(gateway(), 15)).toBe("Fee: unavailable");
    expect(await orderFeeLine({} as ExchangeGateway, 15)).toBe("Fee: unavailable");
  });
});
