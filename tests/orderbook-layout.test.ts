import { describe, expect, it } from "vitest";
import { orderBookTable } from "../src/bot/card-copy.js";

describe("order book monospace layout", () => {
  it.each([0, 5, 10, 20])("aligns all rows and separators at depth %i", depth => {
    const asks = Array.from({ length: depth }, (_, i) => ({ price: String(723 + i / 10), qty: i % 2 ? "0.417407" : "14.222176" }));
    const bids = Array.from({ length: depth }, (_, i) => ({ price: String(722 - i / 10), qty: "9.428907" }));
    const rows = orderBookTable(asks, bids).replace(/^<pre>|<\/pre>$/g, "").split("\n");
    expect(new Set(rows.map(row => row.length)).size).toBe(1);
    expect(new Set(rows.map(row => row.search(/[│┼]/))).size).toBe(1);
    expect(rows).toHaveLength(depth * 2 + 3);
    expect(rows.filter(row => row.startsWith("ASK"))).toHaveLength(depth);
    expect(rows.filter(row => row.startsWith("BID"))).toHaveLength(depth);
    if (depth) {
      expect(rows[2]).toContain(asks.at(-1)!.price);
      expect(rows[depth + 1]).toContain(asks[0]!.price);
      expect(rows[depth + 3]).toContain(bids[0]!.price);
    }
    expect(asks[0]?.price).toBe(depth ? "723" : undefined);
  });
  it("keeps large and tiny values within the same bounded columns", () => {
    const rows = orderBookTable([{ price: "0.000000000000001", qty: "123456789012345678" }], [{ price: "5", qty: "2" }])
      .replace(/^<pre>|<\/pre>$/g, "").split("\n");
    expect(new Set(rows.map(row => row.length))).toEqual(new Set([33]));
    expect(new Set(rows.map(row => row.search(/[│┼]/)))).toEqual(new Set([18]));
    expect(rows[2]).toContain("…");
  });
  it("escapes HTML from upstream display values", () => {
    expect(orderBookTable([{ price: "<5", qty: "1&2" }], [])).toContain("&lt;5 │ 1&amp;2");
  });
});
