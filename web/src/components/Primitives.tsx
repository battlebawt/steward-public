import type { ReactNode } from "react";
import { formatAmount } from "../lib/amounts";
import type { BudgetView, Capability, PreparedTransaction, TransactionState } from "../domain";

export function MoneyAmount({ raw, decimals, symbol, usdEstimate, usdAt }: { raw: string; decimals: number; symbol: string; usdEstimate?: string; usdAt?: string }) {
  return <span className="money"><strong>{formatAmount(raw, decimals)}</strong> {symbol}{usdEstimate ? <small> ≈ ${usdEstimate} ({usdAt ?? "estimate"})</small> : null}</span>;
}

export function BudgetSummary({ budget }: { budget: BudgetView }) {
  return <section className="card" aria-labelledby="budget-title"><h2 id="budget-title">Payment budget</h2><p><MoneyAmount raw={budget.remainingRaw} decimals={budget.decimals} symbol={budget.unit} /> remaining of <MoneyAmount raw={budget.limitRaw} decimals={budget.decimals} symbol={budget.unit} />.</p>{budget.buyBudget?<div><h3>Buy budget</h3><p><MoneyAmount raw={budget.buyBudget.availableRaw} decimals={budget.decimals} symbol={budget.unit} /> available of <MoneyAmount raw={budget.buyBudget.limitRaw} decimals={budget.decimals} symbol={budget.unit} />.</p><p className="muted">Charged against this limit: <MoneyAmount raw={budget.buyBudget.chargedRaw} decimals={budget.decimals} symbol={budget.unit} />. Reserved by pending CoW orders: <MoneyAmount raw={budget.buyBudget.pendingRaw} decimals={budget.decimals} symbol={budget.unit} />. Charges can include expired unresolved orders; a charge does not prove a fill.</p></div>:null}<p className="muted">Fixed UTC window resets {budget.resetAtUtc}. Pending payment requests ({budget.pendingRequests}) do not reserve funds; execution checks the live balance and policy again.</p></section>;
}

export function PermissionSummary({ capabilities }: { capabilities: Capability[] }) {
  return <section className="card" aria-labelledby="permission-title"><h2 id="permission-title">Your authority</h2><p className="muted">App viewing access and on-chain signing power are separate. Capability labels come from the server and do not authorize an action by themselves.</p><ul className="permission-list">{capabilities.map((cap) => <li key={cap.action}><span>{cap.action}</span><span className={cap.allowed ? "status status-ok" : "status status-blocked"}>{cap.allowed ? "Allowed" : "Blocked"}</span>{cap.reason ? <small>{cap.reason}</small> : null}</li>)}</ul></section>;
}

export function PriceStatus({ basis, source, observedAt, state, reason }: { basis: string; source: string; observedAt: string; state: "fresh" | "stale" | "unavailable"; reason?: string }) {
  return <section className="card"><h2>Price status</h2><p><span className={`status ${state === "fresh" ? "status-ok" : "status-warn"}`}>{state}</span> · {basis}</p><p className="muted">Source: {source}. Observed {observedAt}. {reason ?? "A displayed value is informational and is not an executable quote."}</p></section>;
}

/** Plain-language risk at the point of signature; never used as an eligibility decision. */
export function BetaRiskLine({ chainId }: { chainId: number }) {
  const message = chainId === 31337
    ? "Demo, fake funds. This action is practice and moves no real assets."
    : chainId === 46630
      ? "Testnet, valueless mock assets. This does not buy or sell a real stock token."
      : chainId === 4663
        ? "Beta, real funds. This action may move a parent's assets or change account authority. Once included on Robinhood Chain mainnet, the transaction cannot be undone. Steward's contracts have not been independently audited."
        : "Check the network and action before signing. An included blockchain transaction cannot be undone.";
  return <p className="beta-risk-line" role="note"><strong>{message.split(". ")[0]}.</strong> {message.split(". ").slice(1).join(". ")}</p>;
}

export function TransactionReview({ intentSummary, prepared }: { intentSummary: string; prepared?: PreparedTransaction | { to: `0x${string}`; chainId: number; data: `0x${string}`; manifestVersion: string; simulation?: { ok: boolean; reason?: string }; actionHash?: string } }) {
  return <section className="card review"><h2>Review before signing</h2><p>{intentSummary}</p>{prepared ? <><dl><div><dt>Destination</dt><dd className="address">{prepared.to}</dd></div><div><dt>Chain</dt><dd>{prepared.chainId}</dd></div><div><dt>Manifest</dt><dd>{prepared.manifestVersion}</dd></div>{prepared.actionHash ? <div><dt>Action hash</dt><dd className="address">{prepared.actionHash}</dd></div> : null}<div><dt>Calldata</dt><dd className="address">{prepared.data.slice(0, 18)}…</dd></div>{prepared.simulation ? <div><dt>Simulation</dt><dd>{prepared.simulation.ok ? "Passed" : `Blocked: ${prepared.simulation.reason}`}</dd></div> : null}</dl><BetaRiskLine chainId={prepared.chainId} /></> : <p className="muted">Prepare the action to see the exact destination, method and action hash. The wallet request stays blocked until those checks pass.</p>}</section>;
}

export function TransactionStatus({ state, intentId, txHash, message }: { state: TransactionState; intentId: string; txHash?: string; message?: string }) {
  return <section className="card"><h2>Transaction status</h2><p><span className="status status-info">{state.replaceAll("_", " ")}</span> · intent {intentId}</p>{txHash ? <p className="address">Transaction hash: {txHash}</p> : null}<p className="muted">{message ?? (state === "checking_status" ? "Checking the original intent and transaction hash. No automatic resend will occur." : "The chain is authoritative for execution.")}</p></section>;
}

export function PrivateAttachment({ fileName, state, permission }: { fileName?: string; state: "none" | "ready" | "uploading" | "blocked"; permission: string }) {
  return <section className="card"><h2>Private attachment</h2>{fileName ? <p>{fileName} · {state}</p> : <p className="muted">No attachment selected.</p>}<p className="muted">Access: {permission}. Files use an opaque ID and never a public object URL.</p></section>;
}

export function OperationalNotice({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="notice" role="status"><strong>{title}</strong><p>{children}</p></aside>;
}

export function StatePanel({ state, children }: { state: "loading" | "empty" | "error" | "permission"; children: ReactNode }) {
  return <div className={`state state-${state}`} role={state === "error" ? "alert" : undefined}><strong>{state === "permission" ? "Access not granted" : state === "loading" ? "Loading" : state === "empty" ? "Nothing here yet" : "Could not load this area"}</strong><p>{children}</p></div>;
}

export function FullAddress({ value }: { value: string }) { return <span className="address">{value}</span>; }
