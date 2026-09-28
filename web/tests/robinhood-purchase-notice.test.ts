import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssetDescriptor } from "@steward/shared";
import { isRobinhoodStockPurchase, locationAnswerDoesNotBlockQuote, RobinhoodPurchaseNotice } from "../src/components/RobinhoodPurchaseNotice";

const stock: AssetDescriptor = {
  id: "stock", provider: "robinhood", chainId: 4663,
  address: "0x0000000000000000000000000000000000000001", symbol: "STOCK", name: "Stock Token", decimals: 18,
  legalInstrumentType: "tokenized_stock", sourceTermsVersion: "review-required", capabilities: ["buy", "sell"], admission: "review_required",
};

describe("Robinhood purchase notice", () => {
  test("covers a named provider and an unclassified mainnet holding, but not demo, settlement, or a sale", () => {
    expect(isRobinhoodStockPurchase(stock, "BUY")).toBe(true);
    expect(isRobinhoodStockPurchase({ ...stock, provider: "unclassified" }, "BUY")).toBe(true);
    expect(isRobinhoodStockPurchase({ ...stock, provider: "demo", chainId: 31337 }, "BUY")).toBe(false);
    expect(isRobinhoodStockPurchase({ ...stock, provider: "settlement", legalInstrumentType: "settlement_token" }, "BUY")).toBe(false);
    expect(isRobinhoodStockPurchase(stock, "SELL")).toBe(false);
  });

  test("a restricted, unanswered, or uncertain self-report stops a quote", () => {
    expect(locationAnswerDoesNotBlockQuote("")).toBe(false);
    expect(locationAnswerDoesNotBlockQuote("restricted")).toBe(false);
    expect(locationAnswerDoesNotBlockQuote("unsure")).toBe(false);
    expect(locationAnswerDoesNotBlockQuote("not-listed")).toBe(true);
  });

  test("the purchase step names the restrictions and explains a blocked answer", () => {
    const html = renderToStaticMarkup(createElement(RobinhoodPurchaseNotice, { answer: "restricted", onAnswer: () => {} }));
    expect(html).toContain("Canada, the U.K. and Switzerland");
    expect(html).toContain("restricted-jurisdictions/");
    expect(html).toContain("Purchase unavailable.");
    expect(html).toContain("Steward will not request a quote");
  });
});
