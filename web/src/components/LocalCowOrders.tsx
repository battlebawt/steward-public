import { useEffect, useRef, useState } from 'react'
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type EIP1193Provider, type Hex } from 'viem'
import { COW_BALANCE_ERC20, COW_KIND_SELL, V2_COW_ORDER_ABI, contractCowOrder, cowOrderDigest, hashActionIntent, randomBytes32, type AccountSnapshot, type ActionIntent, type CowOrderInput } from '@steward/shared'
import type { PreparedTransaction } from '../domain'
import { createApiClient } from '../lib/api'
import { parseAmount, parsePositiveAmount } from '../lib/amounts'
import { userFacingError } from '../lib/errors'
import { connectWallet, sendPreparedCall, signAction } from '../lib/wallet'
import { assertLocalV2Signer, validateLocalV2Order, type LocalV2Context, type LocalV2Order, verifyLocalV2Close, verifyLocalV2Open } from '../lib/v2OrderReview'
import { BetaRiskLine, MoneyAmount, TransactionReview } from './Primitives'

const api = createApiClient()
type Operation = 'open' | 'cancel' | 'reconcile'
type Pending = { digest: Hex; operation: Operation; hash: Hex | null; unknown: boolean }
const storageKey = (account: AccountSnapshot, digest: Hex) => `steward.local-v2-order.${account.chainId}.${account.address.toLowerCase()}.${digest}`
const authorityAbi = parseAbi(['function parent() view returns (address)', 'function policyAddresses(uint8) view returns (address[])'])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
function provider(): EIP1193Provider { const value = (window as Window & { ethereum?: EIP1193Provider }).ethereum; if (!value) throw Error('Connect a local fixture wallet.'); return value }
function stored(account: AccountSnapshot, digest: Hex): Pending | null { try { const raw = localStorage.getItem(storageKey(account, digest)); const parsed = raw ? JSON.parse(raw) as Pending : null; return parsed?.digest === digest && ['open', 'cancel', 'reconcile'].includes(parsed.operation) ? parsed : null } catch { return null } }

export function LocalCowOrders({ account }: { account: AccountSnapshot }) {
  return <LocalCowOrdersForAccount key={`${account.id}:${account.chainId}:${account.address.toLowerCase()}:${account.securityEpoch}:${account.policyVersion}`} account={account} />
}

