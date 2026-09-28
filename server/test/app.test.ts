import { describe, expect, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { hashMessage, verifyMessage } from 'viem'
import { createApp } from '../src/app'
import { DemoChainGateway, LiveChainGateway } from '../src/chain'
import { createDatabase } from '../src/db'
import { RpcUnavailable } from '../src/integrations/rpc'
import { ACTION_TYPES, actionDomain, actionMessage } from '@steward/shared'

const parent = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const other = privateKeyToAccount('0x0223456789012345678901234567890123456789012345678901234567890123')
const caregiver = privateKeyToAccount('0x0323456789012345678901234567890123456789012345678901234567890123')
const cosigner = privateKeyToAccount('0x0423456789012345678901234567890123456789012345678901234567890123')
const accountAddress = '0x00000000000000000000000000000000000000aa'
const otherAccountAddress = '0x00000000000000000000000000000000000000bb'
const zero = '0x0000000000000000000000000000000000000000'
const routeHash = `0x${'00'.repeat(32)}`
const passkeySigner = '0x00000000000000000000000000000000000000f1' as `0x${string}`
const passkeyVerifier = privateKeyToAccount('0x0523456789012345678901234567890123456789012345678901234567890123')

let passkeyContractCall: any
class PasskeyFixtureGateway extends LiveChainGateway {
  constructor() { super({ chainId: 31337, publicClient: { readContract: async (args: any) => { passkeyContractCall = args; return '0x1626ba7e' } } as any }) }
}

class DeploymentFixtureGateway extends LiveChainGateway {
  constructor() { super({ chainId: 31337 }) }
  override async verifyWalletSignature(input: { address: `0x${string}`; message: string; signature: `0x${string}` }) { return verifyMessage({ address: parent.address, message: input.message, signature: input.signature }) }
  async confirmDeployment() { return { chainId: 31337, account: accountAddress as `0x${string}`, parent: parent.address, implementation: '0x00000000000000000000000000000000000000f2' as `0x${string}`, manifestVersion: 'fixture-1', deploymentBlock: '12', deploymentBlockHash: `0x${'44'.repeat(32)}` as `0x${string}`, policyVersion: '1', securityEpoch: '1', policy: { allowedActions: ['PAYMENT'], allowedRecipients: [], allowedAssets: [], paymentMaxRaw: '1000', buyMaxRaw: '0', sellMaxRaw: '0', settlementReserveRaw: '0', requiredApprovals: 0, exceptionApprovers: [] } }
  }
}
class MissingPolicyDeploymentGateway extends DeploymentFixtureGateway {
  override async confirmDeployment(): Promise<any> { const verified = await super.confirmDeployment(); const { policy: _policy, ...withoutPolicy } = verified; return withoutPolicy }
}
class ChangedPolicyDeploymentGateway extends DeploymentFixtureGateway {
  currentPolicyVersion = '1'
  override async confirmDeployment() { return { ...await super.confirmDeployment(), policyVersion: this.currentPolicyVersion } }
}
class WrappedRpcFixtureGateway extends DeploymentFixtureGateway {
  async getAccountAuthority() { return { parent: parent.address.toLowerCase() as `0x${string}`, securityEpoch: '1', policyVersion: '1' } }
  async getIndependentAccessKit(): Promise<any> { throw new Error('private provider detail', { cause: new RpcUnavailable('RPC_UNAVAILABLE') }) }
}

let continuityPreparedInput: unknown
let continuityPreparedAccount: string | undefined
let continuityPreparedRequester: string | undefined
class ContinuityFixtureGateway extends LiveChainGateway {
  constructor() { super({ chainId: 31337 }) }
  async prepareContinuity(account: `0x${string}`, requester: `0x${string}`, input: unknown) {
    continuityPreparedAccount = account; continuityPreparedRequester = requester; continuityPreparedInput = input
    return { chainId: 31337, to: account, value: '0', data: '0x1234', actionHash: `0x${'aa'.repeat(32)}` as `0x${string}`, manifestVersion: 'fixture-1', simulation: { ok: true }, expiresAt: '2099-01-01T00:00:00.000Z' }
  }
}

class LivePolicyFixtureGateway extends LiveChainGateway {
  currentParent = parent.address.toLowerCase() as `0x${string}`
  constructor() { super({ chainId: 31337 }) }
  async getAccountAuthority() { return {parent:this.currentParent,securityEpoch:'3',policyVersion:'2'} }
  async getAccountPolicy() { return { parent: this.currentParent, securityEpoch: '3', policyVersion: '2', policy: { version: '2', allowedActions: ['PAYMENT'], allowedRecipients: [other.address.toLowerCase()], allowedAssets: [], paymentMaxRaw: '77', buyMaxRaw: '0', sellMaxRaw: '0', settlementReserveRaw: '5', requiredApprovals: 1, exceptionApprovers: [cosigner.address.toLowerCase()] } } }
}

function fixture() {
  const db = createDatabase(':memory:'); const chain = new DemoChainGateway(); const now = new Date().toISOString()
  db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('parent', parent.address.toLowerCase(), now)
  db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('other', other.address.toLowerCase(), now)
  db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('caregiver', caregiver.address.toLowerCase(), now)
  db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('cosigner', cosigner.address.toLowerCase(), now)
  db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('family-a', 31337, accountAddress, 'parent', now)
  db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('family-b', 31337, otherAccountAddress, 'other', now)
  const policy = JSON.stringify({ allowedActions: ['PAYMENT', 'BUY', 'SELL'], allowedRecipients: [], paymentMaxRaw: '1000000000', buyMaxRaw: '1000000000', sellMaxRaw: '1000000000', settlementReserveRaw: '0', requiredApprovals: 0, exceptionApprovers: [] })
  for (const id of ['family-a', 'family-b']) db.query('INSERT INTO policy_snapshots(id,account_id,version,policy_json,effective_at,created_at) VALUES(?,?,?,?,?,?)').run(`policy-${id}`, id, '1', policy, now, now)
  return { db, chain, app: createApp({ db, chain, config: { demoMode: true, serviceKey: new Uint8Array(32) } }) }
}

async function signedSession(app: ReturnType<typeof createApp>, account = parent) {
  let response = await app.request('http://localhost/api/v1/auth/challenges', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ address: account.address, chainId: 31337 }) })
  const challenge = (await response.json()).data
  const signature = await account.signMessage({ message: challenge.message })
  response = await app.request('http://localhost/api/v1/auth/sessions', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, address: account.address, signature }) })
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], challenge, signature }
}

