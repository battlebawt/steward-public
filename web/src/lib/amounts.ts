export class AmountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountInputError";
  }
}

/** Parse a decimal amount into an integer token amount without using floating point. */
export function parseAmount(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new AmountInputError("Invalid token decimals");
  }
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new AmountInputError("Enter a non-negative decimal amount");
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new AmountInputError(`Amount has more than ${decimals} decimal places`);
  }
  const raw = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return raw || "0";
}

/** A money-moving form must reject zero after exact decimal conversion. */
export function parsePositiveAmount(value: string, decimals: number): string {
  const raw = parseAmount(value, decimals);
  if (BigInt(raw) === 0n) throw new AmountInputError("Enter an amount greater than zero");
  return raw;
}

/** Use account asset metadata; never infer a settlement token's decimals or address. */
export function settlementAsset<T extends { legalInstrumentType: string; capabilities: readonly string[] }>(assets?: readonly T[]): T | undefined {
  const matches = assets?.filter((asset) => asset.legalInstrumentType === "settlement_token" && asset.capabilities.includes("payment")) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Format an integer token amount for display; this never converts through Number. */
export function formatAmount(raw: string, decimals: number, maxFraction = decimals): string {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0) {
    throw new AmountInputError("Invalid integer amount");
  }
  const padded = decimals === 0 ? raw : raw.padStart(decimals + 1, "0");
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  let fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
  if (maxFraction < fraction.length) fraction = fraction.slice(0, maxFraction);
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatFullAddress(address: string): string {
  return address;
}
