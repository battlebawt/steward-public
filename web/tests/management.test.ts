import { describe, expect, it } from "bun:test";
import { encodeManagementCall, verifyManagementCalldata, encodeContinuityCall, verifyContinuityCalldata } from "../src/lib/management";
import { verifyPreparedCall } from "../src/lib/preparedTx";

const account = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const preparedBase = { chainId: 31337, to: account, value: "0", manifestVersion: "steward-account-v1", simulation: { ok: true }, expiresAt: new Date(Date.now() + 60_000).toISOString() };

describe("reviewed management calls", () => {
  it("canonicalizes and verifies an exact policy-management request", () => {
    const request = { operation: "setDelegate", delegate: "0x2222222222222222222222222222222222222222", actionMask: "3", expiresAt: "2000000000", perActionLimit: "5" };
    const data = encodeManagementCall(request);
    expect(verifyManagementCalldata(request, data)).toEqual({ ok: true, operation: "setDelegate" });
    expect(verifyManagementCalldata({ ...request, perActionLimit: "6" }, data)).toMatchObject({ ok: false });
    expect(() => encodeManagementCall({ operation: "executeDelegateExpansion" })).toThrow("Unsupported management operation.");
    for (const operation of ["executeAdapterAdmission", "executeIncapacityModule", "deactivateIncapacity", "pauseDelegatedSpending", "unpauseDelegatedSpending"]) {
      const lifecycleData = encodeManagementCall({ operation });
      expect(verifyManagementCalldata({ operation }, lifecycleData)).toEqual({ ok: true, operation });
    }
  });

  it("rejects changed continuity calldata and untrusted transaction envelopes", () => {
    const request = { operation: "startRecovery", successor: "0x3333333333333333333333333333333333333333" };
    const data = encodeContinuityCall(request);
    expect(verifyContinuityCalldata(request, data)).toEqual({ ok: true, operation: "startRecovery" });
    expect(verifyContinuityCalldata({ ...request, successor: "0x4444444444444444444444444444444444444444" }, data)).toMatchObject({ ok: false });
    expect(verifyPreparedCall({ ...preparedBase, data }, { chainId: 31337, to: account, data })).toEqual({ ok: true });
    expect(verifyPreparedCall({ ...preparedBase, data, to: "0x5555555555555555555555555555555555555555" }, { chainId: 31337, to: account, data })).toMatchObject({ ok: false });
    expect(verifyPreparedCall({ ...preparedBase, data, value: "1" }, { chainId: 31337, to: account, data })).toMatchObject({ ok: false });
    const incapacity = { operation: "resolveIncapacity", id: "4", approved: true };
    const incapacityData = encodeContinuityCall(incapacity);
    expect(verifyContinuityCalldata(incapacity, incapacityData)).toEqual({ ok: true, operation: "resolve" });
    expect(verifyContinuityCalldata({ ...incapacity, approved: false }, incapacityData)).toMatchObject({ ok: false });
  });
});