function LocalCowOrdersForAccount({ account }: { account: AccountSnapshot }) {
  const [context, setContext] = useState<LocalV2Context | null>()
  const [orders, setOrders] = useState<LocalV2Order[]>([])
  const [selected, setSelected] = useState<LocalV2Order>()
  const [kind, setKind] = useState<'BUY' | 'SELL'>('BUY')
  const [sellAmount, setSellAmount] = useState('')
  const [buyMinimum, setBuyMinimum] = useState('')
  const [fee, setFee] = useState('0')
  const [minutes, setMinutes] = useState('15')
  const [exceptionMode, setExceptionMode] = useState<'within' | 'parent' | 'cosigners'>('within')
  const [chosenSigners, setChosenSigners] = useState<string[]>([])
  const [prepared, setPrepared] = useState<{ call: PreparedTransaction; operation: Operation; data: Hex }>()
  const [pending, setPending] = useState<Pending | null>(null)
  const [recoveryHash, setRecoveryHash] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const mounted = useRef(true)
  const selectedRef = useRef<string | undefined>(undefined)
  const refreshSeq = useRef(0)
  const path = `/accounts/${account.id}/v2/orders`
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; refreshSeq.current++ } }, [])
  const activeOrder = (digest: string) => mounted.current && selectedRef.current === digest
  function chooseOrder(order: LocalV2Order) { if (lock.current) return; selectedRef.current = order.digest; setSelected(order); setPrepared(undefined); setPending(stored(account, order.digest)); setRecoveryHash('') }
  function displayed(order: LocalV2Order, fresh: LocalV2Context = ctx, allowStaleClose = false) {
    if (!same(account.address, fresh.account) || account.chainId !== fresh.chainId || account.securityEpoch !== fresh.securityEpoch || account.policyVersion !== fresh.policyVersion || !same(account.parent, fresh.parent)) throw Error('Account authority changed; refresh before signing.')
    return validateLocalV2Order(fresh, order.order, order.action, order.digest, order.actionHash, allowStaleClose)
  }
  async function currentContext(order: LocalV2Order, allowStaleClose = false) {
    const fresh = (await api.get<LocalV2Context | null>(`${path}/context`)).data
    if (!fresh) throw Error('Guarded order account is unavailable.')
    displayed(order, fresh, allowStaleClose)
    return fresh
  }
  async function onchainApprovers(p: EIP1193Provider, fresh: LocalV2Context): Promise<{ parent: Address; signers: readonly Address[] }> {
    const call = async (functionName: 'parent' | 'policyAddresses', args?: [number]) => {
      const data = encodeFunctionData({ abi: authorityAbi, functionName, args: args as never })
      return p.request({ method: 'eth_call', params: [{ to: fresh.account, data }, 'latest'] }) as Promise<Hex>
    }
    const [parentRaw, signerRaw] = await Promise.all([call('parent'), call('policyAddresses', [2])])
    return { parent: decodeFunctionResult({ abi: authorityAbi, functionName: 'parent', data: parentRaw }), signers: decodeFunctionResult({ abi: authorityAbi, functionName: 'policyAddresses', data: signerRaw }) }
  }
  useEffect(() => { let active = true; void api.get<LocalV2Context | null>(`${path}/context`).then(({ data }) => { if (active) setContext(data) }).catch(e => { if (active) setError(userFacingError(e)) }); return () => { active = false } }, [path])
  useEffect(() => { if (!context) return; let active = true; void api.get<LocalV2Order[]>(path).then(({ data }) => { if (active) setOrders(data) }).catch(e => { if (active) setError(userFacingError(e)) }); return () => { active = false } }, [context, path])
  useEffect(() => { if (!selected) setPending(null) }, [selected])
  if (context === null || context === undefined) return null
  const ctx = context

  async function refresh(digest?: Hex) {
    const sequence = ++refreshSeq.current, target = digest ?? selectedRef.current
    const list = (await api.get<LocalV2Order[]>(path)).data
    if (!mounted.current || sequence !== refreshSeq.current) return
    setOrders(list)
    if (target && selectedRef.current === target) setSelected(list.find(v => v.digest === target))
  }
  function savePending(digest: Hex, next: Pending | null) {
    try { if (next) localStorage.setItem(storageKey(account, digest), JSON.stringify(next)); else localStorage.removeItem(storageKey(account, digest)) }
    catch { if (activeOrder(digest)) setError('Local recovery storage is unavailable. Save the original hash shown below.') }
    if (activeOrder(digest)) setPending(next)
  }
  async function create(e: React.FormEvent) {
    e.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('')
    try {
      const p = provider(), wallet = await connectWallet(p)
      if (wallet.chainId !== ctx.chainId || account.chainId !== ctx.chainId) throw Error('Wallet network changed.')
      const buy = kind === 'BUY', sellToken = buy ? ctx.settlementToken : ctx.stockToken, buyToken = buy ? ctx.stockToken : ctx.settlementToken
      const sellDecimals = buy ? ctx.settlementDecimals : ctx.stockDecimals, buyDecimals = buy ? ctx.stockDecimals : ctx.settlementDecimals
      const sellRaw = parsePositiveAmount(sellAmount, sellDecimals), buyRaw = parsePositiveAmount(buyMinimum, buyDecimals), feeRaw = parseAmount(fee, sellDecimals)
      if (BigInt(feeRaw) * 10000n > BigInt(sellRaw) * BigInt(ctx.maxFeeBps)) throw Error('Fee exceeds the pinned local fixture limit.')
      const now = Math.floor(Date.now() / 1000), duration = Number(minutes)
      if (!Number.isInteger(duration) || duration < 1 || duration > 60) throw Error('Choose an expiry from 1 to 60 minutes.')
      const validTo = String(now + duration * 60)
      if (BigInt(validTo) >= BigInt(ctx.periodEnd)) throw Error('Order must expire before this budget period ends.')
      const order: CowOrderInput = { sellToken, buyToken, receiver: ctx.account, sellAmount: sellRaw, buyAmount: buyRaw, validTo, appData: randomBytes32(), feeAmount: feeRaw, kind: COW_KIND_SELL, partiallyFillable: false, sellTokenBalance: COW_BALANCE_ERC20, buyTokenBalance: COW_BALANCE_ERC20 }
      const digest = cowOrderDigest(order, ctx.chainId, ctx.cowSettlement)
      const onchainData = encodeFunctionData({ abi: V2_COW_ORDER_ABI, functionName: 'orderDigest', args: [contractCowOrder(order)] })
      const onchainRaw = await p.request({ method: 'eth_call', params: [{ to: ctx.account, data: onchainData }, 'latest'] }) as Hex
      const onchainDigest = decodeFunctionResult({ abi: V2_COW_ORDER_ABI, functionName: 'orderDigest', data: onchainRaw })
      if (String(onchainDigest).toLowerCase() !== digest) throw Error('The account returned a different order digest.')
      const selectedSigners = ctx.exceptionSigners.filter(signer => chosenSigners.includes(signer.toLowerCase()))
      if (exceptionMode === 'cosigners' && (selectedSigners.length === 0 || selectedSigners.length < ctx.exceptionQuorum || selectedSigners.some(signer => same(signer, wallet.account)))) throw Error('Choose the required independent co-signers before saving this exception order.')
      const exceptionMask = exceptionMode === 'within' ? '0' : exceptionMode === 'parent' ? '1' : ctx.exceptionSigners.reduce((mask, signer, i) => chosenSigners.includes(signer.toLowerCase()) ? mask | (1n << BigInt(i + 1)) : mask, 0n).toString()
      const action: ActionIntent = { actionId: digest, kind, account: ctx.account, actor: wallet.account.toLowerCase() as `0x${string}`, chainId: ctx.chainId, securityEpoch: ctx.securityEpoch, policyVersion: ctx.policyVersion, nonce: BigInt(randomBytes32()).toString(), tokenIn: sellToken, tokenOut: buyToken, recipient: ctx.account, amountInRaw: (BigInt(sellRaw) + BigInt(feeRaw)).toString(), minAmountOutRaw: buyRaw, adapter: ctx.cowSettlement, routeHash: digest, validAfter: String(now - 5), deadline: validTo, exceptionMask }
      validateLocalV2Order(ctx, order, action, digest, hashActionIntent(action))
      if (!mounted.current) return
      const saved = (await api.post<LocalV2Order>(path, { order, action })).data
      if (saved.digest !== digest || saved.actionHash !== hashActionIntent(action)) throw Error('Saved order identity changed.')
      if (mounted.current) { selectedRef.current = digest; setSelected(saved) }
      await refresh(digest)
    } catch (e) { setError(userFacingError(e)) }
    finally { lock.current = false; setBusy(false) }
  }
  async function sign() {
    if (!selected || lock.current) return; lock.current = true; setBusy(true); setError('')
    const order = selected
    try {
      const p = provider(), wallet = await connectWallet(p)
      const fresh = await currentContext(order)
      if (wallet.chainId !== fresh.chainId || !activeOrder(order.digest)) throw Error('Wallet, account or selected order changed.')
      const authority = await onchainApprovers(p, fresh)
      assertLocalV2Signer(fresh, order.action, wallet.account, authority.parent, authority.signers)
      if (!activeOrder(order.digest)) throw Error('Selected account or order changed.')
      const signature = await signAction(p, order.action, undefined, wallet)
      if (!activeOrder(order.digest)) return
      await api.post(`${path}/${order.digest}/approvals`, { signer: wallet.account, signature })
      await refresh(order.digest)
    } catch (e) { if (activeOrder(order.digest)) setError(userFacingError(e)) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  async function prepare(operation: Operation) {
    if (!selected || lock.current || pending) return; lock.current = true; setBusy(true); setError('')
    const order = selected
    try {
      const fresh = await currentContext(order, operation !== 'open')
      if (!activeOrder(order.digest)) return
      const call = operation === 'open' ? (await api.post<PreparedTransaction>(`${path}/${order.digest}/prepare`, {})).data : (await api.post<PreparedTransaction>(`${path}/${order.digest}/prepare-close`, { operation })).data
      const data = operation === 'open' ? (await verifyLocalV2Open(call, fresh, order.order, order.action, order.approvals.map(v => v.signer))).data : verifyLocalV2Close(call, fresh, order.digest, operation)
      if (!activeOrder(order.digest)) return
      setPrepared({ call, operation, data })
    } catch (e) { if (activeOrder(order.digest)) { setError(userFacingError(e)); setPrepared(undefined) } }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  async function submit() {
    if (!selected || !prepared || pending || lock.current) return; lock.current = true; setBusy(true); setError('')
    const order = selected, exact = prepared
    const attempt: Pending = { digest: order.digest, operation: exact.operation, hash: null, unknown: true }
    let walletPrompted = false
    try {
      const p = provider(), wallet = await connectWallet(p)
      const fresh = await currentContext(order, exact.operation !== 'open')
      if (wallet.chainId !== fresh.chainId || !activeOrder(order.digest)) throw Error('Wallet, account or selected order changed.')
      if (exact.operation === 'open') await verifyLocalV2Open(exact.call, fresh, order.order, order.action, order.approvals.map(v => v.signer))
      else verifyLocalV2Close(exact.call, fresh, order.digest, exact.operation)
      if (!activeOrder(order.digest)) throw Error('Selected account or order changed.')
      savePending(order.digest, attempt)
      walletPrompted = true
      const hash = await sendPreparedCall(p, { ...exact.call, data: exact.call.data as Hex }, { chainId: fresh.chainId, to: fresh.account, data: exact.data, manifestVersions: new Set([fresh.manifestVersion]) }, wallet)
      savePending(order.digest, { ...attempt, hash, unknown: false })
      if (activeOrder(order.digest)) setRecoveryHash(hash)
      await reconcileFor(order, hash, exact.operation)
    } catch (e) { if (!walletPrompted) savePending(order.digest, null); if (activeOrder(order.digest)) setError(`${userFacingError(e)} ${walletPrompted ? 'Check the original wallet transaction before trying again.' : ''}`) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  async function reconcileFor(order: LocalV2Order, hash: string, operation: Operation) {
    try {
      const result = await api.post<{ outcome: 'confirmed' | 'reverted' }>(`${path}/${order.digest}/confirm`, { hash, operation })
      if (!result.data) throw Error('Transaction confirmation was empty.')
      savePending(order.digest, null)
      if (activeOrder(order.digest)) { setPrepared(undefined); await refresh(order.digest); setError(result.data.outcome === 'reverted' ? 'The original transaction finalized as reverted. Prepare a new transaction after checking current limits and authority.' : '') }
    } catch (e) { if (activeOrder(order.digest)) setError(`${userFacingError(e)} Keep this original hash and check again after finality.`) }
  }
  async function reconcile(hashInput?: string, operationInput?: Operation) {
    if (!selected || lock.current) return
    const order = selected, operation = operationInput ?? pending?.operation ?? order.closeOperation ?? 'open'
    const hash = hashInput ?? pending?.hash ?? recoveryHash
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { setError('Enter the original transaction hash.'); return }
    lock.current = true; setBusy(true)
    try { await reconcileFor(order, hash, operation) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const side = selected ? selected.action.kind : kind
  const sellDecimals = side === 'BUY' ? ctx.settlementDecimals : ctx.stockDecimals
  const buyDecimals = side === 'BUY' ? ctx.stockDecimals : ctx.settlementDecimals
  const sellSymbol = side === 'BUY' ? ctx.settlementSymbol : ctx.stockSymbol
  const buySymbol = side === 'BUY' ? ctx.stockSymbol : ctx.settlementSymbol
  return <section className="card"><h2>Local guarded order fixture</h2><p className="muted">Mock/fork funds only. Opening an order reserves the parent's budget inside the account; it does not submit an order to a public CoW venue or prove a fill.</p>
    <form onSubmit={create}><label>Side<select value={kind} onChange={e => setKind(e.target.value as 'BUY' | 'SELL')}><option value="BUY">Buy {ctx.stockSymbol}</option><option value="SELL">Sell {ctx.stockSymbol}</option></select></label>
      <label>Amount to sell ({kind === 'BUY' ? ctx.settlementSymbol : ctx.stockSymbol})<input required inputMode="decimal" value={sellAmount} onChange={e => setSellAmount(e.target.value)} /></label>
      <label>Minimum to receive ({kind === 'BUY' ? ctx.stockSymbol : ctx.settlementSymbol})<input required inputMode="decimal" value={buyMinimum} onChange={e => setBuyMinimum(e.target.value)} /></label>
      <label>Maximum fee in sell token<input required inputMode="decimal" value={fee} onChange={e => setFee(e.target.value)} /></label>
      <label>Expiry in minutes<input required inputMode="numeric" value={minutes} onChange={e => setMinutes(e.target.value)} /></label>
      <label>Exception approval<select value={exceptionMode} onChange={e => setExceptionMode(e.target.value as 'within' | 'parent' | 'cosigners')}><option value="within">Within parent-set limits</option><option value="parent">Parent approves exception</option><option value="cosigners">Independent co-signers approve exception</option></select></label>
      {exceptionMode === 'cosigners' ? <fieldset><legend>Required co-signers ({ctx.exceptionQuorum} minimum)</legend>{ctx.exceptionSigners.map((signer, i) => <label key={signer}><input type="checkbox" checked={chosenSigners.includes(signer.toLowerCase())} onChange={e => setChosenSigners(e.target.checked ? [...chosenSigners, signer.toLowerCase()] : chosenSigners.filter(v => v !== signer.toLowerCase()))} />Co-signer {i + 1}: {signer}</label>)}</fieldset> : null}
      <button type="submit" disabled={busy}>Save exact local order</button>
    </form>
    {orders.length ? <><h3>Saved orders</h3><ul>{orders.map(order => <li key={order.digest}><button type="button" onClick={() => chooseOrder(order)} disabled={busy}>{order.action.kind} · {order.digest.slice(0, 12)}… · {order.status.state}</button></li>)}</ul></> : null}
    {selected ? <div className="card"><h3>Review {selected.action.kind} order</h3><p>Sell <MoneyAmount raw={selected.order.sellAmount} decimals={sellDecimals} symbol={sellSymbol} /> plus fee <MoneyAmount raw={selected.order.feeAmount} decimals={sellDecimals} symbol={sellSymbol} />. Minimum received <MoneyAmount raw={selected.order.buyAmount} decimals={buyDecimals} symbol={buySymbol} />.</p><p>Account {ctx.account}; chain {ctx.chainId}; expires {new Date(Number(selected.order.validTo) * 1000).toLocaleString()}.</p><p className="address">Exact order digest: {selected.digest}</p><p>State: {selected.status.state}. {selected.status.state === 'pending' ? 'Funds are reserved; no fill is proven.' : selected.status.state === 'fill_observed' ? 'Local settlement reports a fill; reconcile the account.' : selected.status.state === 'expired_unresolved' ? 'Expiry is unresolved. A charged budget is not proof of a fill.' : null}</p>{selected.status.sellBudget ? <p>Sell limit: <MoneyAmount raw={selected.status.sellBudget.limitRaw} decimals={ctx.stockDecimals} symbol={ctx.stockSymbol} />; charged <MoneyAmount raw={selected.status.sellBudget.chargedRaw} decimals={ctx.stockDecimals} symbol={ctx.stockSymbol} />; pending <MoneyAmount raw={selected.status.sellBudget.pendingRaw} decimals={ctx.stockDecimals} symbol={ctx.stockSymbol} />; available <MoneyAmount raw={selected.status.sellBudget.availableRaw} decimals={ctx.stockDecimals} symbol={ctx.stockSymbol} />.</p> : null}<p>Approvals: {selected.approvals.map(v => v.signer.slice(0, 12)).join(', ') || 'none'}</p>{selected.attempts?.length ? <p>Transaction attempts: {selected.attempts.map(v => `${v.operation} ${v.hash.slice(0, 12)}… ${v.outcome}`).join('; ')}</p> : null}<BetaRiskLine chainId={ctx.chainId} /><div className="actions"><button type="button" onClick={sign} disabled={busy || selected.status.state !== 'unknown'}>Sign exact action</button><button type="button" onClick={() => void prepare('open')} disabled={busy || !!pending || selected.status.state !== 'unknown'}>Prepare opening</button><button type="button" onClick={() => void prepare('cancel')} disabled={busy || !!pending || !['pending', 'fill_observed', 'expired_unresolved'].includes(selected.status.state)}>Prepare cancel</button><button type="button" onClick={() => void prepare('reconcile')} disabled={busy || !!pending || !['fill_observed', 'expired_unresolved'].includes(selected.status.state)}>Prepare reconcile</button></div>
      {prepared ? <><TransactionReview intentSummary={`${prepared.operation} local fixture order ${selected.digest}`} prepared={prepared.call} /><button type="button" onClick={submit} disabled={busy || !!pending}>Send exact local transaction</button></> : null}
      {pending ? <p role="status">Original {pending.operation} transaction: {pending.hash ?? 'wallet response unknown'}. Check this transaction before another send.</p> : null}
      {pending?.unknown && !pending.hash ? <button type="button" onClick={() => savePending(selected.digest, null)}>I checked the wallet: no transaction was sent</button> : null}
      <label>Original transaction hash<input value={recoveryHash} onChange={e => setRecoveryHash(e.target.value)} placeholder="0x…" /></label><button type="button" onClick={() => void reconcile()} disabled={busy || (!pending && !recoveryHash)}>Check original transaction</button><button type="button" onClick={() => void refresh(selected.digest)} disabled={busy}>Refresh order status</button>
    </div> : null}{error ? <p className="error" role="alert">{error}</p> : null}</section>
}
