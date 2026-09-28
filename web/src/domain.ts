import type { ActionIntent as SharedActionIntent, PreparedTransaction as SharedPreparedTransaction, AccountSnapshot as SharedAccountSnapshotSchema, AssetDescriptor as SharedAssetDescriptorSchema } from "@steward/shared";

export type AppMode = "demo" | "live";
export type Role = "parent" | "caregiver" | "cosigner" | "viewer";
export type ActionKind = "PAYMENT" | "BUY" | "SELL";

export interface Capability {
  action: string;
  allowed: boolean;
  reason?: string;
}

export interface AccountContext {
  accountId: string;
  address: `0x${string}`;
  chainId: number;
  role: Role;
  capabilities: Capability[];
  policyVersion: string;
  securityEpoch: string;
  snapshotBlock?: string;
}

// Financial payloads use the shared runtime-validated schemas. The UI-only display
// types below intentionally add presentation fields instead of changing those payloads.
export type SharedAccountSnapshot = SharedAccountSnapshotSchema;
export type SharedAssetDescriptor = SharedAssetDescriptorSchema;

export interface AssetDescriptor {
  assetId: string;
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  provider: string;
  availability: "available" | "paused" | "review" | "unknown";
  reason?: string;
}

export interface BudgetView {
  limitRaw: string;
  spentRaw: string;
  remainingRaw: string;
  unit: string;
  decimals: number;
  resetAtUtc: string;
  pendingRequests: number;
  buyBudget?: { limitRaw: string; chargedRaw: string; pendingRaw: string; availableRaw: string };
}

export type ActionIntent = SharedActionIntent;
export type PreparedTransaction = SharedPreparedTransaction;

export type TransactionState =
  | "draft"
  | "prepared"
  | "awaiting_approvals"
  | "ready"
  | "submitted"
  | "checking_status"
  | "included"
  | "finalized"
  | "blocked"
  | "expired"
  | "cancelled"
  | "superseded"
  | "reverted"
  | "reorged";

export interface ActivityItem {
  id: string;
  kind: ActionKind | "POLICY" | "ACCESS";
  state: TransactionState;
  description: string;
  createdAt: string;
  transactionHash?: `0x${string}`;
}

export interface StructuredApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
  nextAction?: string;
  requestId?: string;
}

export interface ApiEnvelope<T> {
  data: T;
  requestId: string;
  observedAt: string;
  snapshotBlock?: string;
  policyVersion?: string;
  warnings?: string[];
}
