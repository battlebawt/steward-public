import { useEffect, useMemo, useRef, useState } from "react";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { randomBytes32, UInt256Schema } from "@steward/shared";
import type { ActionIntent, AccountSnapshot, AssetDescriptor, BudgetView, ContinuityCase, PreparedTransaction } from "@steward/shared";
import type { AppMode } from "../domain";
import { createApiClient } from "../lib/api";
import { userFacingError } from "../lib/errors";
import { parsePositiveAmount, settlementAsset } from "../lib/amounts";
import { connectWallet, signChallenge, signAction, sendPreparedCall, sendPreparedCallWithPasskey, sendPreparedTransaction, DEMO_CHAIN_ID, type WalletSession } from "../lib/wallet";
import { SUPPORTED_MANIFEST_VERSIONS, verifyPreparedCall, type PreparedCall } from "../lib/preparedTx";
import { encodeDeploymentCall, encodeManagementCall, verifyManagementCalldata, encodeContinuityCall, verifyContinuityCalldata } from "../lib/management";
import { buildDelegateRequest, buildRevokeDelegateRequest, type DelegatePermission } from "../lib/delegation";
import { buildContinuityRequest, CONTINUITY_OPERATIONS, type ContinuityOperation } from "../lib/continuityRequest";
import { encodePasskeySignature, getPasskeyAssertion, passkeyMessageDigest } from "../lib/passkeys";
import { BetaRiskLine, BudgetSummary, MoneyAmount, OperationalNotice, PermissionSummary, PriceStatus, PrivateAttachment, StatePanel, TransactionReview, TransactionStatus } from "../components/Primitives";
import { LinkButton, PageHeading } from "../components/Shell";
import { EnrollmentTools } from "../components/EnrollmentTools";
import { LocalCowOrders } from "../components/LocalCowOrders";
import { isRobinhoodStockPurchase, locationAnswerDoesNotBlockQuote, RobinhoodPurchaseNotice, type PurchaseLocationAnswer } from "../components/RobinhoodPurchaseNotice";

const api = createApiClient();
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
type Resource<T> = { data?: T; loading: boolean; error?: string; refresh: () => void };

function useResource<T>(path: string | undefined): Resource<T> {
  const [state, setState] = useState<{ data?: T; loading: boolean; error?: string }>({ loading: Boolean(path) });
  const [version, setVersion] = useState(0);
  const requestVersion = useRef(0);
  useEffect(() => {
    if (!path) { setState({ loading: false }); return; }
    const currentVersion = ++requestVersion.current;
    const controller = new AbortController(); setState({ loading: true });
    void api.get<T>(path, controller.signal).then((response) => { if (currentVersion === requestVersion.current) setState({ data: response.data, loading: false }); }).catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError") && currentVersion === requestVersion.current) setState({ loading: false, error: userFacingError(error) }); });
    return () => controller.abort();
  }, [path, version]);
  return { ...state, refresh: () => setVersion((v) => v + 1) };
}

function ResourceState({ resource, empty = "No records returned by the server." }: { resource: Resource<unknown>; empty?: string }) {
  if (resource.loading) return <StatePanel state="loading">Waiting for the authorized API response.</StatePanel>;
  if (resource.error) return <StatePanel state="error">{resource.error}</StatePanel>;
  if (resource.data === undefined || (Array.isArray(resource.data) && resource.data.length === 0)) return <StatePanel state="empty">{empty}</StatePanel>;
  return null;
}

function useAccounts() { return useResource<AccountSnapshot[]>("/accounts"); }
function selectedAccount(accounts?: AccountSnapshot[]) { return accounts?.[0]; }

