import { encodeFunctionData, hashMessage, verifyMessage, verifyTypedData } from 'viem'
import type { ActionIntent, PreparedTransaction, AssetDescriptor } from '@steward/shared'
import type {CowOrderInput} from '@steward/shared'
import { ACTION_TYPES, actionDomain, actionMessage, encodeActionForContract, hashActionIntent } from '@steward/shared'

export type ChainReceiptState = 'submitted' | 'included' | 'finalized' | 'reverted' | 'reorged' | 'unknown'
export type ChainReceipt = { hash: `0x${string}`; state: ChainReceiptState; chainId: number; sender?: `0x${string}`; blockNumber?: string; blockHash?: `0x${string}`; actionHash?: `0x${string}`; reason?: string; receipt?: unknown }
export type ChainQuote = { adapter: `0x${string}`; quoteId: string; chainId: number; assetIn: `0x${string}`; assetOut: `0x${string}`; amountInRaw: string; minAmountOutRaw: string; feeRaw: string; priceImpactBps: number; validUntil: string; routeHash: `0x${string}`; status: 'available' | 'unavailable'; reason?: string }
export type ChainSimulation = { ok: boolean; reason?: string; gasEstimate?: string }
export type ContinuityExecutionProof = { caseId: string; account: `0x${string}`; type: 'recovery' | 'incapacity' | 'succession'; chainCaseId: string; successor?: `0x${string}`; transactionHash: `0x${string}` }
export type ContinuityRequestProof = ContinuityExecutionProof & { planHash?: `0x${string}`; evidenceHash?: `0x${string}`; securityEpoch: string }
export type DeploymentReceiptProof = { transactionHash: `0x${string}`; parent: `0x${string}` }
export type VerifiedDeployment = { chainId: number; account: `0x${string}`; parent: `0x${string}`; implementation: `0x${string}`; accountVersion?: 'v1' | 'v2'; factory?: `0x${string}`; cowModule?: `0x${string}`; manifestVersion: string; deploymentBlock: string; deploymentBlockHash: `0x${string}`; policyVersion: string; securityEpoch: string; policy?: unknown }
export type V2OrderContext={chainId:number;account:`0x${string}`;parent:`0x${string}`;settlementToken:`0x${string}`;stockToken:`0x${string}`;cowSettlement:`0x${string}`;settlementSymbol:string;stockSymbol:string;settlementDecimals:number;stockDecimals:number;policyVersion:string;securityEpoch:string;periodEnd:string;maxFeeBps:string;exceptionSigners:readonly `0x${string}`[];exceptionQuorum:number;manifestVersion:string}
export type V2OrderStatus={digest:`0x${string}`;state:'unknown'|'pending'|'fill_observed'|'filled'|'cancelled'|'expired_unresolved';actor?:`0x${string}`;side?:'buy'|'sell';grossSellRaw?:string;validTo?:string;fillEvidenceRaw?:string;venue:'local_fixture_only';sellBudget?:{limitRaw:string;chargedRaw:string;pendingRaw:string;availableRaw:string;token:`0x${string}`}}
export type V2OrderResolution={outcome:'confirmed'|'reverted';status:V2OrderStatus}

