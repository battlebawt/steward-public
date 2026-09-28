import { describe, expect, it } from "bun:test";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, hexToBytes, keccak256, stringToHex, type Hex } from "viem";
import {
  base64urlToBytes,
  bytesToBase64url,
  encodePasskeySignature,
  encodePasskeyCall,
  extractPasskeyPublicKey,
  hashPasskeyCall,
  parseDerSignature,
  passkeyChallenge,
  passkeyMessageDigest,
  wrapErc1271Signature,
} from "../src/lib/passkeys";

const signer = "0x1111111111111111111111111111111111111111" as const;
const digest = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const der = (`0x30440220${"01".repeat(32)}0220${"02".repeat(32)}`) as Hex;
const passkeyCall = {
  signerAddress: signer,
  chainId: "31337",
  target: "0x2222222222222222222222222222222222222222" as const,
  value: "7",
  data: "0x123456" as Hex,
  nonce: "9",
  deadline: "1700000000",
};

function derInteger(value: string): string {
  let bytes = value.replace(/^0x/, "").replace(/^0+/, "") || "00";
  if (bytes.length % 2) bytes = `0${bytes}`;
  if (Number.parseInt(bytes.slice(0, 2), 16) >= 0x80) bytes = `00${bytes}`;
  return `02${(bytes.length / 2).toString(16).padStart(2, "0")}${bytes}`;
}

function derSignature(r: string, s: string): Hex {
  const body = `${derInteger(r)}${derInteger(s)}`;
  return (`0x30${(body.length / 2).toString(16).padStart(2, "0")}${body}`) as Hex;
}

describe("passkey wire helpers", () => {
  it("round-trips base64url without padding", () => {
    const source = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const encoded = bytesToBase64url(source);
    expect(encoded).not.toContain("=");
    expect(Array.from(base64urlToBytes(encoded))).toEqual(Array.from(source));
  });

  it("uses the exact digest as the WebAuthn challenge", () => {
    expect(passkeyChallenge(digest, signer)).toEqual(digest);
    expect(passkeyChallenge(digest, signer)).not.toEqual(passkeyChallenge("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", signer));
  });

  it("derives the passkey challenge digest from the server message", () => {
    expect(passkeyMessageDigest("Steward sign-in\nNonce: test")).toBe("0x7d81d9441aa3768ac8ffb235fdf0ceafe5afccad4e836aaa0c32655e8b2542eb");
  });

  it("converts WebAuthn DER ECDSA to fixed-width r and s", () => {
    expect(parseDerSignature(der)).toEqual({
      r: (`0x${"01".repeat(32)}`) as Hex,
      s: (`0x${"02".repeat(32)}`) as Hex,
    });
    expect(() => parseDerSignature("0x3000")).toThrow(/DER/);
    expect(() => parseDerSignature(`${der}00` as Hex)).toThrow(/trailing|length/);
  });

  it("accepts short positive scalars, rejects negative or non-minimal scalars, and normalizes high-s", () => {
    const short = parseDerSignature(derSignature(`0x${"11".repeat(31)}`, `0x${"22".repeat(31)}`));
    expect(short.r).toBe(`0x${"00" + "11".repeat(31)}`);
    expect(short.s).toBe(`0x${"00" + "22".repeat(31)}`);

    const highS = (`0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc63254f`);
    expect(parseDerSignature(derSignature("0x01", highS)).s).toBe(`0x${"00".repeat(31)}02`);
    expect(() => parseDerSignature(("0x3006020180020101" as Hex))).toThrow(/negative/);
    expect(() => parseDerSignature(("0x300702020001020101" as Hex))).toThrow(/non-minimal/);
  });

  it("hashes every sponsored passkey call field with the contract domain", () => {
    const version = keccak256(stringToHex("STEWARD_PASSKEY_CALL_V1"));
    const expected = keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }],
      [version, passkeyCall.signerAddress, 31337n, passkeyCall.target, 7n, keccak256(passkeyCall.data), 9n, 1700000000n],
    ));
    expect(hashPasskeyCall(passkeyCall)).toBe(expected);
    expect(() => hashPasskeyCall({ ...passkeyCall, nonce: "-1" })).toThrow(/nonce/);
    expect(() => hashPasskeyCall({ ...passkeyCall, deadline: "18446744073709551616" })).toThrow(/deadline/);
  });

  it("encodes the sponsored execute ABI with the bound call fields", () => {
    const encoded = encodePasskeyCall({ ...passkeyCall, signature: "0xdeadbeef" });
    const decoded = decodeFunctionData({
      abi: [{ type: "function", name: "execute", stateMutability: "payable", inputs: [
        { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "signature", type: "bytes" },
      ], outputs: [] }],
      data: encoded,
    });
    expect(decoded.functionName).toBe("execute");
    expect(decoded.args).toEqual([passkeyCall.target, 7n, passkeyCall.data, 9n, 1700000000n, "0xdeadbeef"]);
  });

  it("encodes the signer assertion and existing ERC-1271 envelope", () => {
    const inner = encodePasskeySignature({
      id: "credential",
      rawId: "credential",
      authenticatorData: (`0x${"11".repeat(37)}`) as Hex,
      clientDataJSON: '{"type":"webauthn.get"}',
      signature: der,
    });
    const [authenticatorData, clientDataJSON, r, s] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }],
      inner,
    );
    expect(authenticatorData).toEqual(`0x${"11".repeat(37)}`);
    expect(clientDataJSON).toBe('{"type":"webauthn.get"}');
    expect(r).toEqual(`0x${"01".repeat(32)}`);
    expect(s).toEqual(`0x${"02".repeat(32)}`);

    const outer = wrapErc1271Signature(signer, inner);
    const [outerSigner, outerPayload] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }], outer);
    expect(outerSigner).toBe(signer);
    expect(outerPayload).toBe(inner);
    expect(hexToBytes(outer).length).toBeGreaterThan(hexToBytes(inner).length);
  });

  it("extracts the rp hash and P-256 coordinates from attested COSE data", () => {
    const rp = new Uint8Array(32).fill(0x11); const x = new Uint8Array(32).fill(0x22); const y = new Uint8Array(32).fill(0x33);
    const auth = new Uint8Array([...rp, 0x41, 0, 0, 0, 1, ...new Uint8Array(16), 0, 3, 1, 2, 3,
      0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y]);
    const textKey = new TextEncoder().encode("authData"); const object = new Uint8Array([0xa1, 0x68, ...textKey, 0x58, auth.length, ...auth]);
    const result = extractPasskeyPublicKey({ rawId: bytesToBase64url(new Uint8Array([1, 2, 3])), attestationObject: bytesToBase64url(object) });
    expect(result.rpIdHash).toBe(`0x${"11".repeat(32)}`);
    expect(result.publicKeyX).toBe(`0x${"22".repeat(32)}`);
    expect(result.publicKeyY).toBe(`0x${"33".repeat(32)}`);
    expect(result.credentialId).toBe("AQID");
  });
});
