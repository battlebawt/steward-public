import type { Role } from "../domain";
import { createApiClient, type ApiClient } from "./api";

export interface RuntimeAccount { id: string; address: `0x${string}`; chainId: number; role: Role; policyVersion: string; securityEpoch: string; }

export async function startDemoSession(client: ApiClient = createApiClient()) {
  return client.post<{ mode: "demo"; chainId: number; account: RuntimeAccount }>("/auth/demo", { chainId: 31337 });
}

export async function loadRuntimeAccount(client: ApiClient = createApiClient()): Promise<RuntimeAccount | undefined> {
  const response = await client.get<RuntimeAccount[]>("/accounts");
  return response.data[0];
}
