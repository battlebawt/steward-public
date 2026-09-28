import { describe, expect, it } from "bun:test";
import { assertWalletUnchanged, unknownSubmission } from "../src/lib/wallet";

describe("wallet safety boundaries", () => {
  it("invalidates a pending signature when account or chain changes", () => {
    const expected = { account: "0x1111111111111111111111111111111111111111" as const, chainId: 31337 };
    expect(() => assertWalletUnchanged(expected, { account: expected.account, chainId: 1 })).toThrow(/changed/);
    expect(() => assertWalletUnchanged(expected, { account: "0x2222222222222222222222222222222222222222", chainId: 31337 })).toThrow(/changed/);
  });

  it("tracks unknown submission without resending", () => {
    expect(unknownSubmission("intent-1", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({
      intentId: "intent-1",
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      state: "checking_status",
      message: expect.stringContaining("will not resend"),
    });
  });
});
