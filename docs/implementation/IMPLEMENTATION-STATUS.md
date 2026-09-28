# Implementation status

Steward has a runnable local application, contract and API implementation, a fake-funds demo, and separate mock-asset testnet rehearsals. These establish that important engineering paths can run. They do **not** establish a production security review, a real-money launch, or permission to offer an asset in any market.

## Working in the current implementation

| Area | Present capability |
| --- | --- |
| Parent control | A self-custodial account with bounded caregiver grants, amount limits, expiry, explicit approvals, immediate restrictions and revocation. |
| Actions | Exact signed requests bind the actor, account, chain, amount, destination, nonce and deadline. Prepared actions can be simulated before submission. |
| Records | Account-scoped invitations, proposals, approvals, verified receipts, encrypted purpose and document records, and activity views. |
| Continuity | Named recovery, incapacity and succession flows with contract-level checks and separate family case records. An app record alone does not transfer ownership. |
| Experience | Local demo sign-in, guided parent and caregiver workflows, passkey support, balances, budgets, activity and continuity screens. |
| Operations | Persistent jobs, chain indexing, notifications, encrypted backups and restore checks. |

Some capabilities above have been exercised in local simulations or with mock assets on a public testnet. A simulated asset trade is evidence about the transaction mechanics at a particular tested state. It is not a live customer trade, an independent audit, or proof that the asset can be offered to a particular person.

## Still required before real-money use

- Independent review of the final contracts, integrations, passkey flows and operating controls.
- Reviewed production deployments, verified contract and provider configuration, and real-device acceptance at the final site origin.
- A specific asset and venue whose rights, terms, liquidity, pricing, availability and user eligibility have been reviewed for the intended market. No stock-linked route is currently approved for Steward's public real-money use.
- Tested recovery procedures for encrypted records and access continuity, with the people and responsibilities identified.
- Market-specific legal and operational review of the exact live flow. The account architecture alone does not resolve individual verification or local restrictions.

The parent-owned account, caregiver permissions, records and continuity work remain the shared product while individual asset routes are evaluated. See [Market routes](MARKET-ROUTES.md) for the route-by-route distinction.
