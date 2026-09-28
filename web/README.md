# Steward web frontend

This is the deliberately plain React/Vite resource console for Steward. It has the five account sections from the frontend specification (`Portfolio`, `Care`, `Family`, `Record`, and `Continuity`) plus enrollment, invitation, policy, asset and settings routes. Account, asset, intent, invitation, activity, statement, continuity and session data are loaded through the API; errors and empty/permission states are visible instead of being replaced with local balances or records. It uses semantic forms and tables, visible state labels, full addresses in reviewable contexts, and a small set of replaceable components in `src/components`.

Run from the repository root with `bun run dev:web`, or from this directory with `bun run dev`. Vite proxies `/api` to `http://localhost:3000`; the API client sends cookies and an optional `X-CSRF-Token` header and preserves structured server errors.

`src/domain.ts` aliases action and prepared-transaction payload types from `@steward/shared`. `src/lib/preparedTx.ts` independently checks the chain, Steward-account destination, supported manifest, native value, simulation, expiry, EIP-712 action hash and canonical tuple calldata before a wallet request is considered. The wallet helper checks EIP-1193 account/network stability around `personal_sign`, EIP-712 signing and `eth_sendTransaction`, and represents an unknown submission as `checking_status` so callers can resume by intent/hash without resending.

Demo mode is visibly labeled fake funds on chain 31337 and never sends a wallet transaction. Start calls the explicit local `POST /api/v1/auth/demo` session route; protected pages read the returned account through `/accounts`. Live routes do not substitute demo balances; unauthorized or unavailable API responses are shown as structured errors. The current server must provide the demo session route before the no-wallet demo flow can be exercised.

Focused tests run with `bun run test` in this package. The tests cover integer amount parsing/formatting, altered prepared transaction fields, wallet account/chain changes, unknown submission recovery, structured API errors, credentials and CSRF headers.