function intentBody() { const now = Math.floor(Date.now() / 1000); return { kind: 'PAYMENT', chainId: 31337, securityEpoch: '1', policyVersion: '1', nonce: '1', tokenIn: '0x0000000000000000000000000000000000000001', tokenOut: zero, recipient: '0x00000000000000000000000000000000000000cc', amountInRaw: '100', minAmountOutRaw: '0', adapter: zero, routeHash, validAfter: String(now - 10), deadline: String(now + 300), exceptionMask: '0' } }

describe('Steward API', () => {
  test('binds quotes to the authenticated actor as well as the parent account', async () => {
    const { app, chain, db } = fixture();
    const originalQuote = chain.quote.bind(chain);
    let received: Parameters<typeof chain.quote>[0] | undefined;
    chain.quote = async (input) => { received = input; return originalQuote(input) };
    const session = await signedSession(app);
    const response = await app.request('http://localhost/api/v1/accounts/family-a/quotes', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', cookie: session.cookie }, body: JSON.stringify({ kind: 'BUY', asset: '0x0000000000000000000000000000000000000005', amountInRaw: '1250000' }) });
    expect(response.status).toBe(200);
    expect(received?.account.toLowerCase()).toBe(accountAddress);
    expect(received?.actor.toLowerCase()).toBe(parent.address.toLowerCase());
    db.close();
  });

  test('passes the authenticated viewer to live holdings admission', async () => {
    const { db } = fixture();
    class HoldingsFixtureGateway extends DeploymentFixtureGateway {
      actor?: `0x${string}`;
      async getAccountHoldings(_account: `0x${string}`, actor: `0x${string}`) { this.actor = actor; return [] }
    }
    const chain = new HoldingsFixtureGateway();
    const app = createApp({ db, chain, config: { demoMode: false, serviceKey: new Uint8Array(32) } });
    const session = await signedSession(app);
    const response = await app.request('http://localhost/api/v1/accounts/family-a/assets', { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    expect(chain.actor?.toLowerCase()).toBe(parent.address.toLowerCase());
    db.close();
  });

  test('a portfolio viewer sees holdings without trade proposal controls', async () => {
    const { app, db } = fixture(); const now = new Date().toISOString();
    db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('view-grant','family-a','cosigner','viewer','["portfolio.view"]',now);
    const token='0x0000000000000000000000000000000000000005';
    db.query('INSERT INTO assets(id,provider,chain_id,address,symbol,name,decimals,legal_instrument_type,source_terms_version,capabilities_json,admission) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('stock','fixture',31337,token,'STOCK','Fixture stock',8,'tokenized_stock','fixture','["buy","sell"]','allowed');
    db.query('INSERT INTO holdings_snapshots(id,account_id,asset_id,balance_raw,observed_block,observed_at) VALUES(?,?,?,?,?,?)').run('holding','family-a','stock','100000000','1',now);
    const session=await signedSession(app,cosigner);
    const response=await app.request('http://localhost/api/v1/accounts/family-a/assets',{headers:{cookie:session.cookie}});
    expect(response.status).toBe(200);
    const assets=(await response.json()).data;
    expect(assets[0]).toMatchObject({balanceRaw:'100000000',capabilities:[],admission:'review_required'});
    db.close();
  });

  test('rejects forged, replayed, expired and mismatched-domain challenges', async () => {
    const { app, db } = fixture(); const first = await app.request('http://localhost/api/v1/auth/challenges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: parent.address, chainId: 31337, domain: 'https://evil.example' }) }); expect(first.status).toBe(403)
    const session = await signedSession(app); const challengeResponse = await app.request('http://localhost/api/v1/auth/challenges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: parent.address, chainId: 31337 }) }); const forgedChallenge = (await challengeResponse.json()).data; const forged = await app.request('http://localhost/api/v1/auth/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: forgedChallenge.challengeId, address: parent.address, signature: await other.signMessage({ message: forgedChallenge.message }) }) }); expect(forged.status).toBe(403)
    const replay = await app.request('http://localhost/api/v1/auth/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: session.challenge.challengeId, address: parent.address, signature: session.signature }) }); expect(replay.status).toBe(409)
    const concurrentResponse = await app.request('http://localhost/api/v1/auth/challenges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: parent.address, chainId: 31337 }) }); const concurrentChallenge = (await concurrentResponse.json()).data; const concurrentSig = await parent.signMessage({ message: concurrentChallenge.message }); const concurrent = await Promise.all([0, 1].map(() => app.request('http://localhost/api/v1/auth/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: concurrentChallenge.challengeId, address: parent.address, signature: concurrentSig }) }))); expect(concurrent.filter((r) => r.status === 200)).toHaveLength(1); expect(concurrent.filter((r) => r.status === 409)).toHaveLength(1)
    const expiredResponse = await app.request('http://localhost/api/v1/auth/challenges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: parent.address, chainId: 31337 }) }); const expiredChallenge = (await expiredResponse.json()).data; db.query('UPDATE auth_nonces SET expires_at=? WHERE id=?').run(new Date(0).toISOString(), expiredChallenge.challengeId); expect((await app.request('http://localhost/api/v1/auth/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: expiredChallenge.challengeId, address: parent.address, signature: session.signature }) })).status).toBe(401)
    expect((await app.request('http://localhost/api/v1/auth/sessions/current', { headers: { cookie: session.cookie } })).status).toBe(200); expect((await app.request('http://localhost/api/v1/auth/sessions/current', { method: 'DELETE', headers: { cookie: session.cookie } })).status).toBe(200); expect((await app.request('http://localhost/api/v1/auth/sessions/current', { headers: { cookie: session.cookie } })).status).toBe(401)
  })

  test('passkey signer login delegates exact challenge digest to wallet verification and consumes once', async () => {
    const db = createDatabase(':memory:'); const chain = new PasskeyFixtureGateway(); const app = createApp({ db, chain, config: { demoMode: false, serviceKey: new Uint8Array(32) } })
    const challengeResponse = await app.request('http://localhost/api/v1/auth/webauthn/challenges', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ address: passkeySigner, chainId: 31337 }) }); expect(challengeResponse.status).toBe(200)
    const challenge = (await challengeResponse.json()).data; expect(challenge.challengeDigest).toBe(hashMessage(challenge.message))
    const signature = await passkeyVerifier.signMessage({ message: { raw: challenge.challengeDigest } })
    const sessionResponse = await app.request('http://localhost/api/v1/auth/webauthn/sessions', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, address: passkeySigner, signature }) }); expect(sessionResponse.status).toBe(200); expect(sessionResponse.headers.get('set-cookie')).toContain('steward_session='); expect(passkeyContractCall.address).toBe(passkeySigner); expect(passkeyContractCall.args[0]).toBe(challenge.challengeDigest); expect(passkeyContractCall.args[1]).toBe(signature)
    const replay = await app.request('http://localhost/api/v1/auth/webauthn/sessions', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, address: passkeySigner, signature }) }); expect(replay.status).toBe(409)
  })

  test('live deployment registration accepts only gateway verified factory provenance', async () => {
    const db = createDatabase(':memory:'); const chain = new DeploymentFixtureGateway(); const app = createApp({ db, chain, config: { origin: 'http://localhost:5173', serviceKey: new Uint8Array(32) } }); const session = await signedSession(app)
    const response = await app.request('http://localhost/api/v1/accounts/register-deployment', { method: 'POST', headers: { origin: 'http://localhost:5173', cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ transactionHash: `0x${'55'.repeat(32)}` }) }); expect(response.status).toBe(200); const result = (await response.json()).data; expect(result.provenance).toBe('verified_factory_receipt'); const row = db.query('SELECT address,parent_user_id FROM accounts WHERE id=?').get(result.accountId) as any; expect(row.address).toBe(accountAddress); expect(row.parent_user_id).toBe((db.query('SELECT id FROM users WHERE lower(wallet_address)=?').get(parent.address.toLowerCase()) as any).id)
  })

  test('V2 receipt registration records fixed module identity and rejects a mismatched retry', async () => {
    const db=createDatabase(':memory:');const chain=new DeploymentFixtureGateway();
    const original=chain.confirmDeployment.bind(chain),factory='0x00000000000000000000000000000000000000f3' as const,cowModule='0x00000000000000000000000000000000000000f4' as const;
    let returnedModule:string|undefined=cowModule;
    (chain as any).confirmDeployment=async()=>({...await original(),accountVersion:'v2',factory,cowModule:returnedModule});
    const app=createApp({db,chain,config:{origin:'http://localhost:5173',serviceKey:new Uint8Array(32)}}),session=await signedSession(app);
    const register=()=>app.request('http://localhost/api/v1/accounts/register-deployment',{method:'POST',headers:{origin:'http://localhost:5173',cookie:session.cookie,'content-type':'application/json'},body:JSON.stringify({transactionHash:`0x${'55'.repeat(32)}`})});
    const first=await register();expect(first.status).toBe(200);const data=(await first.json()).data;
    expect(data.accountVersion).toBe('v2');
    expect(db.query('SELECT account_version,factory_address,cow_module FROM account_versions WHERE account_id=?').get(data.accountId)).toMatchObject({account_version:'v2',factory_address:factory,cow_module:cowModule});
    expect((await (await register()).json()).data.registered).toBe(false);
    returnedModule=undefined;
    const missing=await register();expect(missing.status).toBe(409);expect((await missing.json()).error.code).toBe('DEPLOYMENT_COMPONENT_MISMATCH');
    returnedModule=cowModule;
    db.query('UPDATE account_versions SET cow_module=? WHERE account_id=?').run(zero,data.accountId);
    const mismatch=await register();expect(mismatch.status).toBe(409);expect((await mismatch.json()).error.code).toBe('ACCOUNT_VERSION_MISMATCH');
    db.close();
  })

  test('existing registration remains idempotent after a policy change, while first registration stays closed', async () => {
    const db = createDatabase(':memory:'); const chain = new ChangedPolicyDeploymentGateway(); const app = createApp({ db, chain, config: { origin: 'http://localhost:5173', serviceKey: new Uint8Array(32) } }); const session = await signedSession(app)
    const register = () => app.request('http://localhost/api/v1/accounts/register-deployment', { method: 'POST', headers: { origin: 'http://localhost:5173', cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ transactionHash: `0x${'55'.repeat(32)}` }) })
    chain.currentPolicyVersion = '2'
    const before = await register(); expect(before.status).toBe(409); expect((await before.json()).error.code).toBe('DEPLOYMENT_POLICY_CHANGED'); expect((db.query('SELECT COUNT(*) count FROM accounts').get() as any).count).toBe(0)
    chain.currentPolicyVersion = '1'
    const created = await register(); expect(created.status).toBe(200); const createdData = (await created.json()).data; expect(createdData.registered).toBe(true)
    chain.currentPolicyVersion = '2'
    const repeated = await register(); expect(repeated.status).toBe(200); expect((await repeated.json()).data).toMatchObject({ registered: false, accountId: createdData.accountId, address: accountAddress })
    expect((db.query('SELECT COUNT(*) count FROM accounts').get() as any).count).toBe(1)
    db.close()
  })

  test('wrapped RPC outages fail closed as retryable dependency errors without leaking provider details', async () => {
    const { db } = fixture(); const chain = new WrappedRpcFixtureGateway(); const app = createApp({ db, chain, config: { serviceKey: new Uint8Array(32) } }); const session = await signedSession(app)
    const response = await app.request('http://localhost/api/v1/accounts/family-a/access-kit', { headers: { cookie: session.cookie } })
    expect(response.status).toBe(503)
    const body = await response.json(); expect(body.error).toMatchObject({ code: 'RPC_UNAVAILABLE', retryable: true, nextAction: 'RETRY' }); expect(JSON.stringify(body)).not.toContain('private provider detail')
  })

  test('staging allowlists reject outside wallets, old sessions, and unreviewed accounts', async () => {
    const db = createDatabase(':memory:'); const chain = new DeploymentFixtureGateway();
    const config = { origin: 'http://localhost:5173', serviceKey: new Uint8Array(32), stagingAllowedWallets: [parent.address], stagingAllowedAccounts: [otherAccountAddress] };
    const app = createApp({ db, chain, config });
    const outside = await app.request('http://localhost/api/v1/auth/challenges', { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json' }, body: JSON.stringify({ address: other.address, chainId: 31337 }) });
    expect(outside.status).toBe(403); expect((await outside.json()).error.code).toBe('STAGING_ACCESS_DENIED');
    const session = await signedSession(app);
    const rejected = await app.request('http://localhost/api/v1/accounts/register-deployment', { method: 'POST', headers: { origin: config.origin, cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ transactionHash: `0x${'55'.repeat(32)}` }) });
    expect(rejected.status).toBe(403); expect((await rejected.json()).error.code).toBe('STAGING_ACCOUNT_NOT_REVIEWED');
    expect((db.query('SELECT COUNT(*) count FROM accounts').get() as any).count).toBe(0);
    const narrowed = createApp({ db, chain, config: { ...config, stagingAllowedWallets: [other.address] } });
    const oldSession = await narrowed.request('http://localhost/api/v1/auth/sessions/current', { headers: { cookie: session.cookie } });
    expect(oldSession.status).toBe(403); expect((await oldSession.json()).error.code).toBe('STAGING_ACCESS_DENIED');
  })

  test('live deployment registration rejects a verified receipt without a verified policy', async () => {
    const db = createDatabase(':memory:'); const chain = new MissingPolicyDeploymentGateway(); const app = createApp({ db, chain, config: { origin: 'http://localhost:5173', serviceKey: new Uint8Array(32) } }); const session = await signedSession(app)
    const response = await app.request('http://localhost/api/v1/accounts/register-deployment', { method: 'POST', headers: { origin: 'http://localhost:5173', cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ transactionHash: `0x${'55'.repeat(32)}` }) }); expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('DEPLOYMENT_POLICY_UNAVAILABLE'); expect((db.query('SELECT COUNT(*) count FROM accounts').get() as any).count).toBe(0)
  })

  test('continuity preparation requires authorization and forwards a live transaction without local mutation', async () => {
    const db = createDatabase(':memory:'); const chain = new ContinuityFixtureGateway(); const now = new Date().toISOString()
    db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('parent', parent.address.toLowerCase(), now)
    db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('caregiver', caregiver.address.toLowerCase(), now)
    db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('family-a', 31337, accountAddress, 'parent', now)
    db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('caregiver-grant', 'family-a', 'caregiver', 'caregiver', JSON.stringify(['continuity.view']), now)
    const app = createApp({ db, chain, config: { origin: 'http://localhost:5173', serviceKey: new Uint8Array(32) } })
    const unauthenticated = await app.request('http://localhost/api/v1/accounts/family-a/continuity/prepare', { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'recovery' }) }); expect(unauthenticated.status).toBe(401)
    const caregiverSession = await signedSession(app, caregiver); const unauthorized = await app.request('http://localhost/api/v1/accounts/family-a/continuity/prepare', { method: 'POST', headers: { origin: 'http://localhost:5173', cookie: caregiverSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'recovery' }) }); expect(unauthorized.status).toBe(403)
    const owner = await signedSession(app); const beforeCases = (db.query('SELECT COUNT(*) count FROM continuity_cases').get() as any).count; const beforeEvents = (db.query('SELECT COUNT(*) count FROM case_events').get() as any).count; const input = { type: 'recovery', caseId: 'case-1', successor: caregiver.address }
    const response = await app.request('http://localhost/api/v1/accounts/family-a/continuity/prepare', { method: 'POST', headers: { origin: 'http://localhost:5173', cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) }); expect(response.status).toBe(200); const prepared = (await response.json()).data
    expect(prepared).toMatchObject({ chainId: 31337, to: accountAddress, data: '0x1234', manifestVersion: 'fixture-1' }); expect(continuityPreparedAccount).toBe(accountAddress); expect(continuityPreparedRequester).toBe(parent.address.toLowerCase()); expect(continuityPreparedInput).toEqual(input); expect((db.query('SELECT COUNT(*) count FROM continuity_cases').get() as any).count).toBe(beforeCases); expect((db.query('SELECT COUNT(*) count FROM case_events').get() as any).count).toBe(beforeEvents)
  })

  test('live policy reads refresh account authority and revoke the former parent after an on-chain owner change', async () => {
    const db = createDatabase(':memory:'); const chain = new LivePolicyFixtureGateway(); const now = new Date().toISOString()
    db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('parent', parent.address.toLowerCase(), now); db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('caregiver', caregiver.address.toLowerCase(), now); db.query('INSERT INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run('family-a', 31337, accountAddress, 'parent', now); db.query('INSERT INTO policy_snapshots(id,account_id,version,policy_json,effective_at,created_at) VALUES(?,?,?,?,?,?)').run('policy-family-a', 'family-a', '1', JSON.stringify({ paymentMaxRaw: '1' }), now, now)
    const app = createApp({ db, chain, config: { origin: 'http://localhost:5173', serviceKey: new Uint8Array(32) } }); const owner = await signedSession(app); const first = await app.request('http://localhost/api/v1/accounts/family-a/policy', { headers: { cookie: owner.cookie } }); expect(first.status).toBe(200); expect((await first.json()).data.policyVersion).toBe('2'); expect((db.query('SELECT policy_version,security_epoch FROM accounts WHERE id=?').get('family-a') as any)).toMatchObject({ policy_version: '2', security_epoch: '3' }); expect((db.query('SELECT policy_json FROM policy_snapshots WHERE account_id=? AND version=?').get('family-a', '2') as any).policy_json).toContain('77')
    chain.currentParent = caregiver.address.toLowerCase() as `0x${string}`;
    const headers={origin:'http://localhost:5173','content-type':'application/json'};
    const oldDiscover=await app.request('http://localhost/api/v1/accounts/discover',{method:'POST',headers:{...headers,cookie:owner.cookie},body:JSON.stringify({address:accountAddress})});expect(oldDiscover.status).toBe(404);
    const newParent = await signedSession(app, caregiver);
    const discovered=await app.request('http://localhost/api/v1/accounts/discover',{method:'POST',headers:{...headers,cookie:newParent.cookie},body:JSON.stringify({address:accountAddress})});expect(discovered.status).toBe(200);expect((await discovered.json()).data.accountId).toBe('family-a');
    const oldPrivate = await app.request('http://localhost/api/v1/accounts/family-a/family', { headers: { cookie: owner.cookie } }); expect(oldPrivate.status).toBe(404);
    const current = await app.request('http://localhost/api/v1/accounts/family-a/policy', { headers: { cookie: newParent.cookie } }); expect(current.status).toBe(200); expect((db.query('SELECT parent_user_id FROM accounts WHERE id=?').get('family-a') as any).parent_user_id).toBe('caregiver')

  })

  test('demo endpoint is localhost-only and seeds fake account reads', async () => {
    const { app } = fixture(); const response = await app.request('http://localhost/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 31337 }) }); expect(response.status).toBe(200); const result = (await response.json()).data; expect(result.mode).toBe('demo'); expect(result.warning).toContain('Fake funds'); const cookie = response.headers.get('set-cookie')!.split(';')[0]
    const accounts = await app.request('http://localhost/api/v1/accounts', { headers: { cookie } }); expect(accounts.status).toBe(200); expect((await accounts.json()).data[0].id).toBe('demo-account'); const assets = await app.request('http://localhost/api/v1/accounts/demo-account/assets', { headers: { cookie } }); expect((await assets.json()).data.length).toBe(2); const budget = await app.request('http://localhost/api/v1/accounts/demo-account/budget', { headers: { cookie } }); expect((await budget.json()).data.unit).toBe('TOKEN_UNITS'); const family = await app.request('http://localhost/api/v1/accounts/demo-account/family', { headers: { cookie } }); expect((await family.json()).data.grants[0].role).toBe('caregiver')
    const remote = await app.request('http://example.com/api/v1/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 31337 }) }); expect(remote.status).toBe(404)
  })

  test('isolates accounts and replays equivalent intent idempotently', async () => {
    const { app, db } = fixture(); const session = await signedSession(app); expect((await app.request('http://localhost/api/v1/accounts/family-b', { headers: { cookie: session.cookie } })).status).toBe(404)
    const headers = { cookie: session.cookie, 'content-type': 'application/json', 'idempotency-key': 'intent-1' }; const first = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers, body: JSON.stringify(intentBody()) }); expect(first.status).toBe(200); const one = (await first.json()).data
    const second = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers, body: JSON.stringify(intentBody()) }); expect(second.status).toBe(200); expect((await second.json()).data.id).toBe(one.id)
    const conflict = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers, body: JSON.stringify({ ...intentBody(), amountInRaw: '101' }) }); expect(conflict.status).toBe(409); const concurrentBody = { ...intentBody(), nonce: '9' }; const concurrentHeaders = { cookie: session.cookie, 'content-type': 'application/json', 'idempotency-key': 'concurrent-key' }; const concurrent = await Promise.all([0, 1].map(() => app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: concurrentHeaders, body: JSON.stringify(concurrentBody) }))); expect(concurrent.filter((r) => r.status === 200)).toHaveLength(1); expect(concurrent.filter((r) => r.status === 409)).toHaveLength(1)
    const numeric = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...intentBody(), nonce: '10', amountInRaw: '01' }) }); expect(numeric.status).toBe(400); const extra = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...intentBody(), nonce: '10', unexpectedSignedField: 'overwrite' }) }); expect(extra.status).toBe(400); const stale = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...intentBody(), nonce: '11' }) }); expect(stale.status).toBe(200); const staleIntent = (await stale.json()).data; db.query('UPDATE accounts SET policy_version=? WHERE id=?').run('2', 'family-a'); const preparedStale = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${staleIntent.id}/prepare`, { method: 'POST', headers: { cookie: session.cookie } }); expect(preparedStale.status).toBe(409)
  })

  test('viewer cannot read an attachment without a document grant', async () => {
    const { app, db } = fixture(); const owner = await signedSession(app); const form = new FormData(); form.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'receipt.jpg', { type: 'image/jpeg' })); const uploaded = await app.request('http://localhost/api/v1/accounts/family-a/attachments', { method: 'POST', headers: { cookie: owner.cookie }, body: form }); expect(uploaded.status).toBe(200); const attachment = (await uploaded.json()).data; db.query("UPDATE attachments SET state='released' WHERE id=?").run(attachment.id); db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('viewer-grant', 'family-a', 'other', 'viewer', JSON.stringify(['documents.read']), new Date().toISOString()); const viewer = await signedSession(app, other); const denied = await app.request(`http://localhost/api/v1/accounts/family-a/attachments/${attachment.id}`, { headers: { cookie: viewer.cookie } }); expect(denied.status).toBe(404)
  })

  test('intent purposes are encrypted and attachment references stay account and grant scoped', async () => {
    const { app, db } = fixture(); const owner = await signedSession(app); const form = new FormData(); form.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'receipt.jpg', { type: 'image/jpeg' })); const uploaded = await app.request('http://localhost/api/v1/accounts/family-a/attachments', { method: 'POST', headers: { cookie: owner.cookie }, body: form }); expect(uploaded.status).toBe(200); const attachmentId = (await uploaded.json()).data.id
    const created = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...intentBody(), purpose: 'private medical expense', attachmentIds: [attachmentId] }) }); expect(created.status).toBe(200); const intent = (await created.json()).data; const expense = db.query('SELECT intent_id,purpose_ciphertext,state FROM expenses WHERE intent_id=?').get(intent.id) as any; expect(expense.intent_id).toBe(intent.id); expect(expense.state).toBe('pending'); expect(expense.purpose_ciphertext).not.toContain('private medical expense')
    const otherSession = await signedSession(app, other); const denied = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: otherSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...intentBody(), nonce: '77', purpose: 'cross-account', attachmentIds: [attachmentId] }) }); expect(denied.status).toBe(404)
  })

  test('invitations bind an intended recipient, expire, and accept atomically once', async () => {
    const { app, db } = fixture(); const owner = await signedSession(app); const created = await app.request('http://localhost/api/v1/accounts/family-a/invitations', { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ intendedAddress: other.address, role: 'viewer', scopes: ['portfolio.view'], expiresInSeconds: 60 }) }); expect(created.status).toBe(200); const invitation = (await created.json()).data; const wrong = await signedSession(app, caregiver); const wrongAccept = await app.request(`http://localhost/api/v1/invitations/${invitation.invitationId}/accept`, { method: 'POST', headers: { cookie: wrong.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ secret: invitation.secret }) }); expect(wrongAccept.status).toBe(403)
    const recipient = await signedSession(app, other); const accepts = await Promise.all([0, 1].map(() => app.request(`http://localhost/api/v1/invitations/${invitation.invitationId}/accept`, { method: 'POST', headers: { cookie: recipient.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ secret: invitation.secret }) }))); expect(accepts.filter((r) => r.status === 200)).toHaveLength(1); expect(accepts.filter((r) => r.status === 409)).toHaveLength(1)
    const expired = await app.request('http://localhost/api/v1/accounts/family-a/invitations', { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ intendedAddress: other.address, role: 'viewer', scopes: ['portfolio.view'], expiresInSeconds: 60 }) }); const expiredInvite = (await expired.json()).data; db.query('UPDATE invitations SET expires_at=? WHERE id=?').run(new Date(0).toISOString(), expiredInvite.invitationId); const expiredAccept = await app.request(`http://localhost/api/v1/invitations/${expiredInvite.invitationId}/accept`, { method: 'POST', headers: { cookie: recipient.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ secret: expiredInvite.secret }) }); expect(expiredAccept.status).toBe(404)
  })

  test('policy and access kit expose safe snapshots and parent grant revoke is application scoped', async () => {
    const { app, db } = fixture(); const owner = await signedSession(app); const now = new Date().toISOString(); db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('revoke-grant', 'family-a', 'caregiver', 'caregiver', JSON.stringify(['portfolio.view']), now)
    const policy = await app.request('http://localhost/api/v1/accounts/family-a/policy', { headers: { cookie: owner.cookie } }); expect(policy.status).toBe(200); expect((await policy.json()).data.approvedRecipients).toBeArray(); const kit = await app.request('http://localhost/api/v1/accounts/family-a/access-kit', { headers: { cookie: owner.cookie } }); expect(kit.status).toBe(200); const kitData = (await kit.json()).data; expect(kitData.contract.abi.length).toBeGreaterThan(0); expect(JSON.stringify(kitData)).not.toContain('private')
    const revoked = await app.request('http://localhost/api/v1/accounts/family-a/grants/caregiver/revoke', { method: 'POST', headers: { cookie: owner.cookie } }); expect(revoked.status).toBe(200); expect((await revoked.json()).data.authority).toBe('application'); expect((db.query('SELECT revoked_at FROM account_grants WHERE id=?').get('revoke-grant') as any).revoked_at).toBeString()
  })

  test('prepares exact demo calldata and never treats unknown receipt as success', async () => {
    const { app, chain } = fixture(); const session = await signedSession(app); const response = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify(intentBody()) }); const intent = (await response.json()).data
    const prepared = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${intent.id}/prepare`, { method: 'POST', headers: { cookie: session.cookie } }); expect(prepared.status).toBe(200); expect((await prepared.json()).data.data).toMatch(/^0x[0-9a-f]+$/)
    const unknown = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${intent.id}/transactions`, { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ hash: `0x${'11'.repeat(32)}` }) }); expect(unknown.status).toBe(409)
    chain.recordReceipt({ hash: `0x${'11'.repeat(32)}`, state: 'finalized', chainId: 31337, actionHash: intent.actionHash }); const registered = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${intent.id}/transactions`, { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ hash: `0x${'11'.repeat(32)}` }) }); expect(registered.status).toBe(200)
  })

  test('caregiver action requires an exact typed approval before ABI preparation and receipt registration', async () => {
    const { app, db, chain } = fixture(); const now = new Date().toISOString(); db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('caregiver-grant', 'family-a', 'caregiver', 'caregiver', JSON.stringify(['portfolio.view', 'payment.propose', 'payment.execute']), now); db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('cosigner-grant', 'family-a', 'cosigner', 'cosigner', JSON.stringify(['portfolio.view']), now); db.query('UPDATE policy_snapshots SET policy_json=? WHERE account_id=?').run(JSON.stringify({ allowedActions: ['PAYMENT'], allowedRecipients: [intentBody().recipient], allowedAssets: [], paymentMaxRaw: '1000000000', buyMaxRaw: '1000000000', sellMaxRaw: '1000000000', settlementReserveRaw: '0', requiredApprovals: 1, exceptionApprovers: [cosigner.address] }), 'family-a')
    const caregiverSession = await signedSession(app, caregiver); const approvalSession = await signedSession(app, cosigner); const body = intentBody(); const created = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: caregiverSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(created.status).toBe(200); const intent = (await created.json()).data
    const before = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${intent.id}/prepare`, { method: 'POST', headers: { cookie: caregiverSession.cookie } }); expect(before.status).toBe(403)
    const action = intent.action; const typedSignature = await cosigner.signTypedData({ domain: actionDomain(action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(action) }); const approved = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${intent.id}/approvals`, { method: 'POST', headers: { cookie: approvalSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ signer: cosigner.address, signature: typedSignature, signatureType: 'eoa' }) }); expect(approved.status).toBe(200)
    const prepared = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${intent.id}/prepare`, { method: 'POST', headers: { cookie: caregiverSession.cookie } }); expect(prepared.status).toBe(200); const preparedBody = (await prepared.json()).data; expect(preparedBody.data).toMatch(/^0x[0-9a-f]+$/); expect(preparedBody.data.slice(0, 10)).not.toBe('0x')
    const txHash = `0x${'22'.repeat(32)}` as `0x${string}`; chain.recordReceipt({ hash: txHash, state: 'finalized', chainId: 31337, actionHash: intent.actionHash, sender: caregiver.address }); const registered = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${intent.id}/transactions`, { method: 'POST', headers: { cookie: caregiverSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ hash: txHash }) }); expect(registered.status).toBe(200)
    const exceptionBody = { ...intentBody(), nonce: '2', amountInRaw: '2000000000', exceptionMask: '1' }; const exceptionCreated = await app.request('http://localhost/api/v1/accounts/family-a/intents', { method: 'POST', headers: { cookie: caregiverSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify(exceptionBody) }); expect(exceptionCreated.status).toBe(200); const exceptionIntent = (await exceptionCreated.json()).data; const actorApproval = await caregiver.signTypedData({ domain: actionDomain(exceptionIntent.action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(exceptionIntent.action) }); const actorRejected = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${exceptionIntent.id}/approvals`, { method: 'POST', headers: { cookie: caregiverSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ signer: caregiver.address, signature: actorApproval }) }); expect(actorRejected.status).toBe(200); const exceptionApproval = await cosigner.signTypedData({ domain: actionDomain(exceptionIntent.action), types: ACTION_TYPES, primaryType: 'Action', message: actionMessage(exceptionIntent.action) }); const exceptionApproved = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${exceptionIntent.id}/approvals`, { method: 'POST', headers: { cookie: approvalSession.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ signer: cosigner.address, signature: exceptionApproval }) }); expect(exceptionApproved.status).toBe(200); const exceptionPrepared = await app.request(`http://localhost/api/v1/accounts/family-a/intents/${exceptionIntent.id}/prepare`, { method: 'POST', headers: { cookie: caregiverSession.cookie } }); expect(exceptionPrepared.status).toBe(200)
  })

  test('invitations cannot restore access after an account security epoch changes', async () => {
    const {app,db}=fixture(); const owner=await signedSession(app);
    const response=await app.request('http://localhost/api/v1/accounts/family-a/invitations',{method:'POST',headers:{cookie:owner.cookie,'content-type':'application/json'},body:JSON.stringify({intendedAddress:other.address,role:'viewer',scopes:['portfolio.view']})});
    expect(response.status).toBe(200); const invitation=(await response.json()).data;
    db.query("UPDATE accounts SET security_epoch='2' WHERE id='family-a'").run();
    const recipient=await signedSession(app,other);
    const accept=await app.request(`http://localhost/api/v1/invitations/${invitation.invitationId}/accept`,{method:'POST',headers:{cookie:recipient.cookie,'content-type':'application/json'},body:JSON.stringify({secret:invitation.secret})});
    expect(accept.status).toBe(409); expect((await accept.json()).error.code).toBe('INVITATION_AUTHORITY_CHANGED');
    expect(db.query("SELECT id FROM account_grants WHERE account_id='family-a' AND user_id='other'").get()).toBeNull();
  })

  test('bounds streamed JSON without trusting a content-length header', async () => {
    const {app}=fixture(); const r=await app.request('http://localhost/api/v1/auth/challenges',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({padding:'x'.repeat(70000)})}); expect(r.status).toBe(413);
  })

  test('continuity request proofs bind once, reject reuse, and execution cannot substitute the chain case',async()=>{
    const {app,db,chain}=fixture();const owner=await signedSession(app);
    (chain as any).confirmContinuityRequest=async(proof:any)=>proof.chainCaseId==='7';
    (chain as any).confirmContinuityExecution=async(proof:any)=>proof.chainCaseId==='7';
    const post=(path:string,body:unknown)=>app.request(`http://localhost/api/v1/accounts/family-a/${path}`,{method:'POST',headers:{cookie:owner.cookie,'content-type':'application/json'},body:JSON.stringify(body)});
    const make=async()=>(await (await post('continuity-cases',{type:'recovery',successor:caregiver.address})).json()).data.id;
    const first=await make(),second=await make(),tx=`0x${'55'.repeat(32)}`;
    expect((await post(`continuity-cases/${first}/link`,{chainCaseId:'8',transactionHash:tx})).status).toBe(409);
    expect((await post(`continuity-cases/${first}/link`,{chainCaseId:'7',transactionHash:tx})).status).toBe(200);
    expect((await post(`continuity-cases/${second}/link`,{chainCaseId:'7',transactionHash:tx})).status).toBe(409);
    db.query("UPDATE continuity_cases SET state='executable' WHERE id=?").run(first);
    expect((await post(`continuity-cases/${first}/transitions`,{toState:'executed',chainCaseId:'8',transactionHash:tx})).status).toBe(409);
    expect((await post(`continuity-cases/${first}/transitions`,{toState:'executed',chainCaseId:'7',transactionHash:tx})).status).toBe(200);
    expect(db.query('SELECT chain_case_id,execution_tx_hash,state FROM continuity_cases WHERE id=?').get(first)).toEqual({chain_case_id:'7',execution_tx_hash:tx,state:'executed'});
  })

  test('continuity requires signed reviewer/quorum evidence, waits for its timer, and rejects fake chain execution', async () => {
    const { app, db } = fixture(); const now = new Date(); const owner = await signedSession(app); const otherSession = await signedSession(app, other); const policy = { allowedActions: ['PAYMENT'], allowedRecipients: [], allowedAssets: [], paymentMaxRaw: '1000', buyMaxRaw: '1000', sellMaxRaw: '1000', settlementReserveRaw: '0', requiredApprovals: 0, exceptionApprovers: [], reviewer: cosigner.address, continuityQuorum: [caregiver.address, other.address] }; db.query('UPDATE policy_snapshots SET policy_json=? WHERE account_id=?').run(JSON.stringify(policy), 'family-a'); db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('other-review-grant', 'family-a', 'other', 'cosigner', JSON.stringify(['continuity.review', 'continuity.view']), now.toISOString())
    const deadline = new Date(Date.now() + 60_000).toISOString(); const created = await app.request('http://localhost/api/v1/accounts/family-a/continuity-cases', { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'succession', successor: caregiver.address, planVersion: '1', deadline }) }); expect(created.status).toBe(200); const createdCase = (await created.json()).data; const caseId = createdCase.id; const transition = async (toState: string, payload: Record<string, unknown> = {}) => app.request(`http://localhost/api/v1/accounts/family-a/continuity-cases/${caseId}/transitions`, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ toState, ...payload }) }); expect((await transition('evidence_pending')).status).toBe(200); expect((await transition('under_review')).status).toBe(200); expect((await transition('approved')).status).toBe(200); expect((await transition('challenge_window')).status).toBe(200)
    const reviewMessage = createdCase.reviewMessage; const early = await transition('executable', { reviewer: cosigner.address, reviewSignature: await cosigner.signMessage({ message: reviewMessage }), quorumSignatures: [{ signer: caregiver.address, signature: await caregiver.signMessage({ message: reviewMessage }) }, { signer: other.address, signature: await other.signMessage({ message: reviewMessage }) }] }); expect(early.status).toBe(409); db.query('UPDATE continuity_cases SET deadline=? WHERE id=?').run(new Date(0).toISOString(), caseId); const forged = await transition('executable', { reviewer: cosigner.address, reviewSignature: await caregiver.signMessage({ message: reviewMessage }), quorumSignatures: [] }); expect(forged.status).toBe(403); const executable = await transition('executable', { reviewer: cosigner.address, reviewSignature: await cosigner.signMessage({ message: reviewMessage }), quorumSignatures: [{ signer: caregiver.address, signature: await caregiver.signMessage({ message: reviewMessage }) }, { signer: other.address, signature: await other.signMessage({ message: reviewMessage }) }] }); expect(executable.status).toBe(200); const fakeExecuted = await transition('executed', { chainCaseId: '1', transactionHash: `0x${'33'.repeat(32)}` }); expect(fakeExecuted.status).toBe(409); expect((await app.request('http://localhost/api/v1/accounts/family-a/continuity-cases', { headers: { cookie: otherSession.cookie } })).status).toBe(200)
  })

  test('incapacity execution remains blocked until the gateway proves chain authority', async () => {
    const { app } = fixture(); const owner = await signedSession(app); const created = await app.request('http://localhost/api/v1/accounts/family-a/continuity-cases', { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'incapacity', planVersion: '1' }) }); const caseId = (await created.json()).data.id
    const transition = (toState: string, extra: Record<string, unknown> = {}) => app.request(`http://localhost/api/v1/accounts/family-a/continuity-cases/${caseId}/transitions`, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ toState, ...extra }) })
    expect((await transition('evidence_pending')).status).toBe(200); expect((await transition('under_review')).status).toBe(200); expect((await transition('approved')).status).toBe(200); expect((await transition('challenge_window')).status).toBe(200); expect((await transition('executable')).status).toBe(200); expect((await transition('executed', { chainCaseId: '2', transactionHash: `0x${'66'.repeat(32)}` })).status).toBe(409)
  })
})

