import { describe, expect, it } from "bun:test";
import { formatAmount, parseAmount, parsePositiveAmount, settlementAsset } from "../src/lib/amounts";

describe("integer token amounts", () => {
  it("parses and formats without floating point", () => {
    expect(parseAmount("1.25", 6)).toBe("1250000");
    expect(parseAmount("0001.250000", 6)).toBe("1250000");
    expect(formatAmount("1250000", 6)).toBe("1.25");
    expect(formatAmount("1000000000000000000001", 18)).toBe("1000.000000000000000001");
  });

  it("rejects precision and unsafe input", () => {
    expect(() => parseAmount("1.0000001", 6)).toThrow();
    expect(() => parseAmount("1e3", 6)).toThrow();
    expect(() => parseAmount("-1", 6)).toThrow();
    expect(() => formatAmount("1.2", 6)).toThrow();
  });

  it("requires a positive exact amount for a payment or quote", () => {
    expect(parsePositiveAmount("1.000001", 6)).toBe("1000001");
    expect(() => parsePositiveAmount("0.000000", 6)).toThrow("greater than zero");
    expect(() => parsePositiveAmount("0.0000001", 6)).toThrow("decimal places");
  });

  it("uses only a unique payment-capable settlement asset", () => {
    const usd = { legalInstrumentType: "settlement_token", capabilities: ["payment"], address: "0x1", decimals: 6 };
    const stock = { legalInstrumentType: "tokenized_stock", capabilities: ["buy", "sell"], address: "0x2", decimals: 18 };
    expect(settlementAsset([stock, usd])).toBe(usd);
    expect(settlementAsset([stock])).toBeUndefined();
    expect(settlementAsset([usd, usd])).toBeUndefined();
  });
});
