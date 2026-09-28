import { describe, expect, it } from "bun:test";
import { hashActionIntent } from "@steward/shared";
import type { ActionIntent, PreparedTransaction } from "@steward/shared";
import { encodeSupportedAction, verifyPreparedTransaction } from "../src/lib/preparedTx";

const intent: ActionIntent = {
  actionId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  kind: "PAYMENT",
  account: "0x1111111111111111111111111111111111111111",
  actor: "0x2222222222222222222222222222222222222222",
  chainId: 31337,
  securityEpoch: "2",
  policyVersion: "7",
  nonce: "3",
  tokenIn: "0x3333333333333333333333333333333333333333",
  tokenOut: "0x0000000000000000000000000000000000000000",
  recipient: "0x4444444444444444444444444444444444444444",
  amountInRaw: "125000000",
  minAmountOutRaw: "0",
  adapter: "0x0000000000000000000000000000000000000000",
  routeHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  validAfter: "0",
  deadline: "4102444800",
  exceptionMask: "0",
};

function prepared(overrides: Partial<PreparedTransaction> = {}): PreparedTransaction {
  return {
    chainId: intent.chainId,
    to: intent.account,
    value: "0",
    data: encodeSupportedAction(intent),
    actionHash: hashActionIntent(intent),
    manifestVersion: "demo-1",
    simulation: { ok: true },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("prepared transaction verification", () => {
  it("accepts the exact shared action payload", () => expect(verifyPreparedTransaction(intent, prepared())).toEqual({ ok: true }));
  it("rejects an expired preparation", () => expect(verifyPreparedTransaction(intent, prepared({ expiresAt: new Date(Date.now() - 1_000).toISOString() }))).toMatchObject({ ok: false, reason: "Prepared transaction has expired." }));
  it.each([
    ["recipient", { data: encodeSupportedAction({ ...intent, recipient: "0x5555555555555555555555555555555555555555" }) }],
    ["amount", { data: encodeSupportedAction({ ...intent, amountInRaw: "125000001" }) }],
    ["calldata", { data: "0x1234" }],
    ["destination", { to: "0x9999999999999999999999999999999999999999" }],
    ["chain", { chainId: 1 }],
    ["action hash", { actionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }],
  ])("rejects altered %s", (_, override) => expect(verifyPreparedTransaction(intent, prepared(override as Partial<PreparedTransaction>))).toMatchObject({ ok: false }));
});
