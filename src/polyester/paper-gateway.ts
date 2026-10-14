import { randomUUID } from "node:crypto";
import type {
  Balance, Candle, ExchangeGateway, MarketOverview, OrderDetails, OrderDraft, OrderPreview, OrderReceipt, OrderSummary,
  Orderbook, SpotCatalog, TriggerDraft, TriggerSummary
} from "../domain.js";

export class PaperGateway implements ExchangeGateway {
  private readonly orders: OrderSummary[] = [];
  private readonly triggers: TriggerSummary[] = [];

  constructor(private readonly publicGateway: ExchangeGateway) {}

  getCatalog(force?: boolean): Promise<SpotCatalog> { return this.publicGateway.getCatalog(force); }
  listMarketOverview(): Promise<MarketOverview[]> { return this.publicGateway.listMarketOverview(); }
  getOrderbook(symbolId: number, depth?: number): Promise<Orderbook> { return this.publicGateway.getOrderbook(symbolId, depth); }
  getCandles(symbolId: number, timeframe: string, limit?: number): Promise<Candle[]> { return this.publicGateway.getCandles(symbolId, timeframe, limit); }

  async listBalances(): Promise<Balance[]> {
    const catalog = await this.getCatalog();
    return catalog.assets.slice(0, 8).map((asset) => ({
      assetId: asset.ledgerId,
      trading: "1000000000000000000000",
      funding: "0",
      reserved: "0",
      available: "1000000000000000000000"
    }));
  }

  async previewOrder(draft: OrderDraft, _clientOrderId: string): Promise<OrderPreview> {
    return { admissible: true, raw: { paper: true, draft } };
  }

  async createOrder(draft: OrderDraft, clientOrderId: string): Promise<OrderReceipt> {
    const orderId = `paper-${randomUUID().slice(0, 8)}`;
    this.orders.unshift({
      orderId, clientOrderId, symbolId: draft.symbolId, side: draft.side, status: "PAPER_ACCEPTED",
      ...(draft.price ? { price: draft.price } : {}),
      ...(draft.qty ?? draft.maxQuoteDebit ? { qty: draft.qty ?? draft.maxQuoteDebit!, totalQty: draft.qty ?? draft.maxQuoteDebit!, leavesQty: draft.qty ?? draft.maxQuoteDebit! } : {}),
      cumulativeQty: "0", orderType: draft.kind, createdAt: new Date().toISOString(), raw: { paper: true, draft }
    });
    return { orderId, clientOrderId, acceptedAt: new Date().toISOString(), status: "paper", raw: { paper: true } };
  }

  async listOpenOrders(symbolId?: number): Promise<OrderSummary[]> {
    return this.orders.filter((order) => order.status === "PAPER_ACCEPTED" && (symbolId === undefined || order.symbolId === symbolId));
  }
  async listOrderHistory(symbolId?: number): Promise<OrderSummary[]> {
    return this.orders.filter((order) => symbolId === undefined || order.symbolId === symbolId);
  }
  async getOrderByClientId(clientOrderId: string): Promise<OrderSummary | null> { return this.orders.find((order) => order.clientOrderId === clientOrderId) ?? null; }
  async getOrderDetails(orderId: string): Promise<OrderDetails | null> {
    const order = this.orders.find((item) => item.orderId === orderId);
    return order ? { order, executions: [], executionCount: 0, transferCount: 0, raw: { paper: true } } : null;
  }
  async cancelOrder(clientOrderId: string, _symbolId: number): Promise<Record<string, unknown>> {
    const order = this.orders.find((item) => item.clientOrderId === clientOrderId);
    if (order) order.status = "PAPER_CANCELED";
    return { paper: true, status: order ? "CANCELED" : "NOT_FOUND" };
  }
  async cancelAll(symbolIds: number[], dryRun: boolean, requestId: string): Promise<Record<string, unknown>> {
    const matches = this.orders.filter((order) => order.status === "PAPER_ACCEPTED" && (symbolIds.length === 0 || symbolIds.includes(order.symbolId)));
    if (!dryRun) for (const order of matches) order.status = "PAPER_CANCELED";
    return { paper: true, requestId, dryRun, matchedOrders: matches.length, submittedCancels: dryRun ? 0 : matches.length };
  }
  async listTriggers(symbolId?: number): Promise<TriggerSummary[]> { return this.triggers.filter((trigger) => symbolId === undefined || trigger.symbolId === symbolId); }
  async createTrigger(draft: TriggerDraft, clientTriggerId: string): Promise<Record<string, unknown>> {
    const triggerId = `paper-${randomUUID().slice(0, 8)}`;
    this.triggers.unshift({ triggerId, clientTriggerId, symbolId: draft.symbolId, type: draft.kind, status: "PAPER_ARMED", side: draft.side, raw: { paper: true, draft } });
    return { paper: true, triggerId, clientTriggerId, status: "PAPER_ARMED" };
  }
  async cancelTrigger(triggerId: string, _symbolId: number): Promise<Record<string, unknown>> { return this.updateTrigger(triggerId, "PAPER_CANCELED"); }
  async pauseTrigger(triggerId: string, _symbolId: number): Promise<Record<string, unknown>> { return this.updateTrigger(triggerId, "PAPER_PAUSED"); }
  async resumeTrigger(triggerId: string, _symbolId: number): Promise<Record<string, unknown>> { return this.updateTrigger(triggerId, "PAPER_ARMED"); }

  private updateTrigger(triggerId: string, status: string): Record<string, unknown> {
    const trigger = this.triggers.find((item) => item.triggerId === triggerId);
    if (trigger) trigger.status = status;
    return { paper: true, triggerId, status: trigger ? status : "NOT_FOUND" };
  }
}