export interface ChainGateway {
  readonly mode: 'demo' | 'live'
  getChainId(): Promise<number>
  verifyWalletSignature(input: { address: `0x${string}`; message: string; signature: `0x${string}` }): Promise<boolean>
  verifyActionSignature(input: { action: ActionIntent; signature: `0x${string}`; signer: `0x${string}` }): Promise<{ valid: boolean; signatureType: 'eoa' | 'erc1271' }>
  getAccountSnapshot(account: `0x${string}`): Promise<{ blockNumber: string; settlementBalanceRaw: string; totalValueRaw: string }>
  getPortfolioValuation?: (account: `0x${string}`) => Promise<import('./integrations/valuation').PortfolioValuation>
  getIndependentAccessKit?: (account: `0x${string}`) => Promise<import('./integrations/access-kit').AccessKit>
  getAccountHoldings?: (account: `0x${string}`, actor: `0x${string}`) => Promise<Array<AssetDescriptor & {balanceRaw:string;observedBlock:string;observedAt:string}>>
  getBudget?: (account: `0x${string}`) => Promise<{ limitRaw: string; spentRaw: string; remainingRaw: string; unit: string; period: 'daily' | 'weekly' | 'fixed'; resetAt: string; pendingRequests: number; buyBudget?: { limitRaw: string; chargedRaw: string; pendingRaw: string; availableRaw: string } }>
  quote(input: { account: `0x${string}`; actor: `0x${string}`; kind: 'BUY' | 'SELL'; asset: `0x${string}`; amountInRaw: string }): Promise<ChainQuote>
  simulateAction(action: ActionIntent, approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>): Promise<ChainSimulation>
  prepareAction(action: ActionIntent, approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>): Promise<PreparedTransaction>
  prepareCancellation(action: ActionIntent, requester: `0x${string}`, approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>): Promise<PreparedTransaction>
  /** Prepare a reviewed factory deployment without signing or broadcasting it. */
  prepareDeployment?: (parent: `0x${string}`, policy: unknown, accountVersion?: 'v1' | 'v2') => Promise<PreparedTransaction>
  getV2OrderContext?: (account:`0x${string}`)=>Promise<V2OrderContext|null>
  prepareV2Order?: (input:{account:`0x${string}`;actor:`0x${string}`;order:CowOrderInput;action:ActionIntent;approvals:Array<{signer:`0x${string}`;signature:`0x${string}`} >})=>Promise<PreparedTransaction>
  getV2OrderStatus?: (account:`0x${string}`,digest:`0x${string}`)=>Promise<V2OrderStatus>
  prepareV2Close?: (account:`0x${string}`,actor:`0x${string}`,digest:`0x${string}`,operation:'cancel'|'reconcile')=>Promise<PreparedTransaction>
  confirmV2OrderTransaction?: (account:`0x${string}`,digest:`0x${string}`,hash:`0x${string}`,operation:'open'|'cancel'|'reconcile',expectedData?:`0x${string}`)=>Promise<V2OrderResolution>
  /** Prepare a reviewed account management call without signing or broadcasting it. */
  preparePolicyChange?: (account: `0x${string}`, requester: `0x${string}`, input: unknown) => Promise<PreparedTransaction>
  /** Prepare a reviewed continuity call without signing, broadcasting, or changing local state. */
  prepareContinuity?: (account: `0x${string}`, requester: `0x${string}`, input: unknown) => Promise<PreparedTransaction>
  /** Read the verified on-chain parent, epoch, version, and policy configuration. */
  getAccountPolicy?: (account: `0x${string}`) => Promise<{ parent: `0x${string}`; securityEpoch: string; policyVersion: string; policy: unknown }>
  /** Verify a factory receipt and return only chain-derived account membership/provenance. */
  confirmDeployment?: (proof: DeploymentReceiptProof) => Promise<VerifiedDeployment>
  inspectTransaction(hash: `0x${string}`, action?: ActionIntent): Promise<ChainReceipt>
  confirmContinuityRequest?: (proof: ContinuityRequestProof) => Promise<boolean>
  confirmContinuityExecution?: (proof: ContinuityExecutionProof) => Promise<boolean>
  getDelegateAuthority?: (account:`0x${string}`,delegate:`0x${string}`)=>Promise<{active:boolean;actionMask:string;expiresAt:string;securityEpoch:string}>
  getAccountAuthority?: (account: `0x${string}`) => Promise<{ parent: `0x${string}`; securityEpoch: string; policyVersion: string }>
}

