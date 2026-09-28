import { describe, expect, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { ACTION_TYPES, COW_BALANCE_ERC20, COW_KIND_SELL, actionDomain, actionMessage, cowOrderDigest, hashActionIntent } from '@steward/shared'
import type { ActionIntent, CowOrderInput } from '@steward/shared'
import { createApp } from '../src/app'
import { LiveChainGateway } from '../src/chain'
import type { V2OrderStatus } from '../src/chain'
import { createDatabase } from '../src/db'

const parent = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const caregiver = privateKeyToAccount('0x0323456789012345678901234567890123456789012345678901234567890123')
const cosigner = privateKeyToAccount('0x0423456789012345678901234567890123456789012345678901234567890123')
const viewer = privateKeyToAccount('0x0523456789012345678901234567890123456789012345678901234567890123')
const accountAddress = '0x00000000000000000000000000000000000000aa' as const
const settlement = '0x0000000000000000000000000000000000000001' as const
const stock = '0x0000000000000000000000000000000000000002' as const
const cow = '0x0000000000000000000000000000000000000003' as const
const openHash = `0x${'11'.repeat(32)}` as const
const otherHash = `0x${'22'.repeat(32)}` as const
const closeHash = `0x${'33'.repeat(32)}` as const
const revertedHash = `0x${'44'.repeat(32)}` as const

class V2FixtureChain extends LiveChainGateway {
  active = true
  state: V2OrderStatus['state'] = 'unknown'
  now = Math.floor(Date.now() / 1000)
  constructor() { super({ chainId: 31337 }) }
  async getAccountAuthority() { return { parent: parent.address.toLowerCase() as `0x${string}`, securityEpoch: '1', policyVersion: '1' } }
  async getAccountPolicy() { return { parent: parent.address.toLowerCase() as `0x${string}`, securityEpoch: '1', policyVersion: '1', policy: { version: '1', allowedActions: ['PAYMENT', 'BUY', 'SELL'], allowedRecipients: [], allowedAssets: [stock], paymentMaxRaw: '1000', buyMaxRaw: '1000', sellMaxRaw: '1000', settlementReserveRaw: '0', requiredApprovals: 0, exceptionApprovers: [cosigner.address.toLowerCase()], exceptionQuorum: 1 } } }
  async getDelegateAuthority() { return { active: this.active, actionMask: '6', expiresAt: String(this.now + 3600), securityEpoch: '1' } }
  async getV2OrderContext() { return { chainId: 31337, account: accountAddress, parent: parent.address.toLowerCase() as `0x${string}`, settlementToken: settlement, stockToken: stock, cowSettlement: cow, settlementSymbol: 'USDC', stockSymbol: 'STOCK', settlementDecimals: 6, stockDecimals: 18, policyVersion: '1', securityEpoch: '1', periodEnd: String(this.now + 3600), maxFeeBps: '100', exceptionSigners: [cosigner.address.toLowerCase() as `0x${string}`], exceptionQuorum: 1, manifestVersion: 'local-fixture' } }
  async getV2OrderStatus(_account: `0x${string}`, digest: `0x${string}`): Promise<V2OrderStatus> { return { digest, state: this.state, venue: 'local_fixture_only', fillEvidenceRaw: '0', sellBudget: { limitRaw: '1000', chargedRaw: this.state === 'expired_unresolved' ? '101' : '0', pendingRaw: this.state === 'pending' ? '101' : '0', availableRaw: this.state === 'expired_unresolved' || this.state === 'pending' ? '899' : '1000', token: stock } } }
  async prepareV2Order(input: { account: `0x${string}`; actor: `0x${string}`; order: CowOrderInput; action: ActionIntent; approvals: Array<{ signer: `0x${string}`; signature: `0x${string}` }> }) {
    if (!this.active || !input.approvals.some(v => v.signer.toLowerCase() === input.actor.toLowerCase())) throw Error('UNAUTHORIZED')
    if (BigInt(input.action.exceptionMask) > 1n && !input.approvals.some(v => v.signer.toLowerCase() === cosigner.address.toLowerCase())) throw Error('COSIGNER_REQUIRED')
    return { chainId: 31337, to: accountAddress, value: '0', data: '0x1234' as const, actionHash: hashActionIntent(input.action), manifestVersion: 'local-fixture', simulation: { ok: true }, expiresAt: new Date(Date.now() + 30_000).toISOString() }
  }
  async prepareV2Close(_account: `0x${string}`, _actor: `0x${string}`, digest: `0x${string}`, operation: 'cancel' | 'reconcile') { return { chainId: 31337, to: accountAddress, value: '0', data: operation === 'cancel' ? '0x5678' as const : '0x9abc' as const, actionHash: digest, manifestVersion: 'local-fixture', simulation: { ok: true }, expiresAt: new Date(Date.now() + 30_000).toISOString() } }
  async confirmV2OrderTransaction(_account: `0x${string}`, digest: `0x${string}`, hash: `0x${string}`, operation: 'open' | 'cancel' | 'reconcile', expectedData?: `0x${string}`) {
    if (![operation === 'open' ? openHash : closeHash, revertedHash].includes(hash) || expectedData !== (operation === 'open' ? '0x1234' : '0x5678')) throw Error('MISMATCH')
    if (hash === revertedHash) return { outcome: 'reverted' as const, status: await this.getV2OrderStatus(accountAddress, digest) }
    this.state = operation === 'open' ? 'pending' : 'cancelled'
    return { outcome: 'confirmed' as const, status: await this.getV2OrderStatus(accountAddress, digest) }
  }
}

function setup() {
  const db = createDatabase(':memory:'), chain = new V2FixtureChain(), now = new Date().toISOString()
  for (const [id, wallet] of [['parent', parent], ['caregiver', caregiver], ['cosigner', cosigner], ['viewer', viewer]] as const)
    db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run(id, wallet.address.toLowerCase(), now)
  db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('family', 31337, accountAddress, 'parent', now)
  for (const [id, role, scopes] of [['caregiver', 'caregiver', ['portfolio.view', 'trade.propose']], ['cosigner', 'cosigner', ['portfolio.view']], ['viewer', 'viewer', ['portfolio.view']]] as const)
    db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run(id, 'family', id, role, JSON.stringify(scopes), now)
  return { db, chain, app: createApp({ db, chain, config: { serviceKey: new Uint8Array(32) } }) }
}
async function session(app: ReturnType<typeof createApp>, wallet: typeof parent) {
  const challenge = await app.request('http://localhost/api/v1/auth/challenges', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet.address, chainId: 31337 }) })
  const data = (await challenge.json()).data
  const signature = await wallet.signMessage({ message: data.message })
  const response = await app.request('http://localhost/api/v1/auth/sessions', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: data.challengeId, address: wallet.address, signature }) })
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';')[0]
}
function request(app: ReturnType<typeof createApp>, cookie: string, path: string, body?: unknown) {
  const payload = body && typeof body === 'object' && 'digest' in body ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'digest')) : body
  return app.request(`http://localhost/api/v1/accounts/family/v2/orders${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin: 'http://localhost:5173', cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(payload) }) })
}
function proposal(chain: V2FixtureChain, nonce = '1', side: 'BUY' | 'SELL' = 'BUY') {
  const buy = side === 'BUY', validTo = String(chain.now + 300)
  const order = { sellToken: buy ? settlement : stock, buyToken: buy ? stock : settlement, receiver: accountAddress, sellAmount: '100', buyAmount: '50', validTo, appData: `0x${'44'.repeat(32)}`, feeAmount: '1', kind: COW_KIND_SELL, partiallyFillable: false as const, sellTokenBalance: COW_BALANCE_ERC20, buyTokenBalance: COW_BALANCE_ERC20 }
  const digest = cowOrderDigest(order, 31337, cow)
  const action = { actionId: digest, kind: side, account: accountAddress, actor: caregiver.address.toLowerCase(), chainId: 31337, securityEpoch: '1', policyVersion: '1', nonce, tokenIn: order.sellToken, tokenOut: order.buyToken, recipient: accountAddress, amountInRaw: '101', minAmountOutRaw: '50', adapter: cow, routeHash: digest, validAfter: String(chain.now - 10), deadline: validTo, exceptionMask: '0' } as ActionIntent
  return { order, action, digest }
}

describe('local V2 guarded order API', () => {
  test('saves exact buy and sell orders once, rejects substitution and unauthorized users', async () => {
    const { db, chain, app } = setup(), care = await session(app, caregiver), view = await session(app, viewer)
    const buy = proposal(chain), sell = proposal(chain, '2', 'SELL')
    expect((await request(app, view, '', buy)).status).toBe(403)
    expect((await request(app, care, '', { ...buy, action: { ...buy.action, amountInRaw: '102' } })).status).toBe(409)
    const duplicateCreates = await Promise.all([request(app, care, '', buy), request(app, care, '', buy)])
    expect(duplicateCreates.map(response => response.status)).toEqual([200, 200])
    expect((await request(app, care, '', { ...buy, action: { ...buy.action, nonce: '99' } })).status).toBe(409)
    expect((await request(app, care, '', proposal(chain, '1', 'SELL'))).status).toBe(409)
    expect((await request(app, care, '', sell)).status).toBe(200)
    expect((db.query('SELECT COUNT(*) count FROM v2_orders').get() as any).count).toBe(2)
    const listed = await request(app, view, '')
    expect((await listed.json()).data).toHaveLength(2)
    db.close()
  })

  test('requires exact signer approvals and active authority, then binds one confirmed hash', async () => {
    const { db, chain, app } = setup(), care = await session(app, caregiver), co = await session(app, cosigner), buy = proposal(chain)
    expect((await request(app, care, '', buy)).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(409)
    const signature = await caregiver.signTypedData({ domain: actionDomain(buy.action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(buy.action) })
    expect((await request(app, co, `/${buy.digest}/approvals`, { signer: caregiver.address, signature })).status).toBe(403)
    const duplicateApprovals = await Promise.all([request(app, care, `/${buy.digest}/approvals`, { signer: caregiver.address, signature }), request(app, care, `/${buy.digest}/approvals`, { signer: caregiver.address, signature })])
    expect(duplicateApprovals.map(response => response.status)).toEqual([200, 200])
    chain.active = false
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(403)
    chain.active = true
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: otherHash })).status).toBe(409)
    const duplicateConfirms = await Promise.all([request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: openHash }), request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: openHash })])
    expect(duplicateConfirms.map(response => response.status)).toEqual([200, 200])
    expect((db.query('SELECT open_tx_hash FROM v2_orders WHERE digest=?').get(buy.digest) as any).open_tx_hash).toBe(openHash)
    expect((db.query("SELECT COUNT(*) count FROM audit_events WHERE event_type='v2_order.open_confirmed'").get() as any).count).toBe(1)
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: otherHash })).status).toBe(409)
    expect((await request(app, co, `/${buy.digest}/prepare-close`, { operation: 'cancel' })).status).toBe(403)
    expect((await request(app, care, `/${buy.digest}/prepare-close`, { operation: 'cancel' })).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'reconcile', hash: closeHash })).status).toBe(409)
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'cancel', hash: closeHash })).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'cancel', hash: closeHash })).status).toBe(200)
    db.close()
  })

  test('exposes expired unresolved order and charged sell budget without claiming a fill', async () => {
    const { db, chain, app } = setup(), care = await session(app, caregiver), sell = proposal(chain, '3', 'SELL')
    expect((await request(app, care, '', sell)).status).toBe(200)
    chain.state = 'expired_unresolved'
    const detail = await request(app, care, `/${sell.digest}`)
    expect((await detail.json()).data.status).toMatchObject({ state: 'expired_unresolved', fillEvidenceRaw: '0', sellBudget: { chargedRaw: '101', pendingRaw: '0' } })
    db.close()
  })

  test('records finalized reverted attempts and permits a freshly prepared retry; uncertain hashes remain unrecorded', async () => {
    const { db, chain, app } = setup(), care = await session(app, caregiver), buy = proposal(chain, '7')
    expect((await request(app, care, '', buy)).status).toBe(200)
    const signature = await caregiver.signTypedData({ domain: actionDomain(buy.action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(buy.action) })
    expect((await request(app, care, `/${buy.digest}/approvals`, { signer: caregiver.address, signature })).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: otherHash })).status).toBe(409)
    expect((db.query('SELECT COUNT(*) count FROM v2_order_attempts').get() as any).count).toBe(0)
    const reverted = await request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: revertedHash })
    expect(reverted.status).toBe(200)
    expect((await reverted.json()).data).toMatchObject({ outcome: 'reverted', status: { state: 'unknown' } })
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: revertedHash })).status).toBe(200)
    expect((db.query('SELECT open_tx_hash FROM v2_orders WHERE digest=?').get(buy.digest) as any).open_tx_hash).toBeNull()
    expect((db.query('SELECT COUNT(*) count FROM v2_order_attempts').get() as any).count).toBe(1)
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/confirm`, { operation: 'open', hash: openHash })).status).toBe(200)
    expect((db.query('SELECT outcome FROM v2_order_attempts WHERE tx_hash=?').get(revertedHash) as any).outcome).toBe('reverted')
    db.close()
  })

  test('co-signer exception requires an independent exact signature and active caregiver authority', async () => {
    const { db, chain, app } = setup(), care = await session(app, caregiver), co = await session(app, cosigner)
    const base = proposal(chain, '8'), action = { ...base.action, exceptionMask: '2' }, buy = { ...base, action }
    expect((await request(app, care, '', buy)).status).toBe(200)
    const actorSignature = await caregiver.signTypedData({ domain: actionDomain(action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(action) })
    expect((await request(app, care, `/${buy.digest}/approvals`, { signer: caregiver.address, signature: actorSignature })).status).toBe(200)
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(409)
    const coSignature = await cosigner.signTypedData({ domain: actionDomain(action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(action) })
    expect((await request(app, co, `/${buy.digest}/approvals`, { signer: cosigner.address, signature: coSignature })).status).toBe(200)
    chain.active = false
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(403)
    chain.active = true
    expect((await request(app, care, `/${buy.digest}/prepare`, {})).status).toBe(200)
    db.close()
  })
})
