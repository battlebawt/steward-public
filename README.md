# Steward

![Steward in folded paper lettering, with the orange-capped paper mascot](assets/steward-paper-banner.gif)

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-496a4b)](LICENSE)
![Status: demo and testnet](https://img.shields.io/badge/status-demo%20%2B%20testnet-c9662b)

**A family account should stay in the parent's hands, even when someone else helps.** Steward is software for a parent-owned, self-custodial account. A parent can give a caregiver specific authority, set amount and recipient limits, revoke access, keep a clear record of what happened, and plan for recovery or succession.

Steward is a working local implementation with a fake-funds demo and separate testnet rehearsals. It is **not approved for real-money use**. A testnet transaction demonstrates the software path; it does not establish that a person is eligible for an asset or that an asset route is available in their country.

## The idea

1. **The parent sets the rules.** They choose who may help, which actions are allowed, and the limits that apply. On-chain caregiver authority is separate from an invitation to use the app.
2. **The caregiver acts within those rules.** Payments and other supported actions use exact amounts and explicit approvals. The parent can revoke delegated authority.
3. **The family has a record and a continuity plan.** Steward links activity to verifiable receipts and supports named recovery, incapacity, and succession steps. Recording a case in the app alone does not transfer control of an account.

The account is designed to be independent of any one country, issuer, broker, or trading venue. Each optional asset route needs its own technical and eligibility review. Steward does not assume a broker partnership or business KYB as part of the core product, and it does not promise that users can avoid any verification required by a particular route.

## Try the local demo

Install [Bun 1.3.14](https://bun.sh/) and run:

```sh
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:5173` and choose **Start demo session**. The demo uses invented users, assets, and funds. It cannot send a real wallet transaction. Foundry is also needed for contract development and the full verification suite.

```sh
bun run build
bun run verify
```

`verify` exercises contracts, generated ABIs, TypeScript, the web build, local integrations, and browser workflows. Passing it is engineering evidence for that source revision, not a financial-product approval or a live asset-eligibility check.

## What is here

| Area | What it does |
| --- | --- |
| `contracts/src` | Parent-owned account, permission and approval logic, recovery controls, and route adapters. |
| `shared/src` | Exact request formats and action hashing shared by the app and API. |
| `server/src` | API, records, verified chain reads, indexing, encrypted documents, and operations. |
| `web/src` | Parent and caregiver workflows. |
| `scripts` | Local rehearsals, build checks, and operating tools. |

The paper-inspired interface is a working front end for the parent and caregiver flows. The [implementation status](docs/implementation/IMPLEMENTATION-STATUS.md) records what has been exercised and what remains. The [market route plan](docs/implementation/MARKET-ROUTES.md) explains why adding an asset requires separate review.

## Use and license

Original Steward software in this repository is offered under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may inspect, use, and adapt it for permitted noncommercial purposes under those terms. Commercial use requires a separate grant from the rights holder. This is **source-available software**, not an OSI-approved open-source license. Vendored dependencies, including OpenZeppelin Contracts and forge-std, retain their own license terms.

The [source snapshot](SOURCE-SNAPSHOT.md) lists what this public export includes and excludes. The history and its limits are described in [PROVENANCE.md](PROVENANCE.md). The private source repository's recorded commits start in September 2026; earlier research is described separately from Git commits.