const ERC1271_ABI = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ name: 'magicValue', type: 'bytes4' }] }] as const
type LiveClient = { readContract?: (args: any) => Promise<any>; simulateContract?: (args: any) => Promise<any>; getTransactionReceipt?: (args: any) => Promise<any>; getBlockNumber?: () => Promise<bigint>; getBalance?: (args: any) => Promise<bigint> }

export class LiveChainGateway implements ChainGateway {
  readonly mode = 'live' as const
  constructor(private readonly options: { chainId: number; publicClient?: LiveClient; quote?: ChainGateway['quote']; snapshot?: ChainGateway['getAccountSnapshot'] }) {}
  async getChainId() { return this.options.chainId }
  async verifyWalletSignature(input: { address: `0x${string}`; message: string; signature: `0x${string}` }) {
    try { if (await verifyMessage({ address: input.address, message: input.message, signature: input.signature })) return true } catch { /* ERC-1271 wallets do not recover as EOAs */ }
    try { const magic = await this.options.publicClient?.readContract?.({ address: input.address, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hashMessage(input.message), input.signature] }); return String(magic).toLowerCase() === '0x1626ba7e' } catch { return false }
  }
  async verifyActionSignature(input: { action: ActionIntent; signature: `0x${string}`; signer: `0x${string}` }) {
    try {
      const valid = await verifyTypedData({ address: input.signer, domain: actionDomain(input.action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(input.action), signature: input.signature })
      if (!valid) return { valid: false, signatureType: 'eoa' as const }
      return { valid: true, signatureType: 'eoa' as const }
    } catch { try { const magic = await this.options.publicClient?.readContract?.({ address: input.signer, abi: ERC1271_ABI, functionName: 'isValidSignature', args: [hashActionIntent(input.action), input.signature] }); return { valid: String(magic).toLowerCase() === '0x1626ba7e', signatureType: 'erc1271' as const } } catch { return { valid: false, signatureType: 'erc1271' as const } } }
  }
  private unavailable(): never { throw new Error('LIVE_CHAIN_GATEWAY_NOT_CONFIGURED') }
  async getAccountSnapshot(account: `0x${string}`) { if (this.options.snapshot) return this.options.snapshot(account); const block = await this.options.publicClient?.getBlockNumber?.(); const balance = await this.options.publicClient?.getBalance?.({ address: account }); if (block !== undefined && balance !== undefined) return { blockNumber: block.toString(), settlementBalanceRaw: balance.toString(), totalValueRaw: balance.toString() }; return this.unavailable() }
  async quote(input: Parameters<ChainGateway['quote']>[0]) { if (this.options.quote) return this.options.quote(input); return this.unavailable() }
  async simulateAction(_action: ActionIntent, _approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>) { return this.unavailable() }
  async prepareAction(_action: ActionIntent, _approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>) { return this.unavailable() }
  async prepareCancellation(_action: ActionIntent, _requester: `0x${string}`, _approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>) { return this.unavailable() }
  async inspectTransaction(_hash: `0x${string}`, _action?: ActionIntent) { return this.unavailable() }
  async confirmContinuityExecution(_proof: ContinuityExecutionProof) { return this.unavailable() }
}