test('forwarded-address spoofing cannot bypass per-wallet challenge limits',async()=>{
 const {app}=fixture();for(let i=0;i<11;i++){
  const r=await app.request('http://localhost/api/v1/auth/challenges',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':`192.0.2.${i}`},body:JSON.stringify({address:parent.address,chainId:31337})});expect(r.status).toBe(i<10?200:429);
 }
});

test('invited caregiver execution is derived from fresh exact on-chain action mask',async()=>{
 const {db,chain}=fixture();(chain as any).mode='live';let active=true,mask='1';
 (chain as any).getDelegateAuthority=async()=>({active,actionMask:mask,securityEpoch:'1',expiresAt:'9999999999'});
 db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('care','family-a','caregiver','caregiver','["portfolio.view","payment.propose"]',new Date().toISOString());
 db.query('UPDATE policy_snapshots SET policy_json=? WHERE account_id=?').run(JSON.stringify({allowedActions:['PAYMENT'],allowedRecipients:[intentBody().recipient],paymentMaxRaw:'10000',buyMaxRaw:'0',sellMaxRaw:'0',settlementReserveRaw:'0',requiredApprovals:0,exceptionApprovers:[]}),'family-a');
 const app=createApp({db,chain,config:{serviceKey:new Uint8Array(32)}}),session=await signedSession(app,caregiver);
 const post=(path:string,body:unknown={})=>app.request(`http://localhost/api/v1/accounts/family-a/${path}`,{method:'POST',headers:{origin:'http://localhost:5173',cookie:session.cookie,'content-type':'application/json'},body:JSON.stringify(body)});
 const create=await post('intents',intentBody());expect(create.status).toBe(200);const intent=(await create.json()).data;
 const sig=await caregiver.signTypedData({domain:actionDomain(intent.action),types:ACTION_TYPES,primaryType:'Action',message:actionMessage(intent.action)});
 expect((await post(`intents/${intent.id}/approvals`,{signer:caregiver.address,signature:sig})).status).toBe(200);
 mask='2';expect((await post(`intents/${intent.id}/prepare`)).status).toBe(403);
 mask='1';active=false;expect((await post(`intents/${intent.id}/prepare`)).status).toBe(403);
 active=true;expect((await post(`intents/${intent.id}/prepare`)).status).toBe(200);
});

test('application family-invite scope cannot amplify a non-parent into a grant administrator',async()=>{
 const {app,db}=fixture();db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('inviter','family-a','caregiver','caregiver','["family.invite"]',new Date().toISOString());const session=await signedSession(app,caregiver);
 const r=await app.request('http://localhost/api/v1/accounts/family-a/invitations',{method:'POST',headers:{cookie:session.cookie,'content-type':'application/json'},body:JSON.stringify({intendedAddress:other.address,role:'viewer',scopes:['portfolio.view']})});expect(r.status).toBe(403);
});

test('portfolio valuation stays account scoped and unavailable data is not fabricated',async()=>{
 const f=fixture();try{
 const session=await signedSession(f.app);
 expect((await f.app.request('http://localhost/api/v1/accounts/family-a/valuation')).status).toBe(401);
 expect((await f.app.request('http://localhost/api/v1/accounts/family-b/valuation',{headers:{cookie:session.cookie}})).status).toBe(404);
 const missing=await f.app.request('http://localhost/api/v1/accounts/family-a/valuation',{headers:{cookie:session.cookie}});
 expect(missing.status).toBe(503);expect((await missing.json()).error.code).toBe('VALUATION_UNAVAILABLE');
 }finally{f.db.close();}
});
