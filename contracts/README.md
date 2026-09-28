# Steward contracts

This directory contains the non-upgradeable Steward account and its factory. `StewardFactoryV1` deploys minimal clones whose implementation address is immutable for the factory version; each clone is initialized once and has no upgrade path. `StewardAccountV1` is the authority boundary: delegated payment and trade execution accepts one canonical EIP-712 action, checks the current security epoch and policy version, validates exact recipients/routes, and consumes account-wide fixed UTC-period counters before interactions. A reverted interaction rolls those effects back.

The signed action is:

```text
Action(bytes32 actionId,uint8 kind,address account,address actor,uint256 chainId,uint256 securityEpoch,uint256 policyVersion,uint256 nonce,address tokenIn,address tokenOut,address recipient,uint256 amountInRaw,uint256 minAmountOutRaw,address adapter,bytes32 routeHash,uint64 validAfter,uint64 deadline,uint256 exceptionMask)
```

The EIP-712 domain is name `Steward`, version `1`, the current chain ID, and the account as verifying contract. `kind` is `0` payment, `1` buy, or `2` sell. Payment and trade execution are separate entry points, and trade adapters are admitted explicitly by the parent and pinned by route hash.

`StewardTradeAdapterV1` requires a separately configured settlement feed and stock feed. It enforces freshness, positive non-paused prices, an independent minimum-output floor, measured balance deltas, exact approvals, and zero residual allowance. `StewardChainlinkPriceSourceV1` supports per-asset feed heartbeats and an optional L2 sequencer grace period. `StewardUniswapV3VenueV1` only exposes a configured single-hop exact-input route.

Recovery is distinct from succession. Recovery starts a 48-hour delay only after the second guardian approval, expires, increments the security epoch, and preserves period counters. Succession is a separate reviewer-attested, guardian-quorum, challengeable transition with exact plan and evidence commitments. A request does not freeze delegated spending.

Delegate, adapter, and incapacity-module additions are exact queued expansions with the same 48-hour review delay; revocation and restrictive policy changes take effect immediately and advance the policy version. `StewardAccountV1.queueIncapacityModule` and `executeIncapacityModule` enroll one exact module/caregiver scope. `StewardIncapacityModuleV1` is pre-enrolled to one caregiver, reviewer, guardians, quorum, action mask, per-action limit, and plan hash. It can only activate that bounded caregiver scope after reviewer attestation, distinct guardian quorum, a challengeable delay, and expiry; it cannot change the parent or withdraw assets. Feed identity is pinned by the adapter manifest, while the Chainlink source is deployment-pinned and fail-closed for missing sequencer configuration.

These contracts are locally testable with Foundry. Provider fork tests, physical WebAuthn tests, jurisdictional eligibility, reviewer operations, and independent security review remain external launch gates.

```sh
forge test --root contracts --offline
forge build --root contracts --offline --sizes
```
