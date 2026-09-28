import type { StewardDatabase } from './db'
import { DemoChainGateway } from './chain'

const DEMO_PARENT = '0x1000000000000000000000000000000000000001' as const
const DEMO_ACCOUNT = '0x2000000000000000000000000000000000000002' as const
const DEMO_CAREGIVER = '0x3000000000000000000000000000000000000003' as const
const DEMO_RECIPIENT = '0x4000000000000000000000000000000000000004' as const
const DEMO_SETTLEMENT = '0x0000000000000000000000000000000000000001' as const
const DEMO_STOCK = '0x0000000000000000000000000000000000000005' as const

/** Seeds fake balances and policy only when the process was explicitly started in demo mode. */
export function seedDemoDatabase(db: StewardDatabase, chain: DemoChainGateway) {
  if (chain.mode !== 'demo') throw new Error('Demo seed cannot run against a live gateway')
  const now = new Date().toISOString(); const userId = 'demo-parent'; const accountId = 'demo-account'
  db.query('INSERT OR IGNORE INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run(userId, DEMO_PARENT, now)
  db.query('INSERT OR IGNORE INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run('demo-caregiver', DEMO_CAREGIVER, now)
  db.query('INSERT OR IGNORE INTO accounts(id,chain_id,address,parent_user_id,created_at) VALUES(?,?,?,?,?)').run(accountId, chain.chainId, DEMO_ACCOUNT, userId, now)
  db.query('INSERT OR IGNORE INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('demo-caregiver-grant', accountId, 'demo-caregiver', 'caregiver', JSON.stringify(['portfolio.view', 'record.view', 'payment.propose']), now)
  db.query('INSERT OR IGNORE INTO delegate_snapshots(id,account_id,delegate_address,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run('demo-caregiver-delegate', accountId, DEMO_CAREGIVER, 'caregiver', JSON.stringify(['portfolio.view', 'record.view', 'payment.propose']), now)
  db.query('INSERT OR IGNORE INTO policy_snapshots(id,account_id,version,policy_json,effective_at,created_at) VALUES(?,?,?,?,?,?)').run('demo-policy', accountId, '1', JSON.stringify({ allowedActions: ['PAYMENT', 'BUY', 'SELL'], allowedRecipients: [DEMO_RECIPIENT], allowedAssets: [DEMO_SETTLEMENT, DEMO_STOCK], paymentMaxRaw: '500000000', buyMaxRaw: '250000000', sellMaxRaw: '250000000', settlementReserveRaw: '100000000', requiredApprovals: 0, exceptionApprovers: [] }), now, now)
  const assets = [
    ['demo-settlement', 'demo', chain.chainId, DEMO_SETTLEMENT, 'USDG', 'Demo Settlement', 6, 'settlement_token', 'demo-1', JSON.stringify(['buy', 'sell', 'payment']), 'allowed'],
    ['demo-stock', 'demo', chain.chainId, DEMO_STOCK, 'DEMO', 'Demo Stock', 8, 'tokenized_stock', 'demo-1', JSON.stringify(['buy', 'sell']), 'allowed'],
  ] as const
  for (const asset of assets) db.query('INSERT OR IGNORE INTO assets(id,provider,chain_id,address,symbol,name,decimals,legal_instrument_type,source_terms_version,capabilities_json,admission) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...asset)
  db.query('INSERT OR IGNORE INTO holdings_snapshots(id,account_id,asset_id,balance_raw,observed_block,observed_at) VALUES(?,?,?,?,?,?)').run('demo-settlement-holding', accountId, 'demo-settlement', '1000000000', '1', now)
  db.query('INSERT OR IGNORE INTO holdings_snapshots(id,account_id,asset_id,balance_raw,observed_block,observed_at) VALUES(?,?,?,?,?,?)').run('demo-stock-holding', accountId, 'demo-stock', '250000000', '1', now)
  return { userId, accountId, parentAddress: DEMO_PARENT, caregiverAddress: DEMO_CAREGIVER, recipientAddress: DEMO_RECIPIENT, accountAddress: DEMO_ACCOUNT, chainId: chain.chainId }
}