export class DemoChainGateway implements ChainGateway {
  readonly mode = 'demo' as const
  private receipts = new Map<string, ChainReceipt>()
  private balances = new Map<string, string>()
  constructor(readonly chainId = 31337, options?: { settlementBalanceRaw?: string }) {
    this.defaultSettlementBalance = options?.settlementBalanceRaw ?? '1000000000000'
  }
  private readonly defaultSettlementBalance: string
  async getChainId() { return this.chainId }
  async verifyWalletSignature(input: { address: `0x${string}`; message: string; signature: `0x${string}` }) {
    try { return await verifyMessage({ address: input.address, message: input.message, signature: input.signature }) } catch { return false }
  }
  async verifyActionSignature(input: { action: ActionIntent; signature: `0x${string}`; signer: `0x${string}` }) {
    try { return { valid: await verifyTypedData({ address: input.signer, domain: actionDomain(input.action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(input.action), signature: input.signature }), signatureType: 'eoa' as const } } catch { return { valid: false, signatureType: 'eoa' as const } }
  }
  async getAccountSnapshot(account: `0x${string}`) { return { blockNumber: '1', settlementBalanceRaw: this.balances.get(account) ?? this.defaultSettlementBalance, totalValueRaw: this.balances.get(account) ?? this.defaultSettlementBalance } }
  async quote(input: Parameters<ChainGateway['quote']>[0]): Promise<ChainQuote> {
    if (BigInt(input.amountInRaw) <= 0n) return { adapter: '0x0000000000000000000000000000000000000006' as `0x${string}`, quoteId: 'demo-unavailable', chainId: this.chainId, assetIn: input.asset, assetOut: input.asset, amountInRaw: input.amountInRaw, minAmountOutRaw: '0', feeRaw: '0', priceImpactBps: 0, validUntil: new Date().toISOString(), routeHash: `0x${'00'.repeat(32)}`, status: 'unavailable', reason: 'amount must be positive' }
    const output = (BigInt(input.amountInRaw) * 995n) / 1000n
    const quoteId = crypto.randomUUID(); const routeHash = `0x${quoteId.replaceAll('-', '').padEnd(64, '0').slice(0, 64)}` as `0x${string}`
    return { adapter: '0x0000000000000000000000000000000000000006' as `0x${string}`, quoteId, chainId: this.chainId, assetIn: input.kind === 'BUY' ? ('0x0000000000000000000000000000000000000001' as `0x${string}`) : input.asset, assetOut: input.kind === 'BUY' ? input.asset : ('0x0000000000000000000000000000000000000001' as `0x${string}`), amountInRaw: input.amountInRaw, minAmountOutRaw: output.toString(), feeRaw: (BigInt(input.amountInRaw) / 1000n).toString(), priceImpactBps: 50, validUntil: new Date(Date.now() + 60_000).toISOString(), routeHash, status: 'available' }
  }
  async simulateAction(action: ActionIntent, _approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>) { if (BigInt(action.deadline) * 1000n < BigInt(Date.now())) return { ok: false, reason: 'QUOTE_EXPIRED' }; return { ok: true, gasEstimate: '180000' } }
  async prepareAction(action: ActionIntent, approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>): Promise<PreparedTransaction> {
    const simulation = await this.simulateAction(action, approvals); if (!simulation.ok) throw new Error(simulation.reason ?? 'SIMULATION_FAILED')
    return { chainId: this.chainId, to: action.account, value: '0', data: encodeActionForContract(action, approvals?.map((a) => a.signature) ?? []), actionHash: hashActionIntent(action), manifestVersion: 'demo-1', simulation, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  }
  async prepareCancellation(action: ActionIntent, _requester: `0x${string}`, _approvals?: Array<{ signer: `0x${string}`; signature: `0x${string}`; signatureType?: 'eoa' | 'erc1271' | 'passkey' }>): Promise<PreparedTransaction> {
    const data = encodeFunctionData({ abi: [{ type: 'function', name: 'cancelAction', stateMutability: 'nonpayable', inputs: [{ name: 'actionId', type: 'bytes32' }] }], functionName: 'cancelAction', args: [action.actionId] })
    return { chainId: this.chainId, to: action.account, value: '0', data, actionHash: hashActionIntent(action), manifestVersion: 'demo-1', simulation: { ok: true }, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  }
  async inspectTransaction(hash: `0x${string}`, action?: ActionIntent): Promise<ChainReceipt> {
    return this.receipts.get(hash) ?? { hash, state: 'unknown', chainId: this.chainId, actionHash: action ? hashActionIntent(action) : undefined }
  }
  recordReceipt(receipt: ChainReceipt) { this.receipts.set(receipt.hash, receipt) }
  async confirmContinuityExecution(_proof: ContinuityExecutionProof) { return false }
}
