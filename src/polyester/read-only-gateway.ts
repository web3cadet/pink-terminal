import type {
  Balance,
  Candle,
  ExchangeGateway,
  MarketOverview,
  OrderDetails,
  OrderDraft,
  OrderPreview,
  OrderReceipt,
  OrderSummary,
  Orderbook,
  SpotCatalog,
  TriggerDraft,
  TriggerSummary
} from "../domain.js";

export class ReadOnlyGateway implements ExchangeGateway {
  constructor(private readonly gateway: ExchangeGateway) {}

  getCatalog(force?: boolean): Promise<SpotCatalog> { return this.gateway.getCatalog(force); }
  listMarketOverview(): Promise<MarketOverview[]> { return this.gateway.listMarketOverview(); }
  getOrderbook(symbolId: number, depth?: number): Promise<Orderbook> { return this.gateway.getOrderbook(symbolId, depth); }
  getCandles(symbolId: number, timeframe: string, limit?: number): Promise<Candle[]> { return this.gateway.getCandles(symbolId, timeframe, limit); }
  listBalances(): Promise<Balance[]> { return this.gateway.listBalances(); }
  getAccountStats(): Promise<{ volume30dUsd?: string; asOf?: string }> { return this.gateway.getAccountStats?.() ?? Promise.resolve({}); }
  getSpotFeeRates(symbolId: number): Promise<{ maker: string; taker: string }> {
    return this.gateway.getSpotFeeRates?.(symbolId) ?? Promise.reject(new Error("Fee rates are unavailable"));
  }
  previewOrder(draft: OrderDraft, clientOrderId: string): Promise<OrderPreview> { return this.gateway.previewOrder(draft, clientOrderId); }
  listOpenOrders(symbolId?: number): Promise<OrderSummary[]> { return this.gateway.listOpenOrders(symbolId); }
  listOrderHistory(symbolId?: number): Promise<OrderSummary[]> { return this.gateway.listOrderHistory(symbolId); }
  getOrderByClientId(clientOrderId: string): Promise<OrderSummary | null> { return this.gateway.getOrderByClientId(clientOrderId); }
  getOrderDetails(orderId: string, pageToken?: string): Promise<OrderDetails | null> { return this.gateway.getOrderDetails(orderId, pageToken); }
  listTriggers(symbolId?: number): Promise<TriggerSummary[]> { return this.gateway.listTriggers(symbolId); }

  createOrder(_draft: OrderDraft, _clientOrderId: string): Promise<OrderReceipt> { return this.blocked("order creation"); }
  cancelOrder(_clientOrderId: string, _symbolId: number): Promise<Record<string, unknown>> { return this.blocked("order cancellation"); }
  cancelAll(_symbolIds: number[], _dryRun: boolean, _requestId: string): Promise<Record<string, unknown>> { return this.blocked("bulk order cancellation"); }
  createTrigger(_draft: TriggerDraft, _clientTriggerId: string): Promise<Record<string, unknown>> { return this.blocked("trigger creation"); }
  cancelTrigger(_triggerId: string, _symbolId: number): Promise<Record<string, unknown>> { return this.blocked("trigger cancellation"); }
  pauseTrigger(_triggerId: string, _symbolId: number): Promise<Record<string, unknown>> { return this.blocked("trigger pause"); }
  resumeTrigger(_triggerId: string, _symbolId: number): Promise<Record<string, unknown>> { return this.blocked("trigger resume"); }

  private blocked<T>(operation: string): Promise<T> {
    return Promise.reject(new Error(`Read-only mode blocks ${operation}`));
  }
}