const INCAPACITY_MODULE_ABI = [{ type: "function", name: "incapacityModule", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
function continuityUsesIncapacity(operation: unknown) { return typeof operation === "string" && operation.endsWith("Incapacity"); }
async function continuityTarget(account: AccountSnapshot, operation: unknown): Promise<`0x${string}`> {
  if (!continuityUsesIncapacity(operation)) return account.address;
  const provider = (window as Window & { ethereum?: import("viem").EIP1193Provider }).ethereum;
  if (!provider) throw new Error("Connect a wallet to independently verify the incapacity module target.");
  const raw = await provider.request({ method: "eth_call", params: [{ to: account.address, data: encodeFunctionData({ abi: INCAPACITY_MODULE_ABI, functionName: "incapacityModule", args: [] }) }, "latest"] });
  return decodeFunctionResult({ abi: INCAPACITY_MODULE_ABI, functionName: "incapacityModule", data: raw as `0x${string}` }) as `0x${string}`;
}

function AccountIdentity({ account }: { account: AccountSnapshot }) {
  return <section className="card"><h2>Account snapshot</h2><dl><div><dt>Account</dt><dd className="address">{account.address}</dd></div><div><dt>Parent</dt><dd className="address">{account.parent}</dd></div><div><dt>Chain</dt><dd>{account.chainId}</dd></div><div><dt>Role</dt><dd>{account.role}</dd></div><div><dt>Policy/security</dt><dd>{account.policyVersion} / {account.securityEpoch}</dd></div><div><dt>Snapshot</dt><dd>Block {account.snapshotBlock} · {account.indexFreshness}</dd></div></dl></section>;
}

function AccountControls({ account, settlement }: { account: AccountSnapshot; settlement?: AssetDescriptor }) {
  const budget = useResource<BudgetView & { resetAt?: string; basis?: string }>(`/accounts/${account.id}/budget`);
  const policy = useResource<any>(`/accounts/${account.id}/policy`);
  const [accessKit, setAccessKit] = useState<unknown>(); const [accessKitLoading, setAccessKitLoading] = useState(false); const [error, setError] = useState("");
  async function loadAccessKit(download = false) {
    try {
      setError(""); setAccessKitLoading(true);
      const value = (await api.get(`/accounts/${account.id}/access-kit`)).data;
      setAccessKit(value);
      if (download) {
        const href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
        const link = document.createElement("a"); link.href = href; link.download = `steward-access-kit-${account.id}.json`; link.click();
        URL.revokeObjectURL(href);
      }
    } catch (e) { setError(userFacingError(e)); } finally { setAccessKitLoading(false); }
  }
  const budgetView = budget.data && settlement ? { limitRaw: budget.data.limitRaw, spentRaw: budget.data.spentRaw, remainingRaw: budget.data.remainingRaw, unit: settlement.symbol, decimals: settlement.decimals, resetAtUtc: budget.data.resetAt, pendingRequests: budget.data.pendingRequests, buyBudget: budget.data.buyBudget } : undefined;
  return <><ResourceState resource={budget} />{budgetView ? <BudgetSummary budget={budgetView} /> : budget.data ? <p className="muted">Budget amount is unavailable until the settlement token metadata loads.</p> : null}<section className="card"><h2>Current policy</h2><ResourceState resource={policy} />{policy.data ? <details><summary>View detailed account policy</summary><pre className="json-block">{JSON.stringify(policy.data, null, 2)}</pre></details> : null}</section><section className="card"><h2>Access kit</h2><p className="muted">The server authorizes this JSON package with account, policy and contract ABI data.</p><div className="actions"><button type="button" onClick={() => loadAccessKit(false)} disabled={accessKitLoading}>{accessKitLoading ? "Loading…" : "Load access-kit JSON"}</button><button type="button" onClick={() => loadAccessKit(true)} disabled={accessKitLoading}>Download access-kit JSON</button></div>{accessKit ? <details><summary>View access-kit details</summary><pre className="json-block">{JSON.stringify(accessKit, null, 2)}</pre></details> : null}{error ? <p className="error" role="alert">{error}</p> : null}</section></>;
}

function ContinuityChainForm({ account, cases, onObservedHash }: { account: AccountSnapshot; cases: ContinuityCase[]; onObservedHash: (hash: string) => void }) {
  const [draft, setDraft] = useState({ operation: "startRecovery" as ContinuityOperation, id: "", successor: "", reviewer: "", planHash: "", evidenceHash: "", signature: "", approved: true, deadlineDays: 30 as 7 | 30 });
  const [advancedJson, setAdvancedJson] = useState('{"operation":"cancelRecovery"}');
  const [passkeySigner, setPasskeySigner] = useState(""); const [request, setRequest] = useState<Record<string, unknown>>(); const [prepared, setPrepared] = useState<PreparedCall>();
  const [hash, setHash] = useState(""); const [recoveryHash, setRecoveryHash] = useState(""); const [receiptState, setReceiptState] = useState<"pending" | "included" | "failed">(); const [preparing, setPreparing] = useState(false); const [submitting, setSubmitting] = useState(false); const [submissionUnknown, setSubmissionUnknown] = useState(false); const [error, setError] = useState("");
  const version = useRef(0); const prepareLock = useRef(false); const submitLock = useRef(false);
  const storageKey = `steward.pending-continuity.${account.chainId}.${account.address}`;
  function invalidate() { version.current += 1; setRequest(undefined); setPrepared(undefined); setError(""); }
  function change<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) { setDraft((current) => ({ ...current, [key]: value })); invalidate(); }
  useEffect(() => {
    invalidate(); setHash(""); setReceiptState(undefined);
    try {
      const raw = localStorage.getItem(storageKey); if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (Object.keys(saved).sort().join(",") !== "account,chainId,hash" || saved.account !== account.address || saved.chainId !== account.chainId || typeof saved.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(saved.hash)) return;
      setHash(saved.hash); onObservedHash(saved.hash); setReceiptState("pending"); void checkReceipt(saved.hash);
    } catch { /* Untrusted local storage cannot authorize a continuity operation. */ }
  }, [storageKey]);
  async function checkReceipt(originalHash: string) {
    try {
      const provider = (window as Window & { ethereum?: import("viem").EIP1193Provider }).ethereum;
      if (!provider) throw Error("Connect a compatible wallet to check the original transaction.");
      const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [originalHash as `0x${string}`] }) as { status?: string } | null;
      setReceiptState(!receipt || !receipt.status ? "pending" : receipt.status === "0x1" || receipt.status === "0x01" ? "included" : "failed");
    } catch (cause) { setError(userFacingError(cause)); }
  }
  async function prepare(next: Record<string, unknown>) {
    if (prepareLock.current || submitLock.current || submissionUnknown || (hash && receiptState === "pending")) { setError("Check the original wallet transaction before preparing another continuity step."); return; }
    prepareLock.current = true; setPreparing(true); invalidate(); const current = version.current;
    setHash(""); setReceiptState(undefined);
    try {
      const expectedData = encodeContinuityCall(next);
      const expectedTo = await continuityTarget(account, next.operation);
      const response = await api.post<PreparedCall>(`/accounts/${account.id}/continuity/prepare`, next);
      if (current !== version.current) return;
      const candidate = response.data;
      const envelope = verifyPreparedCall(candidate, { chainId: account.chainId, to: expectedTo, data: expectedData, manifestVersions: SUPPORTED_MANIFEST_VERSIONS });
      if (!envelope.ok) throw Error(envelope.reason);
      const decoded = verifyContinuityCalldata(next, candidate.data);
      if (!decoded.ok) throw Error(decoded.reason);
      setRequest(next); setPrepared(candidate);
    } catch (cause) { if (current === version.current) setError(userFacingError(cause)); }
    finally { prepareLock.current = false; setPreparing(false); }
  }
  async function submit() {
    if (!prepared || !request || hash || submissionUnknown || prepareLock.current || submitLock.current) return;
    submitLock.current = true; setSubmitting(true); let attempted = false;
    try {
      const current = version.current;
      const expectedData = encodeContinuityCall(request);
      const expectedTo = await continuityTarget(account, request.operation);
      const expectations = { chainId: account.chainId, to: expectedTo, data: expectedData, manifestVersions: SUPPORTED_MANIFEST_VERSIONS };
      const envelope = verifyPreparedCall(prepared, expectations); if (!envelope.ok) throw Error(envelope.reason);
      const decoded = verifyContinuityCalldata(request, prepared.data); if (!decoded.ok) throw Error(decoded.reason);
      const provider = (window as Window & { ethereum?: import("viem").EIP1193Provider }).ethereum; if (!provider) throw Error("Connect a compatible wallet.");
      const session = await connectWallet(provider);
      if (session.chainId !== account.chainId || current !== version.current) throw Error("Wallet network or reviewed continuity request changed.");
      attempted = true;
      const sent = passkeySigner ? await sendPreparedCallWithPasskey(provider, prepared, expectations, passkeySigner as `0x${string}`, session, { allowCredentials: (() => { try { const saved = localStorage.getItem("steward.passkey.credential." + passkeySigner.toLowerCase()); return saved ? [{ id: JSON.parse(saved).id, type: "public-key" as const }] : undefined; } catch { return undefined; } })() }) : await sendPreparedCall(provider, prepared, expectations, session);
      setHash(sent); onObservedHash(sent); setReceiptState("pending");
      try { localStorage.setItem(storageKey, JSON.stringify({ account: account.address, chainId: account.chainId, hash: sent })); } catch { /* Show original hash for manual recovery. */ }
      await checkReceipt(sent);
    } catch (cause) { if (attempted) setSubmissionUnknown(true); setError(`${userFacingError(cause)} Check the original wallet transaction before retrying.`); }
    finally { submitLock.current = false; setSubmitting(false); }
  }
  const needsId = /^(approveRecovery|approveSuccession|acceptSuccession|challengeSuccession|resolveSuccession|executeSuccession|approveIncapacity|challengeIncapacity|resolveIncapacity|cancelIncapacity|expireIncapacity|executeIncapacity)$/.test(draft.operation);
  const needsSuccessor = draft.operation === "startRecovery" || draft.operation === "requestSuccession";
  const needsReviewer = draft.operation === "requestSuccession";
  const needsPlan = draft.operation === "requestSuccession" || draft.operation === "executeSuccession";
  const needsEvidence = needsPlan || draft.operation === "requestIncapacity";
  const needsSignature = draft.operation === "approveSuccession" || draft.operation === "acceptSuccession" || draft.operation === "approveIncapacity";
  const needsDeadline = draft.operation === "requestSuccession" || draft.operation === "requestIncapacity";
  const needsDecision = draft.operation === "resolveSuccession" || draft.operation === "resolveIncapacity";
  return <section className="card"><h2>On-chain continuity step</h2><p>Choose the step and have the authorized parent, guardian, reviewer or successor sign it. A case record, a prepared call, and a submitted wallet transaction are distinct. Ownership changes only after the contract's approvals, challenge period and execution succeed.</p>
    <label>Continuity step<select value={draft.operation} onChange={(e) => change("operation", e.target.value as ContinuityOperation)}>{CONTINUITY_OPERATIONS.map((item) => <option key={item} value={item}>{item.replace(/([A-Z])/g, " $1").toLowerCase()}</option>)}</select></label>
    {needsId ? <><label>Choose an existing on-chain case<select value={draft.id} onChange={(e) => change("id", e.target.value)}><option value="">Enter a case number below</option>{cases.filter((item) => item.chainCaseId).map((item) => <option key={item.id} value={item.chainCaseId}>{item.type} · chain case {item.chainCaseId}</option>)}</select></label><label>On-chain case number<input inputMode="numeric" value={draft.id} onChange={(e) => change("id", e.target.value)} /></label></> : null}
    {needsSuccessor ? <label>New parent or successor wallet address<input value={draft.successor} onChange={(e) => change("successor", e.target.value)} placeholder="0x…" /></label> : null}
    {needsReviewer ? <label>Independent reviewer wallet address<input value={draft.reviewer} onChange={(e) => change("reviewer", e.target.value)} placeholder="0x…" /></label> : null}
    {needsPlan ? <label>Existing succession plan hash<input value={draft.planHash} onChange={(e) => change("planHash", e.target.value)} placeholder="0x…" /></label> : null}
    {needsEvidence ? <label>Existing evidence hash<input value={draft.evidenceHash} onChange={(e) => change("evidenceHash", e.target.value)} placeholder="0x…" /></label> : null}
    {needsSignature ? <label>Reviewer or successor approval signature<input value={draft.signature} onChange={(e) => change("signature", e.target.value)} placeholder="0x…" /></label> : null}
    {needsDeadline ? <label>Request deadline<select value={draft.deadlineDays} onChange={(e) => change("deadlineDays", Number(e.target.value) as 7 | 30)}><option value={7}>7 days</option><option value={30}>30 days</option></select></label> : null}
    {needsDecision ? <label>Review decision<select value={draft.approved ? "approve" : "reject"} onChange={(e) => change("approved", e.target.value === "approve")}><option value="approve">Approve</option><option value="reject">Reject</option></select></label> : null}
    <p className="muted">Plan and evidence hashes must come from real records. Steward does not create an approval or declare a person incapacitated.</p>
    <label>Optional passkey signer address<input value={passkeySigner} onChange={(e) => { setPasskeySigner(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    <button type="button" disabled={preparing || submitting || submissionUnknown || receiptState === "pending"} onClick={() => { try { void prepare(buildContinuityRequest({ ...draft, nowSeconds: Math.floor(Date.now() / 1000) })); } catch (cause) { setError(userFacingError(cause)); } }}>Prepare continuity step</button>
    <details><summary>Advanced continuity JSON</summary><label>Reviewed operation JSON<textarea rows={5} value={advancedJson} onChange={(e) => { setAdvancedJson(e.target.value); invalidate(); }} /></label><button type="button" disabled={preparing || submitting || submissionUnknown || receiptState === "pending"} onClick={() => { try { void prepare(JSON.parse(advancedJson) as Record<string, unknown>); } catch (cause) { setError(userFacingError(cause)); } }}>Prepare advanced continuity step</button></details>
    {request ? <details><summary>Exact reviewed request</summary><pre className="json-block">{JSON.stringify(request, null, 2)}</pre></details> : null}
    {prepared ? <TransactionReview intentSummary={`Reviewed ${String(request?.operation)} call; confirm exact target, chain and parameters before signing.`} prepared={prepared as any} /> : null}
    <button type="button" onClick={submit} disabled={!prepared || !request || Boolean(hash) || preparing || submitting || submissionUnknown}>Submit reviewed continuity step</button>
    {hash ? <p role="status">Observed wallet transaction {hash}: {receiptState === "included" ? "included on-chain, but the family case still needs a verified link and any further required approvals" : receiptState === "failed" ? "failed on-chain; no continuity step took effect" : "pending; do not submit it again"}. <button type="button" onClick={() => { void checkReceipt(hash); }}>Check original transaction</button></p> : null}
    {submissionUnknown && !hash ? <p className="muted">The wallet response is uncertain. Check wallet activity. Clear this only after confirming no transaction was sent.</p> : null}
    {submissionUnknown && !hash ? <button type="button" onClick={() => { setSubmissionUnknown(false); invalidate(); }}>I confirmed no transaction was sent</button> : null}
    <details><summary>Recover an original continuity transaction</summary><label>Original transaction hash<input value={recoveryHash} onChange={(e) => setRecoveryHash(e.target.value)} placeholder="0x…" /></label><button type="button" onClick={() => { if (!/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)) { setError("Enter a valid transaction hash."); return; } setHash(recoveryHash); onObservedHash(recoveryHash); setReceiptState("pending"); try { localStorage.setItem(storageKey, JSON.stringify({ account: account.address, chainId: account.chainId, hash: recoveryHash })); } catch {} void checkReceipt(recoveryHash); }}>Check supplied hash without resending</button><p className="muted">A receipt alone does not prove which family case changed. Link the finalized transaction through the server below.</p></details>
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}

export function ContinuityWorkflowPage() {
  const accounts = useAccounts(); const account = selectedAccount(accounts.data); const cases = useResource<ContinuityCase[]>(account ? "/accounts/" + account.id + "/continuity-cases" : undefined);
  const [type, setType] = useState("recovery"); const [successor, setSuccessor] = useState(""); const [planHash, setPlanHash] = useState(""); const [evidenceHash, setEvidenceHash] = useState(""); const [caseId, setCaseId] = useState(""); const [chainCaseId, setChainCaseId] = useState(""); const [transactionHash, setTransactionHash] = useState(""); const [toState, setToState] = useState("evidence_pending"); const [evidenceRef, setEvidenceRef] = useState(""); const [reviewer, setReviewer] = useState(""); const [reviewSignature, setReviewSignature] = useState(""); const [quorumText, setQuorumText] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  async function createCase() { if (!account) return; try { setError(""); if (!/^0x[0-9a-fA-F]{40}$/.test(successor)) throw Error("A successor is required for every continuity case."); if ((type === "succession" || type === "incapacity") && !/^0x[0-9a-fA-F]{64}$/.test(evidenceHash)) throw Error("A bytes32 evidence hash is required."); if (type === "succession" && !/^0x[0-9a-fA-F]{64}$/.test(planHash)) throw Error("A bytes32 plan hash is required for succession."); await api.post("/accounts/" + account.id + "/continuity-cases", { type, successor, planVersion: account.policyVersion, ...(planHash ? { planHash } : {}), ...(evidenceHash ? { evidenceHash } : {}) }); cases.refresh(); } catch (e) { setError(userFacingError(e)); } }
  async function linkReceipt() { if (!account || !caseId) return; try { setError(""); setMessage(""); await api.post("/accounts/" + account.id + "/continuity-cases/" + caseId + "/link", { chainCaseId, transactionHash }); cases.refresh(); setMessage("Finalized chain request linked to this family case after server verification."); } catch (e) { setError(userFacingError(e)); } }
  async function transition() { if (!account || !caseId) return; try { setError(""); setMessage(""); const selected = cases.data?.find((item) => item.id === caseId); const body: Record<string, unknown> = { toState }; if (evidenceRef.trim()) body.evidenceRef = evidenceRef.trim(); if (toState === "executable" && selected?.type === "succession") { const quorumSignatures = quorumText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [signer, signature, extra] = line.split(/\s+/); if (extra || !signer || !signature) throw Error("Each guardian approval needs an address and signature on one line."); return { signer, signature }; }); body.reviewer = reviewer; body.reviewSignature = reviewSignature; body.quorumSignatures = quorumSignatures; } if (toState === "executed") { body.chainCaseId = chainCaseId; body.transactionHash = transactionHash; } await api.post("/accounts/" + account.id + "/continuity-cases/" + caseId + "/transitions", body); cases.refresh(); setMessage("Workflow record updated. On-chain authority remains separate; executed status requires server-verified receipt proof."); } catch (e) { setError(userFacingError(e)); } }
  return <><PageHeading title="Continuity" description="Recovery, incapacity and succession cases are server state machines." /><ResourceState resource={accounts} />{account ? <><section className="card"><h2>Cases</h2><ResourceState resource={cases} />{cases.data ? <table><thead><tr><th>ID</th><th>Type</th><th>State</th><th>Successor</th></tr></thead><tbody>{cases.data.map((v) => <tr key={v.id}><td className="address">{v.id}</td><td>{v.type}</td><td>{v.state}</td><td className="address">{v.successor ?? "—"}</td></tr>)}</tbody></table> : null}</section><section className="card"><h2>Open case</h2><label>Type<select value={type} onChange={(e) => setType(e.target.value)}><option>recovery</option><option>incapacity</option><option>succession</option></select></label><label>Successor full address<input required value={successor} onChange={(e) => setSuccessor(e.target.value)} /></label>{type === "succession" ? <label>Plan hash<input required value={planHash} onChange={(e) => setPlanHash(e.target.value)} /></label> : null}{type !== "recovery" ? <label>Evidence hash<input required value={evidenceHash} onChange={(e) => setEvidenceHash(e.target.value)} /></label> : null}<button type="button" onClick={createCase}>Create case</button></section><ContinuityChainForm account={account} cases={cases.data ?? []} onObservedHash={setTransactionHash} /><section className="card"><h2>Link finalized chain request</h2><p className="muted">Link the finalized receipt before marking a case executed. Workflow notes and chain authority are recorded separately.</p><label>Family case<select value={caseId} onChange={(e) => { const next = cases.data?.find((item) => item.id === e.target.value); setCaseId(e.target.value); setChainCaseId(next?.chainCaseId ?? ""); }}><option value="">Choose a case</option>{cases.data?.map((item) => <option key={item.id} value={item.id}>{item.type} · {item.state} · {item.id}</option>)}</select></label><label>Chain case ID<input value={chainCaseId} onChange={(e) => setChainCaseId(e.target.value)} /></label><label>Finalized transaction hash<input value={transactionHash} onChange={(e) => setTransactionHash(e.target.value)} /></label><button type="button" onClick={linkReceipt} disabled={!caseId}>Link receipt</button></section></> : null}<section className="card"><h2>Update the family case record</h2><p>This records a review step. It does not execute a wallet action or transfer ownership.</p><label>Family case<select value={caseId} onChange={(e) => { const next = cases.data?.find((item) => item.id === e.target.value); setCaseId(e.target.value); setChainCaseId(next?.chainCaseId ?? ""); }}><option value="">Choose a case</option>{cases.data?.map((item) => <option key={item.id} value={item.id}>{item.type} · {item.state} · {item.id}</option>)}</select></label><label>Next state<select value={toState} onChange={(e) => setToState(e.target.value)}><option>evidence_pending</option><option>under_review</option><option>approved</option><option>challenge_window</option><option>executable</option><option>executed</option><option>challenged</option><option>rejected</option><option>cancelled</option><option>expired</option></select></label><label>Evidence reference, if available<input value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder="Private case-file reference" /></label>{toState === "executable" && cases.data?.find((item) => item.id === caseId)?.type === "succession" ? <><p>A real reviewer signature and two guardian signatures are required. The server checks them and the challenge deadline.</p><label>Enrolled reviewer wallet address<input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="0x…" /></label><label>Reviewer attestation signature<input value={reviewSignature} onChange={(e) => setReviewSignature(e.target.value)} placeholder="0x…" /></label><label>Guardian approvals, one address and signature per line<textarea value={quorumText} onChange={(e) => setQuorumText(e.target.value)} placeholder="0xaddress 0xsignature" /></label></> : null}{toState === "executed" ? <><label>On-chain case number<input value={chainCaseId} onChange={(e) => setChainCaseId(e.target.value)} inputMode="numeric" /></label><label>Finalized execution transaction hash<input value={transactionHash} onChange={(e) => setTransactionHash(e.target.value)} placeholder="0x…" /></label><p className="muted">The server must verify this receipt against the linked case before marking it executed.</p></> : null}<button type="button" onClick={transition} disabled={!caseId}>Update case record</button></section>{message ? <p role="status">{message}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}</>;
}
export function ProductOverview({ mode }: { mode: AppMode }) {

  return <><PageHeading title="Steward" description="A small resource console for care, family authority and continuity." /><section className="card"><h2>Connect to the account API</h2><p>Demo sessions use fake funds on chain 31337. The demo account can be shared and reset; do not enter personal information.</p><div className="actions"><LinkButton href="/start?mode=demo">Start demo session</LinkButton>{mode === "live" ? <LinkButton href="/start?mode=live">Start wallet sign-in</LinkButton> : null}</div></section><section className="card"><h2>Beta and account risks</h2><p>The hosted demo uses fake funds. The Robinhood Chain testnet rehearsal uses valueless mock tokens. Steward is not offering real-money trading through this app yet.</p><ul><li>A parent chooses a caregiver's allowed actions, assets, recipients and limits. An allowed caregiver action may execute without the parent signing that individual transaction.</li><li>Changing or revoking on-chain authority requires a transaction. A submitted change is not effective until the chain includes it.</li><li>Blockchain transactions can be irreversible. Prices are estimates, venues can lose liquidity, and Steward's contracts have not been independently audited.</li><li>Succession and incapacity require separate reviewed steps; caregiver access alone does not transfer ownership.</li></ul><p className="muted">The exact network and action risk appears again before each wallet signature. Any future asset availability is decided separately from this explanation.</p></section><div className="grid two"><section className="card"><h2>Five sections</h2><p>Portfolio, Care, Family, Record and Continuity read account-scoped resources.</p></section><section className="card"><h2>Authority</h2><p>App grants are displayed separately from wallet signing power and on-chain policy.</p></section></div></>;
}

export function StartPage({ mode, onSession }: { mode: AppMode; onSession: (account?: AccountSnapshot) => void }) {
  const [status, setStatus] = useState(""); const [error, setError] = useState(""); const [wallet, setWallet] = useState<WalletSession>(); const [passkeySigner, setPasskeySigner] = useState(""); const [passkeyChainId, setPasskeyChainId] = useState(String(DEMO_CHAIN_ID));
  async function demo() { setError(""); setStatus("Starting fake-funds demo…"); try { const result = await api.post<{ mode: "demo"; chainId: number; account?: AccountSnapshot }>("/auth/demo", { chainId: DEMO_CHAIN_ID }); setStatus(`Demo session active on chain ${result.data.chainId}.`); onSession(result.data.account); } catch (e) { setStatus(""); setError(userFacingError(e)); } }
  async function connect() { setError(""); const provider = (window as Window & { ethereum?: import("viem").EIP1193Provider }).ethereum; if (!provider) { setError("No EIP-1193 wallet was found."); return; } try { const result = await connectWallet(provider); const challenge=await api.post<{challengeId:string;message:string}>("/auth/challenges",{address:result.account,chainId:result.chainId}); const signature=await signChallenge(provider,challenge.data.message,result); await api.post("/auth/sessions",{challengeId:challenge.data.challengeId,address:result.account,signature}); setWallet(result); const accounts=await api.get<AccountSnapshot[]>("/accounts");onSession(accounts.data[0]);setStatus("Wallet session authenticated."); if (result.chainId !== DEMO_CHAIN_ID && mode === "demo") setError(`Wrong network. Connect to chain ${DEMO_CHAIN_ID}.`); } catch (e) { setError(userFacingError(e)); } }
  async function passkeyLogin() { setError(""); setStatus("Requesting passkey challenge…"); try { if (!/^0x[0-9a-fA-F]{40}$/.test(passkeySigner)) throw new Error("Enter the deployed ERC-1271 passkey signer address."); const chainId = Number(passkeyChainId); if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Enter a valid chain ID."); const challenge = await api.post<{ challengeId: string; message: string; challengeDigest?: `0x${string}` }>("/auth/webauthn/challenges", { address: passkeySigner, chainId }); const digest = passkeyMessageDigest(challenge.data.message); if (challenge.data.challengeDigest && challenge.data.challengeDigest.toLowerCase() !== digest.toLowerCase()) throw new Error("The server returned a mismatched passkey challenge digest."); let allowCredentials; try { const saved = localStorage.getItem("steward.passkey.credential." + passkeySigner.toLowerCase()); allowCredentials = saved ? [{ id: JSON.parse(saved).id, type: "public-key" as const }] : undefined; } catch { allowCredentials = undefined; } const assertion = await getPasskeyAssertion(digest, passkeySigner as `0x${string}`, { allowCredentials }); const signature = encodePasskeySignature(assertion); await api.post("/auth/webauthn/sessions", { challengeId: challenge.data.challengeId, address: passkeySigner, signature }); const accounts = await api.get<AccountSnapshot[]>("/accounts"); onSession(accounts.data[0]); setStatus("Passkey session authenticated by the server."); } catch (e) { setStatus(""); setError(userFacingError(e)); } }
  return <div className="start-page">
    <a className="start-back" href="/">← Back to Steward</a>
    <div className="start-intro">
      <p className="start-kicker">{mode === "demo" ? "FAKE-FUNDS PRACTICE" : "CONNECTED ACCOUNT"}</p>
      <PageHeading title={mode === "demo" ? "Start with a safe practice run." : "Sign in to your account."} description={mode === "demo" ? "See how Steward works with invented people, assets, and funds." : "Use a wallet or an existing passkey signer to access the account the server recognizes."} />
      <span className="start-mode-chip">{mode === "demo" ? "Demo · chain 31337 · no real assets" : "Connected mode · check the network before signing"}</span>
    </div>
    <div className="start-layout">
      <div className="start-primary">
        <OperationalNotice title={mode === "demo" ? "Demo boundaries" : "Connected sign-in"}>{mode === "demo" ? "The demo uses fake funds and may be shared with other visitors. Do not enter personal information or connect a funded wallet." : "Sign-in requires a connected wallet, a domain-bound challenge and a valid personal signature. A live session does not make any asset route available to you."}</OperationalNotice>
        {status ? <p className="start-feedback start-feedback-ok" role="status">{status}</p> : null}
        {error ? <p className="start-feedback start-feedback-error" role="alert">{error}</p> : null}
        {mode === "demo" ? <section className="card start-choice"><span className="start-step">01 · PRACTICE</span><h2>Open the demo account</h2><p>Use the working app with fake balances. You can explore the five areas without connecting a wallet.</p><button type="button" onClick={demo}>Start demo session <span aria-hidden="true">↗</span></button></section> : <>
          <section className="card start-choice"><span className="start-step">01 · WALLET</span><h2>Connect your wallet</h2><p className="muted">Connecting requests a domain-bound wallet signature to create a server session.</p><button type="button" onClick={connect}>Connect EIP-1193 wallet <span aria-hidden="true">↗</span></button>{wallet ? <p className="start-connected">Connected <span className="address">{wallet.account}</span> on chain {wallet.chainId}.</p> : null}</section>
          <EnrollmentTools wallet={wallet} onSession={onSession} />
          <section className="card start-choice"><span className="start-step">ALTERNATE SIGN-IN</span><h2>Use an existing passkey signer</h2><p className="muted">Use an already deployed ERC-1271 signer. This flow does not register a credential or deploy a signer.</p><label>Signer contract address<input inputMode="text" value={passkeySigner} onChange={(e) => setPasskeySigner(e.target.value)} placeholder="0x…" /></label><label>Chain ID<input inputMode="numeric" value={passkeyChainId} onChange={(e) => setPasskeyChainId(e.target.value)} /></label><button type="button" onClick={passkeyLogin}>Sign in with existing passkey <span aria-hidden="true">↗</span></button></section>
        </>}
      </div>
      <aside className="start-guide" aria-label="Steward setup guide">
        <img src="/brand/steward-mascot.jpg" alt="The orange-capped Steward paper mascot" />
        <div><p className="start-kicker">A CLEAR WAY IN</p><h2>Help has boundaries.</h2><ol><li><strong>The parent owns the account.</strong><span>They set the policy and can change or revoke caregiver authority.</span></li><li><strong>The caregiver gets a defined role.</strong><span>Being family does not automatically grant access.</span></li><li><strong>Continuity has its own checks.</strong><span>An app record alone never transfers account control.</span></li></ol></div>
        <div className="start-requirements"><h3>Before any real-value use</h3><ul><li>Confirm custody, provider rights and network.</li><li>Configure policy, recipients and independent signers.</li><li>Review continuity requirements.</li><li>Sign only server-prepared transactions.</li></ul></div>
      </aside>
    </div>
  </div>;
}

export function PortfolioPage({ mode }: { mode: AppMode }) {
  const accounts = useAccounts(); const account = selectedAccount(accounts.data); const assets = useResource<Array<AssetDescriptor & { balanceRaw?: string; observedBlock?: string; observedAt?: string }>>(account ? `/accounts/${account.id}/assets` : undefined); const valuation = useResource<{ currency: string; decimals: number; status: "complete" | "partial" | "unavailable"; totalValueRaw: string | null; pricedSubtotalRaw?: string; observedBlock?: string; observedAt?: string }>(account && mode === "live" ? `/accounts/${account.id}/valuation` : undefined);
  const settlement = settlementAsset(assets.data);
  return <><PageHeading title="Portfolio" description="Settlement balance, reserve and token holdings from the authorized snapshot." /><ResourceState resource={accounts} empty="No authorized accounts are associated with this session." />{account ? <><AccountIdentity account={account} /><AccountControls account={account} settlement={settlement} /><section className="card"><h2>Settlement balance</h2>{settlement ? <><p className="money"><MoneyAmount raw={account.totalValueRaw} decimals={settlement.decimals} symbol={settlement.symbol} /></p><p>Reserved in the account: <MoneyAmount raw={account.settlementReserveRaw} decimals={settlement.decimals} symbol={settlement.symbol} /></p></> : <p className="muted">Balance amount is unavailable until settlement token metadata loads.</p>}<p className="muted">This is the settlement-token balance, not a combined portfolio valuation. Snapshot block {account.snapshotBlock}; freshness {account.indexFreshness}. A missing account is not shown as a zero balance.</p></section><section className="card"><h2>Reviewed valuation</h2>{mode !== "live" ? <p className="muted">Reviewed valuation unavailable.</p> : valuation.loading ? <p role="status">Loading reviewed valuation…</p> : valuation.error || valuation.data?.status === "unavailable" ? <p className="muted">Reviewed valuation unavailable.</p> : valuation.data ? <><p className="money">{valuation.data.totalValueRaw === null ? "—" : <MoneyAmount raw={valuation.data.totalValueRaw} decimals={valuation.data.decimals} symbol={valuation.data.currency} />}</p><p className="muted">Status: {valuation.data.status}. Scope: policy-and-observed-assets/latest. Observed block {valuation.data.observedBlock ?? "—"}.</p></> : <p className="muted">Reviewed valuation unavailable.</p>}</section><section className="card"><h2>Holdings</h2><p><LinkButton href="/portfolio/assets/new">Buy or sell admitted assets</LinkButton></p><ResourceState resource={assets} />{assets.data ? <table><thead><tr><th>Asset</th><th>Provider</th><th>Balance</th><th>Admission</th></tr></thead><tbody>{assets.data.map((asset) => <tr key={asset.id}><td>{asset.name}<br /><span className="address">{asset.address}</span></td><td>{asset.provider}</td><td>{asset.balanceRaw ? <MoneyAmount raw={asset.balanceRaw} decimals={asset.decimals} symbol={asset.symbol} /> : "No balance snapshot"}</td><td>{asset.admission}{asset.admissionReason ? <small>{asset.admissionReason}</small> : null}</td></tr>)}</tbody></table> : null}</section></> : null}</>;
}

export function AssetPage({ mode }: { mode: AppMode }) {
  type TradeQuote = { adapter: `0x${string}`; quoteId: string; chainId: number; assetIn: `0x${string}`; assetOut: `0x${string}`; amountInRaw: string; minAmountOutRaw: string; feeRaw: string; priceImpactBps: number; validUntil: string; routeHash: `0x${string}`; status: "available" | "unavailable"; reason?: string };
  type QuotedTrade = { quote: TradeQuote; accountId: string; assetId: string; kind: "BUY" | "SELL"; amountInRaw: string; inputAsset: AssetDescriptor; outputAsset: AssetDescriptor };
  const accounts = useAccounts(); const account = selectedAccount(accounts.data);
  const assets = useResource<AssetDescriptor[]>(account ? `/accounts/${account.id}/assets` : undefined);
  const [asset, setAsset] = useState(""); const [kind, setKind] = useState<"BUY" | "SELL">("BUY"); const [amount, setAmount] = useState("");
  const [quoted, setQuoted] = useState<QuotedTrade>(); const [intent, setIntent] = useState<any>(); const [error, setError] = useState("");
  const quoteVersion = useRef(0);
  const [marketAnswer, setMarketAnswer] = useState<PurchaseLocationAnswer>("");
  const [showProvider, setShowProvider] = useState(false);
  const providerCatalog = useResource<unknown[]>(showProvider ? "/providers/robinhood/assets" : undefined);
  const selectedAsset = assets.data?.find((value) => value.id === asset);
  const settlement = settlementAsset(assets.data);
  const inputAsset = kind === "BUY" ? settlement : selectedAsset;
  const outputAsset = kind === "BUY" ? selectedAsset : settlement;
  const quote = quoted?.quote;
  const sideAvailable = selectedAsset?.admission === "allowed" && selectedAsset.capabilities.includes(kind.toLowerCase() as "buy" | "sell");
  const purchaseNoticeRequired = isRobinhoodStockPurchase(selectedAsset, kind);
  function clearPreparedTrade() { quoteVersion.current++; setQuoted(undefined); setIntent(undefined); setError(""); }
  async function getQuote(e: React.FormEvent) {
    e.preventDefault(); if (!account) return;
    const requestVersion = ++quoteVersion.current;
    setError(""); setQuoted(undefined); setIntent(undefined);
    try {
      if (purchaseNoticeRequired && !locationAnswerDoesNotBlockQuote(marketAnswer)) throw new Error("This purchase cannot proceed without a clear, unrestricted location answer.");
      if (!selectedAsset || selectedAsset.admission !== "allowed") throw new Error("Select an asset admitted for this account.");
      if (!selectedAsset.capabilities.includes(kind.toLowerCase() as "buy" | "sell")) throw new Error("This action is unavailable for the selected asset.");
      if (!inputAsset || !outputAsset) throw new Error("Token metadata is unavailable. Refresh the account before requesting a quote.");
      const amountInRaw = UInt256Schema.parse(parsePositiveAmount(amount, inputAsset.decimals));
      const response = await api.post<TradeQuote>(`/accounts/${account.id}/quotes`, { kind, asset: selectedAsset.address, amountInRaw });
      if (requestVersion !== quoteVersion.current) return;
      if (response.data.status === "available" && (response.data.assetIn.toLowerCase() !== inputAsset.address.toLowerCase() || response.data.assetOut.toLowerCase() !== outputAsset.address.toLowerCase() || response.data.amountInRaw !== amountInRaw)) throw new Error("The quote does not match the selected tokens and amount. Request a new quote.");
      setQuoted({ quote: response.data, accountId: account.id, assetId: selectedAsset.id, kind, amountInRaw, inputAsset, outputAsset });
    } catch (e) { if (requestVersion === quoteVersion.current) setError(userFacingError(e)); }
  }
  async function createTrade() {
    if (!account || !quoted || !quote || quote.status !== "available") return;
    try {
      if (purchaseNoticeRequired && !locationAnswerDoesNotBlockQuote(marketAnswer)) throw new Error("This purchase is unavailable for a restricted or uncertain location.");
      if (!selectedAsset || selectedAsset.admission !== "allowed" || !inputAsset || !outputAsset) throw new Error("Refresh the admitted asset catalog before creating a trade request.");
      if (quoted.accountId !== account.id || quoted.assetId !== selectedAsset.id || quoted.kind !== kind) throw new Error("The trade selection changed; request a new quote.");
      if (quote.amountInRaw !== UInt256Schema.parse(parsePositiveAmount(amount, inputAsset.decimals))) throw new Error("The amount changed; request a new quote.");
      if (quote.assetIn.toLowerCase() !== inputAsset.address.toLowerCase() || quote.assetOut.toLowerCase() !== outputAsset.address.toLowerCase()) throw new Error("The selected tokens changed; request a new quote.");
      if (!quote.adapter || quote.adapter.toLowerCase() === ZERO) throw new Error("Quote has no admitted execution adapter.");
      if (quote.chainId !== account.chainId) throw new Error("Quote chain does not match the account snapshot; request a new quote.");
      const validUntil = Math.floor(new Date(quote.validUntil).getTime() / 1000);
      if (!Number.isSafeInteger(validUntil) || validUntil <= Math.floor(Date.now() / 1000)) throw new Error("Quote is expired; request a new quote.");
      const response = await api.post(`/accounts/${account.id}/intents`, { actionId: randomBytes32(), kind, chainId: quote.chainId, securityEpoch: account.securityEpoch, policyVersion: account.policyVersion, nonce: BigInt(randomBytes32()).toString(), tokenIn: quote.assetIn, tokenOut: quote.assetOut, recipient: account.address, amountInRaw: quote.amountInRaw, minAmountOutRaw: quote.minAmountOutRaw, adapter: quote.adapter, routeHash: quote.routeHash, validAfter: String(Math.floor(Date.now() / 1000) - 1), deadline: String(validUntil), exceptionMask: "0" });
      setIntent(response.data);
    } catch (e) { setError(userFacingError(e)); }
  }
  return <><PageHeading title="Asset action" description="Review an available route and a fresh quote before signing." />
    <section className="card"><h2>Optional provider catalog</h2><p className="muted">The public Stock Token catalog shows published products; it does not make them available to this account.</p><button type="button" onClick={() => setShowProvider(true)}>Load public catalog</button>{showProvider ? <><ResourceState resource={providerCatalog} />{providerCatalog.data ? <details><summary>View provider data</summary><pre className="json-block">{JSON.stringify(providerCatalog.data, null, 2)}</pre></details> : null}</> : null}</section>
    <ResourceState resource={accounts} />{account ? <section className="card"><h2>Request a quote</h2><ResourceState resource={assets} />
      <form onSubmit={getQuote}><label>Asset<select value={asset} onChange={(e) => { setAsset(e.target.value); clearPreparedTrade(); }}><option value="">Choose an asset</option>{assets.data?.filter((value) => value.legalInstrumentType !== "settlement_token").map((value) => <option key={value.id} value={value.id} disabled={value.admission !== "allowed"}>{value.symbol} · {value.name}{value.admission !== "allowed" ? " (unavailable)" : ""}</option>)}</select></label>
        <label>Action<select value={kind} onChange={(e) => { setKind(e.target.value as "BUY" | "SELL"); clearPreparedTrade(); }}><option value="BUY">Buy</option><option value="SELL">Sell</option></select></label>
        {purchaseNoticeRequired ? <RobinhoodPurchaseNotice answer={marketAnswer} onAnswer={(answer) => { setMarketAnswer(answer); clearPreparedTrade(); }} /> : null}
        <label>Amount to {kind === "BUY" ? "spend" : "sell"} {inputAsset?.symbol ?? ""}<input required inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => { setAmount(e.target.value); clearPreparedTrade(); }} placeholder="1.25" /></label>
        {!inputAsset || !outputAsset ? <p className="muted">Both token amounts remain unavailable until the account's token metadata loads.</p> : null}
        {selectedAsset && !sideAvailable ? <p className="muted">{kind === "BUY" ? "Buying" : "Selling"} this asset is unavailable for this account and current market session.</p> : null}
        <button type="submit" disabled={!inputAsset || !outputAsset || !sideAvailable || (purchaseNoticeRequired && !locationAnswerDoesNotBlockQuote(marketAnswer))}>Request quote</button>
      </form>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {quoted ? <section className="card"><h2>Quote {quote!.status === "available" ? "ready for review" : "unavailable"}</h2>{quote!.status === "available" ? <><p>Spend <MoneyAmount raw={quote!.amountInRaw} decimals={quoted.inputAsset.decimals} symbol={quoted.inputAsset.symbol} />. Minimum received: <MoneyAmount raw={quote!.minAmountOutRaw} decimals={quoted.outputAsset.decimals} symbol={quoted.outputAsset.symbol} />.</p><p className="muted">Expires {new Date(quote!.validUntil).toLocaleString()}. The actual trade can still fail if the price or account rules change.</p></> : <p>{quote!.reason ?? "No executable quote is available for this route."}</p>}<details><summary>Technical quote details</summary><pre className="json-block">{JSON.stringify(quote, null, 2)}</pre></details><button type="button" onClick={createTrade} disabled={quote!.status !== "available" || (purchaseNoticeRequired && !locationAnswerDoesNotBlockQuote(marketAnswer))}>Create trade request</button></section> : null}
      {intent ? <IntentActions key={intent.id} account={account} intent={intent} assets={assets.data} onRefresh={() => { void api.get(`/accounts/${account.id}/intents/${intent.id}`).then((response) => setIntent(response.data)); }} /> : null}
    </section> : null}{account && mode === "live" && account.chainId === 31337 ? <LocalCowOrders account={account} /> : null}</>;
}

function AccountActionForm({ account, settlement, recipients, onCreated }: { account: AccountSnapshot; settlement?: AssetDescriptor; recipients: string[]; onCreated: (value: any) => void }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [expiresInMinutes, setExpiresInMinutes] = useState(15);
  const [error, setError] = useState("");
  async function create(e: React.FormEvent) {
    e.preventDefault(); setError("");
    try {
      if (!settlement) throw new Error("Settlement token metadata is unavailable. Refresh the account before creating a payment.");
      if (!recipients.some((allowed) => allowed.toLowerCase() === recipient.toLowerCase())) throw new Error("Choose a recipient approved by the parent.");
      const amountInRaw = UInt256Schema.parse(parsePositiveAmount(amount, settlement.decimals));
      const now = Math.floor(Date.now() / 1000);
      const response = await api.post(`/accounts/${account.id}/intents`, { kind: "PAYMENT", chainId: account.chainId, securityEpoch: account.securityEpoch, policyVersion: account.policyVersion, nonce: BigInt(randomBytes32()).toString(), tokenIn: settlement.address, tokenOut: ZERO, recipient, amountInRaw, minAmountOutRaw: "0", adapter: ZERO, routeHash: `0x${"00".repeat(32)}`, validAfter: String(now - 5), deadline: String(now + expiresInMinutes * 60), exceptionMask: "0" });
      onCreated(response.data);
    } catch (e) { setError(userFacingError(e)); }
  }
  return <form onSubmit={create}>
    {settlement ? <p>Pay from the parent's account in <strong>{settlement.symbol}</strong>.</p> : <p className="muted">Payment is unavailable until settlement token metadata loads.</p>}
    <label>Approved recipient<select required value={recipient} onChange={(e) => setRecipient(e.target.value)}><option value="">Choose a recipient</option>{recipients.map((address) => <option value={address} key={address}>{address}</option>)}</select></label>
    {recipients.length === 0 ? <p className="muted">The parent has not approved a payment recipient yet.</p> : null}
    <label>Amount {settlement?.symbol ?? ""}<input required inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.25" /></label>
    <label>Request expires<select value={expiresInMinutes} onChange={(e) => setExpiresInMinutes(Number(e.target.value))}><option value={15}>In 15 minutes</option><option value={60}>In 1 hour</option></select></label>
    <button type="submit" disabled={!settlement || recipients.length === 0}>Create payment request</button>
    {error ? <p className="error" role="alert">{error}</p> : null}
  </form>;
}

function IntentActions({ account, intent, assets, onRefresh }: { account: AccountSnapshot; intent: any; assets?: AssetDescriptor[]; onRefresh: () => void }) {
  const [signer, setSigner] = useState(""); const [signature, setSignature] = useState(""); const [hash, setHash] = useState(""); const [prepared, setPrepared] = useState<PreparedTransaction>(); const [error, setError] = useState("");
  const action = intent.action as ActionIntent | undefined;
  const tokenIn = assets?.find((asset) => asset.address.toLowerCase() === action?.tokenIn.toLowerCase());
  const tokenOut = assets?.find((asset) => asset.address.toLowerCase() === action?.tokenOut.toLowerCase());
  async function approve() { try { setError(""); await api.post(`/accounts/${account.id}/intents/${intent.id}/approvals`, { signer, signature, signatureType: "eoa" }); onRefresh(); } catch (e) { setError(userFacingError(e)); } }
  async function prepare() { try { setError(""); const result = await api.post<PreparedTransaction>(`/accounts/${account.id}/intents/${intent.id}/prepare`, {}); setPrepared(result.data); } catch (e) { setError(userFacingError(e)); } }
  async function walletApprove(){try{const provider=(window as Window&{ethereum?:import("viem").EIP1193Provider}).ethereum;if(!provider)throw Error("Connect a compatible wallet");const session=await connectWallet(provider);if(session.chainId!==account.chainId)throw Error("Wrong wallet chain");const exact=await signAction(provider,intent.action,undefined,session);await api.post(`/accounts/${account.id}/intents/${intent.id}/approvals`,{signer:session.account,signature:exact,signatureType:"eoa"});onRefresh();}catch(e){setError(userFacingError(e));}}
  async function submitWallet(){try{if(!prepared)throw Error("Prepare the action first");const health=await api.get<{mode:string}>("/health/ready");if(health.data.mode!=="live")throw Error("Demo transactions cannot be submitted to a wallet");const provider=(window as Window&{ethereum?:import("viem").EIP1193Provider}).ethereum;if(!provider)throw Error("Connect a compatible wallet");const session=await connectWallet(provider);const submitted=await sendPreparedTransaction(provider,intent.action,prepared,session);setHash(submitted);await api.post(`/accounts/${account.id}/intents/${intent.id}/transactions`,{hash:submitted});onRefresh();}catch(e){setError(`${userFacingError(e)} Check the original transaction status before retrying.`);}}
  async function register() { try { setError(""); await api.post(`/accounts/${account.id}/intents/${intent.id}/transactions`, { hash }); onRefresh(); } catch (e) { setError(userFacingError(e)); } }
  return <section className="card"><h2>Request {intent.id}</h2>
    {action ? <p>{action.kind === "PAYMENT" ? "Pay" : action.kind === "BUY" ? "Buy with" : "Sell"} {tokenIn ? <MoneyAmount raw={action.amountInRaw} decimals={tokenIn.decimals} symbol={tokenIn.symbol} /> : "an amount awaiting token metadata"}{action.kind === "PAYMENT" ? <> to <span className="address">{action.recipient}</span></> : tokenOut ? <> · minimum received <MoneyAmount raw={action.minAmountOutRaw} decimals={tokenOut.decimals} symbol={tokenOut.symbol} /></> : null}. Expires {new Date(Number(action.deadline) * 1000).toLocaleString()}.</p> : <p className="muted">The exact action is not yet available. Refresh this request before signing.</p>}
    <BetaRiskLine chainId={account.chainId} /><div className="actions"><button type="button" onClick={walletApprove} disabled={!action}>Sign exact action with wallet</button><button type="button" onClick={prepare}>Prepare and simulate</button></div>
    {prepared ? <TransactionReview intentSummary="Server-prepared action. Verify this exact payload locally before requesting a wallet transaction." prepared={prepared} /> : null}
    <button type="button" onClick={submitWallet} disabled={!prepared || !action}>Submit reviewed transaction (live only)</button>
    <details><summary>Advanced approval and transaction recovery</summary><p className="muted">Use these fields only to submit a signature or original transaction hash already produced elsewhere. Check the original transaction before retrying.</p><label>Approval signer<input value={signer} onChange={(e) => setSigner(e.target.value)} /></label><label>Exact signature<input value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="0x…" /></label><button type="button" onClick={approve}>Submit exact approval</button><label>Submitted transaction hash<input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" /></label><button type="button" onClick={register} disabled={!hash}>Register original hash / check status</button><details><summary>Exact request data</summary><pre className="json-block">{JSON.stringify(intent, null, 2)}</pre></details></details>
    {error ? <p className="error" role="alert">{error}</p> : null}<TransactionStatus state={intent.state === "submitted" ? "checking_status" : intent.state} intentId={intent.id} txHash={hash || undefined} />
  </section>;
}

export function CarePage() {
  const accounts = useAccounts(); const account = selectedAccount(accounts.data);
  const budget = useResource<BudgetView>(account ? `/accounts/${account.id}/budget` : undefined);
  const assets = useResource<AssetDescriptor[]>(account ? `/accounts/${account.id}/assets` : undefined);
  const policy = useResource<{ approvedRecipients: string[] }>(account ? `/accounts/${account.id}/policy` : undefined);
  const [intent, setIntent] = useState<any>();
  const current = useResource<any>(account && intent ? `/accounts/${account.id}/intents/${intent.id}` : undefined);
  const settlement = settlementAsset(assets.data);
  const budgetView = budget.data && settlement ? { limitRaw: budget.data.limitRaw, spentRaw: budget.data.spentRaw, remainingRaw: budget.data.remainingRaw, unit: settlement.symbol, decimals: settlement.decimals, resetAtUtc: budget.data.resetAt, pendingRequests: budget.data.pendingRequests, buyBudget: budget.data.buyBudget } : undefined;
  return <><PageHeading title="Care" description="Create a payment request within the parent's rules." /><ResourceState resource={accounts} />{account ? <><AccountIdentity account={account} />
    <ResourceState resource={assets} /><ResourceState resource={policy} />
    {budgetView ? <BudgetSummary budget={budgetView} /> : <section className="card"><h2>Spending budget</h2><ResourceState resource={budget} />{budget.data ? <p className="muted">Waiting for settlement token metadata before showing an amount.</p> : null}</section>}
    <section className="card"><h2>Payment request</h2><p className="muted">The account checks recipient, limits and approvals again when the payment executes. Pending requests do not reserve funds.</p><AccountActionForm account={account} settlement={settlement} recipients={policy.data?.approvedRecipients ?? []} onCreated={setIntent} /></section>
    {intent ? <IntentActions key={intent.id} account={account} intent={current.data ?? intent} onRefresh={current.refresh} assets={assets.data} /> : null}
  </> : null}</>;
}

export function FamilyPage() {
  const accounts = useAccounts(); const account = selectedAccount(accounts.data);
  const family = useResource<any>(account ? `/accounts/${account.id}/family` : undefined);
  const [result, setResult] = useState<any>(); const [error, setError] = useState("");
  const [address, setAddress] = useState(""); const [role, setRole] = useState("viewer");
  const [scopes, setScopes] = useState("portfolio.view\nrecord.view"); const [inviteId, setInviteId] = useState(""); const [secret, setSecret] = useState("");
  async function invite() {
    if (!account) return;
    try {
      setError(""); setResult(undefined);
      const response = await api.post(`/accounts/${account.id}/invitations`, { intendedAddress: address, role, scopes: scopes.split(/\s+/).filter(Boolean), expiresInSeconds: 604800 });
      setResult(response.data); family.refresh();
    } catch (e) { setError(userFacingError(e)); }
  }
  async function accept() {
    try { setError(""); setResult(undefined); const response = await api.post(`/invitations/${inviteId}/accept`, { secret }); setResult(response.data); family.refresh(); accounts.refresh(); }
    catch (e) { setError(userFacingError(e)); }
  }
  async function revoke(userId: string) {
    if (!account) return;
    try { setError(""); setResult(undefined); const response = await api.post(`/accounts/${account.id}/grants/${userId}/revoke`, {}); setResult(response.data); family.refresh(); }
    catch (e) { setError(userFacingError(e)); }
  }
  return <><PageHeading title="Family" description="Invite family members to view records or propose care actions." /><ResourceState resource={accounts} />
    {account ? <><section className="card"><h2>Application grants</h2><ResourceState resource={family} />{family.data?.grants ? <table><thead><tr><th>Address</th><th>Role</th><th>Scopes</th><th>State</th><th /></tr></thead><tbody>{family.data.grants.map((grant: any) => <tr key={grant.userId}><td className="address">{grant.address}</td><td>{grant.role}</td><td>{grant.scopes.join(", ")}</td><td>{grant.revoked ? "revoked" : "active"}</td><td>{!grant.revoked ? <button type="button" onClick={() => revoke(grant.userId)}>Revoke app grant</button> : null}</td></tr>)}</tbody></table> : null}<p className="muted">This revokes application access only. It does not revoke on-chain signing authority.</p></section>
      <section className="card"><h2>Create invitation</h2><label>Family member's wallet address<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" /></label><label>Role<select value={role} onChange={(e) => { const nextRole = e.target.value; setRole(nextRole); setScopes(nextRole === "caregiver" ? "portfolio.view\nrecord.view\npayment.propose" : nextRole === "cosigner" ? "portfolio.view\nrecord.view\ncontinuity.view\ncontinuity.start\ncontinuity.review" : "portfolio.view\nrecord.view"); }}><option value="viewer">Viewer</option><option value="caregiver">Caregiver</option><option value="cosigner">Co-signer</option></select></label><label>App permissions, one per line<textarea value={scopes} onChange={(e) => setScopes(e.target.value)} /></label><p className="muted">Permissions control app access. A caregiver needs payment.propose to request payments. A co-signer can access continuity review screens by default, but the contract independently checks whether their wallet is an enrolled guardian, reviewer or successor.</p><button type="button" onClick={invite}>Create invitation</button></section></> : null}
    <section className="card"><h2>Accept invitation</h2><label>Invitation ID<input value={inviteId} onChange={(e) => setInviteId(e.target.value)} /></label><label>Secret shared by the parent<input value={secret} onChange={(e) => setSecret(e.target.value)} /></label><button type="button" onClick={accept}>Accept invitation</button></section>
    {result?.invitationId ? <section className="card" role="status"><h2>Invitation ready to share</h2><p>Share the ID and secret with the intended wallet holder through a private channel. The server returns the secret only when this invitation is created.</p><dl><div><dt>Invitation ID</dt><dd className="address">{result.invitationId}</dd></div><div><dt>Secret</dt><dd className="address">{result.secret}</dd></div><div><dt>Expires</dt><dd>{new Date(result.expiresAt).toLocaleString()}</dd></div></dl></section> : null}
    {result?.accepted ? <p role="status">Invitation accepted. {result.role} app access is active; wallet signing authority remains separate.</p> : null}
    {result?.revoked ? <p role="status">App access revoked. Any on-chain signing authority must be revoked with a separate transaction.</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}<OperationalNotice title="Signing boundary">An app invitation does not grant on-chain signing power. The parent controls that separately with a wallet transaction.</OperationalNotice>{account?.role === "parent" ? <LinkButton href="/policy">Set or revoke caregiver wallet authority</LinkButton> : null}<PermissionSummary capabilities={[]} />
  </>;
}

export function PolicyPage() {
  const accounts = useAccounts(); const account = selectedAccount(accounts.data);
  const [json, setJson] = useState('{"operation":"cancelPolicyExpansion"}');
  const [delegate, setDelegate] = useState("");
  const [permissions, setPermissions] = useState<DelegatePermission[]>(["payment"]);
  const [expiresInDays, setExpiresInDays] = useState<1 | 7 | 30>(7);
  const [limitsAcknowledged, setLimitsAcknowledged] = useState(false);
  const [request, setRequest] = useState<Record<string, unknown>>();
  const [result, setResult] = useState<PreparedCall>();
  const [hash, setHash] = useState("");
  const [receiptState, setReceiptState] = useState<"pending" | "included" | "failed">();
  const [preparing, setPreparing] = useState(false); const [submitting, setSubmitting] = useState(false); const [submissionUnknown, setSubmissionUnknown] = useState(false); const prepareLock = useRef(false); const submitLock = useRef(false);
  const [passkeySigner, setPasskeySigner] = useState("");
  const [error, setError] = useState("");
  const prepareVersion = useRef(0);
  function invalidate() { prepareVersion.current += 1; setRequest(undefined); setResult(undefined); setError(""); }
  useEffect(() => { invalidate(); }, [account?.id]);

  async function prepare(parsed: Record<string, unknown>) {
    if (!account || account.role !== "parent") return;
    if (prepareLock.current || submitLock.current || submissionUnknown) { setError("Check the current wallet request before preparing another authority change."); return; }
    if (hash && receiptState === "pending") { setError("Check the original transaction before preparing another authority change."); return; }
    prepareLock.current = true; setPreparing(true);
    setHash(""); setReceiptState(undefined);
    invalidate(); const version = prepareVersion.current;
    try {
      const expectedData = encodeManagementCall(parsed);
      const response = await api.post<PreparedCall>(`/accounts/${account.id}/policy-changes`, parsed);
      if (version !== prepareVersion.current) return;
      const candidate = response.data;
      const envelope = verifyPreparedCall(candidate, { chainId: account.chainId, to: account.address, data: expectedData, manifestVersions: SUPPORTED_MANIFEST_VERSIONS });
      if (!envelope.ok) throw Error(envelope.reason);
      const calldata = verifyManagementCalldata(parsed, candidate.data);
      if (!calldata.ok) throw Error(calldata.reason);
      setRequest(parsed); setResult(candidate);
    } catch (e) { if (version === prepareVersion.current) setError(userFacingError(e)); }
    finally { prepareLock.current = false; setPreparing(false); }
  }

  async function checkReceipt(originalHash: string, provider: import("viem").EIP1193Provider) {
    try {
      const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [originalHash as `0x${string}`] }) as { status?: string } | null;
      if (!receipt) { setReceiptState("pending"); return; }
      setReceiptState(receipt.status === "0x1" || receipt.status === "0x01" ? "included" : "failed");
      if (receipt.status === "0x1" || receipt.status === "0x01") accounts.refresh();
    } catch (e) { setError(`${userFacingError(e)} Keep the original transaction hash and check it in your wallet.`); }
  }

  async function submitWallet() {
    if (!account || !result || !request || hash || submissionUnknown || prepareLock.current || submitLock.current) return;
    submitLock.current = true; setSubmitting(true);
    let broadcastAttempted = false;
    try {
      setError("");
      const version = prepareVersion.current;
      const expectedData = encodeManagementCall(request);
      const envelope = verifyPreparedCall(result, { chainId: account.chainId, to: account.address, data: expectedData, manifestVersions: SUPPORTED_MANIFEST_VERSIONS });
      if (!envelope.ok) throw Error(envelope.reason);
      const calldata = verifyManagementCalldata(request, result.data);
      if (!calldata.ok) throw Error(calldata.reason);
      const provider = (window as Window & { ethereum?: import("viem").EIP1193Provider }).ethereum;
      if (!provider) throw Error("Connect a compatible wallet");
      const session = await connectWallet(provider);
      if (version !== prepareVersion.current) throw Error("Caregiver request changed; prepare and review it again.");
      if (session.chainId !== account.chainId) throw Error("Wrong wallet chain");
      if (!passkeySigner && session.account.toLowerCase() !== account.parent.toLowerCase()) throw Error("Connect the parent's wallet to change caregiver authority.");
      const expectations = { chainId: account.chainId, to: account.address, data: expectedData, manifestVersions: SUPPORTED_MANIFEST_VERSIONS };
      broadcastAttempted = true;
      const sent = passkeySigner
        ? await sendPreparedCallWithPasskey(provider, result, expectations, passkeySigner as `0x${string}`, session, { allowCredentials: (() => { try { const saved = localStorage.getItem("steward.passkey.credential." + passkeySigner.toLowerCase()); return saved ? [{ id: JSON.parse(saved).id, type: "public-key" as const }] : undefined; } catch { return undefined; } })() })
        : await sendPreparedCall(provider, result, expectations, session);
      setHash(sent); setReceiptState("pending");
      await checkReceipt(sent, provider);
    } catch (e) { if (broadcastAttempted) setSubmissionUnknown(true); setError(`${userFacingError(e)} Check the original transaction status before retrying.`); }
    finally { submitLock.current = false; setSubmitting(false); }
  }

  const canEdit = account?.role === "parent";
  return <><PageHeading title="Caregiver authority" description="The parent grants or revokes wallet authority with a separate on-chain transaction." /><ResourceState resource={accounts} />{account ? <><AccountIdentity account={account} />{canEdit ? <section className="card"><h2>Caregiver wallet access</h2>
    <p>These powers take effect only after the parent's wallet transaction is included on-chain. An app invitation alone cannot authorize a payment or trade.</p>
    <label>Caregiver wallet address<input value={delegate} onChange={(e) => { setDelegate(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    <fieldset><legend>Allowed actions</legend>{(["payment", "buy", "sell"] as const).map((permission) => <label key={permission}><input type="checkbox" checked={permissions.includes(permission)} onChange={(e) => { setPermissions(e.target.checked ? [...permissions, permission] : permissions.filter((item) => item !== permission)); invalidate(); }} />{permission === "payment" ? "Make approved payments" : permission === "buy" ? "Buy approved assets" : "Sell approved assets"}</label>)}</fieldset>
    <label>Access expires after<select value={expiresInDays} onChange={(e) => { setExpiresInDays(Number(e.target.value) as 1 | 7 | 30); invalidate(); }}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select></label>
    <label><input type="checkbox" checked={limitsAcknowledged} onChange={(e) => { setLimitsAcknowledged(e.target.checked); invalidate(); }} />Use the account's existing payment and trade limits. This simple grant adds no separate caregiver amount cap.</label>
    <div className="actions"><button type="button" disabled={receiptState === "pending" || preparing || submitting || submissionUnknown} onClick={() => { try { void prepare(buildDelegateRequest({ delegate, parent: account.parent, permissions, expiresInDays, accountLimitsAcknowledged: limitsAcknowledged, nowSeconds: Math.floor(Date.now() / 1000) })); } catch (e) { setError(userFacingError(e)); } }}>Prepare grant</button><button type="button" disabled={receiptState === "pending" || preparing || submitting || submissionUnknown} onClick={() => { try { void prepare(buildRevokeDelegateRequest(delegate)); } catch (e) { setError(userFacingError(e)); } }}>Prepare revocation</button></div>
    <p className="muted">Revoking the app invitation and revoking wallet authority are separate actions. Use both if the caregiver should lose all access.</p>
    <details><summary>Advanced policy operation</summary><p>For reviewed operations outside the simple caregiver flow, enter the typed request JSON.</p><label>Policy change JSON<textarea rows={10} value={json} onChange={(e) => { setJson(e.target.value); invalidate(); }} /></label><button type="button" disabled={receiptState === "pending" || preparing || submitting || submissionUnknown} onClick={() => { try { void prepare(JSON.parse(json) as Record<string, unknown>); } catch (e) { setError(userFacingError(e)); } }}>Prepare advanced policy change</button></details>
    <label>Optional passkey signer address<input value={passkeySigner} onChange={(e) => { setPasskeySigner(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    {request ? <details><summary>Exact requested operation</summary><pre className="json-block">{JSON.stringify(request, null, 2)}</pre></details> : null}
    {result ? <TransactionReview intentSummary={request?.operation === "setDelegate" ? "Grant selected caregiver powers; the account policy still limits each action." : request?.operation === "revokeDelegate" ? "Revoke this caregiver's on-chain wallet authority." : "Review this exact policy change before signing."} prepared={result as any} /> : null}
    <button type="button" onClick={submitWallet} disabled={!result || !request || Boolean(hash) || preparing || submitting || submissionUnknown}>Submit reviewed policy call</button>
    {hash ? <p role="status">Transaction {hash}: {receiptState === "included" ? "included on-chain; refresh the account before relying on the new authority" : receiptState === "failed" ? "failed on-chain; authority did not change" : "pending; authority has not changed yet"}. <button type="button" onClick={() => { const provider = (window as Window & { ethereum?: import("viem").EIP1193Provider }).ethereum; if (provider) void checkReceipt(hash, provider); }}>Check transaction</button></p> : null}
    {submissionUnknown && !hash ? <p className="muted">The wallet did not confirm whether a transaction was sent. Check wallet activity before trying again. Clear this state only if no transaction was sent.</p> : null}
    {submissionUnknown && !hash ? <button type="button" onClick={() => { setSubmissionUnknown(false); invalidate(); }}>I confirmed no transaction was sent</button> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section> : <p>Only the parent can change on-chain caregiver authority.</p>}</> : null}</>;
}

export function RecordPage() { const accounts = useAccounts(); const account = selectedAccount(accounts.data); const activity = useResource<any[]>(account ? `/accounts/${account.id}/activity` : undefined); const [statement, setStatement] = useState<any>(); const [file, setFile] = useState<File>(); const [attachment, setAttachment] = useState<any>(); const [error, setError] = useState(""); async function exportStatement() { if (!account) return; try { setStatement((await api.get(`/accounts/${account.id}/statements`)).data); } catch (e) { setError(userFacingError(e)); } } async function upload() { if (!account || !file) return; try { const form = new FormData(); form.set("file", file); setAttachment((await api.request(`/accounts/${account.id}/attachments`, { method: "POST", body: form })).data); } catch (e) { setError(userFacingError(e)); } } return <><PageHeading title="Record" description="Account activity, private attachments and exports returned by scoped server authorization." /><ResourceState resource={accounts} />{account ? <section className="card"><h2>Activity</h2><ResourceState resource={activity} />{activity.data ? <table><thead><tr><th>When</th><th>Type</th><th>State</th><th>Summary</th></tr></thead><tbody>{activity.data.map((v) => <tr key={v.id}><td>{v.createdAt}</td><td>{v.kind}</td><td>{v.state}</td><td>{v.summary}<br />{v.transactionHash ? <span className="address">{v.transactionHash}</span> : null}</td></tr>)}</tbody></table> : null}<button type="button" onClick={exportStatement}>Request statement export</button>{statement ? <pre className="json-block">{JSON.stringify(statement, null, 2)}</pre> : null}<h2>Private attachment</h2><label>JPEG, PNG or PDF<input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0])} /></label><button type="button" onClick={upload} disabled={!file}>Upload private attachment</button>{attachment ? <pre className="json-block">{JSON.stringify(attachment, null, 2)}</pre> : null}<PrivateAttachment permission="Server document grant" state={attachment?.state === "ready" ? "ready" : attachment ? "blocked" : "none"} />{error ? <p className="error" role="alert">{error}</p> : null}</section> : null}</>;
}

export function SettingsPage() { const session = useResource<{ address: string; expiresAt: string }>("/auth/sessions/current"); const [message, setMessage] = useState(""); const [error, setError] = useState(""); async function revoke() { try { await api.request("/auth/sessions/current", { method: "DELETE" }); setMessage("Session revoked."); } catch (e) { setError(userFacingError(e)); } } return <><PageHeading title="Settings" description="Session access and operational account context." /><ResourceState resource={session} />{session.data ? <section className="card"><h2>Current session</h2><p className="address">{session.data.address}</p><p>Expires {session.data.expiresAt}</p><button type="button" onClick={revoke}>Revoke current session</button></section> : null}{message ? <p role="status">{message}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}<section className="card"><h2>Access kit</h2><p>Load and download the authorized account access kit from the Portfolio account controls.</p><LinkButton href="/portfolio">Open Portfolio</LinkButton></section></>;
}

export function InvitePage() { const inviteId = location.pathname.split("/").pop() ?? ""; const [secret, setSecret] = useState(""); const [result, setResult] = useState<any>(); const [error, setError] = useState(""); async function accept() { try { setError(""); setResult((await api.post(`/invitations/${inviteId}/accept`, { secret })).data); } catch (e) { setError(userFacingError(e)); } } return <><PageHeading title="Invitation" description="Redeem an invitation after authentication. The secret is exchanged separately from this URL." /><section className="card"><p>Invitation ID: <span className="address">{inviteId}</span></p><label>Invitation secret<input value={secret} onChange={(e) => setSecret(e.target.value)} /></label><button type="button" onClick={accept}>Accept invitation</button>{result ? <pre className="json-block">{JSON.stringify(result, null, 2)}</pre> : null}{error ? <p className="error" role="alert">{error}</p> : null}</section></> }
