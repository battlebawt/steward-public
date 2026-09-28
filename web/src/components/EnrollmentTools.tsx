import { useEffect, useRef, useState } from "react";
import { expectedV2ShellRuntimeCodeHash, type AccountSnapshot, type AssetDescriptor } from "@steward/shared";
import { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi, type EIP1193Provider } from "viem";
import { createApiClient } from "../lib/api";
import { userFacingError } from "../lib/errors";
import { encodeDeploymentCall } from "../lib/management";
import { buildEnrollmentPolicy } from "../lib/enrollmentPolicy";
import { parseAmount } from "../lib/amounts";
import { parsePendingDeployment, pendingDeploymentKey, type PendingDeployment } from "../lib/deploymentRecovery";
import { createPasskeyCredential, encodePasskeySignerDeployment, extractPasskeyPublicKey, verifyPasskeyDeploymentTemplate, type PasskeyDeploymentTemplate } from "../lib/passkeys";
import { SUPPORTED_MANIFEST_VERSIONS, verifyPreparedCall, type PreparedCall } from "../lib/preparedTx";
import { readWalletSession, sendPreparedCall, type WalletSession } from "../lib/wallet";
import { TransactionReview } from "./Primitives";

const api = createApiClient();
const SIGNER_STORAGE_PREFIX = "steward.passkey.credential.";
const SIGNER_ABI = [
  { type: "function", name: "rpIdHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "origin", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "publicKeyX", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "publicKeyY", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "enrolledEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const FACTORY_IMPLEMENTATION_ABI = [{ type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
type V1Factory = { address: `0x${string}`; runtimeCodeHash: `0x${string}`; implementation: `0x${string}`; implementationCodeHash: `0x${string}` };
type V2Factory = { address: `0x${string}`; runtimeCodeHash: `0x${string}`; accountRuntimeCodeHash: `0x${string}`; v1Implementation: `0x${string}`; v1ImplementationCodeHash: `0x${string}`; cowModule: `0x${string}`; cowModuleCodeHash: `0x${string}`; settlement: `0x${string}`; settlementCodeHash: `0x${string}`; stockToken: `0x${string}`; stockTokenCodeHash: `0x${string}`; priceGuard: `0x${string}`; priceGuardCodeHash: `0x${string}`; relayer: `0x${string}`; relayerCodeHash: `0x${string}`; maxFeeBps: string };
type DeploymentManifest = { chainId: number; version: string; factory: V1Factory | null; factoryV2: V2Factory | null };
const V2_COMPONENT_ABI = parseAbi(["function v1Implementation() view returns(address)","function cowModule() view returns(address)","function accountRuntimeCodeHash() view returns(bytes32)","function accountCount() view returns(uint256)","function settlement() view returns(address)","function stockToken() view returns(address)","function priceGuard() view returns(address)","function relayer() view returns(address)","function maxFeeBps() view returns(uint256)","function deploymentChainId() view returns(uint256)"]);
function factoryFor(manifest: DeploymentManifest, accountVersion: "v1" | "v2") { return accountVersion === "v2" ? manifest.factoryV2 : manifest.factory; }

function provider(): EIP1193Provider {
  const value = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!value) throw new Error("Connect a compatible wallet first.");
  return value;
}
async function rpc(providerValue: EIP1193Provider, method: string, params: unknown[] = []) { return providerValue.request({ method: method as never, params: params as never }); }
async function waitReceipt(providerValue: EIP1193Provider, hash: `0x${string}`) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const receipt = await rpc(providerValue, "eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt as { contractAddress?: `0x${string}`; status?: string; blockNumber?: `0x${string}`; blockHash?: `0x${string}` };
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  throw new Error("Transaction receipt is still pending. Check the original hash before retrying.");
}
async function waitTransaction(providerValue: EIP1193Provider, hash: `0x${string}`) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const transaction = await rpc(providerValue, "eth_getTransactionByHash", [hash]);
    if (transaction) return transaction as { from?: `0x${string}`; to?: `0x${string}` | null; value?: `0x${string}`; input?: `0x${string}` };
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  throw new Error("The signer deployment transaction could not be found. Keep the original hash before retrying.");
}
async function waitFinalized(providerValue: EIP1193Provider, hash: `0x${string}`) {
  const receipt = await waitReceipt(providerValue, hash);
  if (!receipt.blockNumber || !receipt.blockHash) throw new Error("Transaction receipt has no canonical block reference.");
  const includedBlock = await rpc(providerValue, "eth_getBlockByNumber", [receipt.blockNumber, false]) as { hash?: `0x${string}`; number?: `0x${string}` } | null;
  if (!includedBlock || includedBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || includedBlock.number?.toLowerCase() !== receipt.blockNumber.toLowerCase()) throw new Error("Transaction receipt block could not be canonically verified.");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const finalized = await rpc(providerValue, "eth_getBlockByNumber", ["finalized", false]) as { number?: `0x${string}` } | null;
    if (finalized?.number && BigInt(finalized.number) >= BigInt(receipt.blockNumber)) {
      const canonical=await rpc(providerValue,"eth_getBlockByNumber",[receipt.blockNumber,false]) as {hash?:string}|null;
      if(canonical?.hash?.toLowerCase()!==receipt.blockHash.toLowerCase())throw new Error("Transaction was reorganized before finality; check the original hash.");
      return receipt;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  throw new Error("Transaction is included but not finalized yet. Keep the original hash and retry registration later.");
}

async function verifyManifestPins(providerValue: EIP1193Provider, manifest: DeploymentManifest, accountVersion: "v1" | "v2") {
  const selected = factoryFor(manifest, accountVersion);
  if (!selected) throw new Error("No reviewed factory is configured for this account version.");
  const chainId = Number.parseInt(String(await rpc(providerValue, "eth_chainId")), 16);
  if (chainId !== manifest.chainId) throw new Error("Wallet network does not match the reviewed deployment manifest.");
  if (accountVersion === "v2") {
    const factory = selected as V2Factory;
    if(expectedV2ShellRuntimeCodeHash(factory.v1Implementation,factory.cowModule).toLowerCase()!==factory.accountRuntimeCodeHash.toLowerCase())throw new Error("V2 shell identity does not match the reviewed artifact.");
    const pins = [[factory.address,factory.runtimeCodeHash],[factory.v1Implementation,factory.v1ImplementationCodeHash],[factory.cowModule,factory.cowModuleCodeHash],[factory.settlement,factory.settlementCodeHash],[factory.stockToken,factory.stockTokenCodeHash],[factory.priceGuard,factory.priceGuardCodeHash],[factory.relayer,factory.relayerCodeHash]] as const;
    const codes = await Promise.all(pins.map(async ([address, hash]) => { const code = await rpc(providerValue,"eth_getCode",[address,"latest"]) as `0x${string}`; return code && keccak256(code).toLowerCase() === hash.toLowerCase(); }));
    if (codes.some(ok => !ok)) throw new Error("V2 component bytecode does not match the reviewed manifest.");
    const read = async (target: `0x${string}`, name: "v1Implementation" | "cowModule" | "accountRuntimeCodeHash" | "accountCount" | "settlement" | "stockToken" | "priceGuard" | "relayer" | "maxFeeBps" | "deploymentChainId") => {
      const data = encodeFunctionData({abi: V2_COMPONENT_ABI, functionName: name});
      const result = await rpc(providerValue,"eth_call",[{to:target,data},"latest"]) as `0x${string}`;
      return decodeFunctionResult({abi:V2_COMPONENT_ABI,functionName:name,data:result});
    };
    const checks = await Promise.all([
      read(factory.address,"v1Implementation"),read(factory.address,"cowModule"),
      read(factory.cowModule,"settlement"),read(factory.cowModule,"stockToken"),read(factory.cowModule,"priceGuard"),read(factory.cowModule,"relayer"),read(factory.cowModule,"maxFeeBps"),read(factory.cowModule,"deploymentChainId")]);
    const expected = [factory.v1Implementation,factory.cowModule,factory.settlement,factory.stockToken,factory.priceGuard,factory.relayer,factory.maxFeeBps,String(manifest.chainId)];
    if (checks.some((value,index) => String(value).toLowerCase() !== expected[index]!.toLowerCase())) throw new Error("V2 component pointers do not match the reviewed manifest.");
    const [runtime,count]=await Promise.all([read(factory.address,"accountRuntimeCodeHash"),read(factory.address,"accountCount")]);
    if(String(runtime).toLowerCase()!==factory.accountRuntimeCodeHash.toLowerCase()&&(String(runtime).toLowerCase()!==`0x${'00'.repeat(32)}`||count!==0n))throw new Error("V2 shell runtime pin does not match the reviewed manifest.");
    return factory;
  }
  const factory = selected as V1Factory;
  const [factoryCode, implementationCode] = await Promise.all([
    rpc(providerValue, "eth_getCode", [factory.address, "latest"]),
    rpc(providerValue, "eth_getCode", [factory.implementation, "latest"]),
  ]) as [`0x${string}`, `0x${string}`];
  if (keccak256(factoryCode).toLowerCase() !== factory.runtimeCodeHash.toLowerCase()) throw new Error("Factory bytecode does not match the reviewed manifest.");
  if (keccak256(implementationCode).toLowerCase() !== factory.implementationCodeHash.toLowerCase()) throw new Error("Account implementation bytecode does not match the reviewed manifest.");
  const implementationRaw = await rpc(providerValue, "eth_call", [{ to: factory.address, data: encodeFunctionData({ abi: FACTORY_IMPLEMENTATION_ABI, functionName: "implementation", args: [] }) }, "latest"]) as `0x${string}`;
  const implementation = decodeFunctionResult({ abi: FACTORY_IMPLEMENTATION_ABI, functionName: "implementation", data: implementationRaw });
  if (String(implementation).toLowerCase() !== factory.implementation.toLowerCase()) throw new Error("Factory implementation pointer does not match the reviewed manifest.");
  return factory;
}

const DECIMALS_ABI = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
async function verifySettlementMetadata(providerValue: EIP1193Provider, asset: AssetDescriptor) {
  const code = await rpc(providerValue, "eth_getCode", [asset.address, "latest"]) as string;
  if (!code || code === "0x") throw Error("The selected settlement token has no contract code on this network.");
  const raw = await rpc(providerValue, "eth_call", [{ to: asset.address, data: encodeFunctionData({ abi: DECIMALS_ABI, functionName: "decimals", args: [] }) }, "latest"]) as `0x${string}`;
  const decimals = decodeFunctionResult({ abi: DECIMALS_ABI, functionName: "decimals", data: raw });
  if (Number(decimals) !== asset.decimals) throw Error("Settlement token units do not match the on-chain token. Stop and review the catalog.");
}

export function EnrollmentTools({ wallet, onSession }: { wallet?: WalletSession; onSession: (account?: AccountSnapshot) => void }) {
  const [policy, setPolicy] = useState("{}"); const [prepared, setPrepared] = useState<PreparedCall>(); const [deploymentHash, setDeploymentHash] = useState(""); const [discovery, setDiscovery] = useState(""); const [discovered, setDiscovered] = useState<unknown>();
  const [passkey, setPasskey] = useState<PasskeyDeploymentTemplate>(); const [credential, setCredential] = useState<{ signer: string; id: string }>(); const [signerHash, setSignerHash] = useState("");
  const [status, setStatus] = useState(""); const [error, setError] = useState(""); const [parentAddress, setParentAddress] = useState<`0x${string}`>();
  const [reviewedPolicy, setReviewedPolicy] = useState<Record<string, unknown>>();
  const [accountVersion, setAccountVersion] = useState<"v1" | "v2">("v1");
  const [availableVersions, setAvailableVersions] = useState<Array<"v1" | "v2">>([]);
  const [deploymentPending, setDeploymentPending] = useState(false); const [deploymentState, setDeploymentState] = useState<"pending" | "registered" | "reverted">(); const [preparing, setPreparing] = useState(false); const [submitting, setSubmitting] = useState(false); const [submissionUnknown, setSubmissionUnknown] = useState(false); const [recoveryHashInput, setRecoveryHashInput] = useState("");
  const prepareVersion = useRef(0); const prepareLock = useRef(false); const submitLock = useRef(false); const reconcileLock = useRef(false);
  const [assets, setAssets] = useState<AssetDescriptor[]>([]); const [assetAddress, setAssetAddress] = useState("");
  const [paymentLimit, setPaymentLimit] = useState(""); const [perPayment, setPerPayment] = useState(""); const [buyLimit, setBuyLimit] = useState("0"); const [perBuy, setPerBuy] = useState("0"); const [reserve, setReserve] = useState("0");
  const [v2DailySell, setV2DailySell] = useState("0"); const [v2PerSell, setV2PerSell] = useState("0");
  const [paymentRecipients, setPaymentRecipients] = useState(""); const [exceptionSigners, setExceptionSigners] = useState(""); const [guardians, setGuardians] = useState(""); const [continuityReviewer, setContinuityReviewer] = useState(""); const [continuitySuccessor, setContinuitySuccessor] = useState("");
  function invalidate() { prepareVersion.current += 1; setPrepared(undefined); setReviewedPolicy(undefined); setStatus(""); }
  useEffect(() => { invalidate(); }, [wallet?.account, wallet?.chainId]);
  useEffect(() => { let active=true; void api.get<DeploymentManifest>("/deployment-manifest").then(({data})=>{if(!active)return;const versions:Array<"v1"|"v2">=[];if(data.factory)versions.push("v1");if(data.factoryV2)versions.push("v2");setAvailableVersions(versions);if(versions.length===1)setAccountVersion(versions[0]!);}).catch(()=>{});return()=>{active=false;}; }, [wallet?.chainId]);
  useEffect(() => { let active = true; void api.get<AssetDescriptor[]>("/assets").then((response) => { if (!active) return; const candidates = response.data.filter((asset) => asset.chainId === wallet?.chainId && asset.legalInstrumentType === "settlement_token" && asset.capabilities.includes("payment") && asset.admission === "allowed"); setAssets(candidates); setAssetAddress(candidates[0]?.address ?? ""); }).catch((cause) => { if (active) setError(userFacingError(cause)); }); return () => { active = false; }; }, [wallet?.chainId]);
  useEffect(() => {
    if (!wallet) return;
    let active = true;
    void (async () => {
      try {
        const parent = await authenticatedParent();
        const manifest = (await api.get<DeploymentManifest>("/deployment-manifest")).data;
        if (!active) return;
        const raw=localStorage.getItem(pendingDeploymentKey(wallet.chainId,parent));
        const saved=[manifest.factory,manifest.factoryV2].filter((factory):factory is V1Factory|V2Factory=>!!factory).map(factory=>parsePendingDeployment(raw,wallet.chainId,parent,factory.address)).find(Boolean);
        if (saved) { setDeploymentHash(saved.hash); setDeploymentPending(true); setDeploymentState("pending"); void reconcileDeployment(saved); }
      } catch { /* Sign-in or storage may not be ready; manual original-hash recovery remains available. */ }
    })();
    return () => { active = false; };
  }, [wallet?.account, wallet?.chainId]);
  async function authenticatedParent() { const session = (await api.get<{ address: `0x${string}` }>("/auth/sessions/current")).data; if (!/^0x[0-9a-fA-F]{40}$/.test(session.address)) throw new Error("The authenticated parent address is invalid."); return session.address as `0x${string}`; }
  async function reconcileDeployment(hint: PendingDeployment) {
    if (!wallet || reconcileLock.current) return;
    reconcileLock.current = true;
    try {
      setError("");
      const p = provider(); const parent = await authenticatedParent();
      const manifest = (await api.get<DeploymentManifest>("/deployment-manifest")).data;
      const savedVersion=hint.factory.toLowerCase()===manifest.factoryV2?.address.toLowerCase()?"v2":"v1";
      const factory = await verifyManifestPins(p, manifest, savedVersion);
      const original = parsePendingDeployment(JSON.stringify(hint), wallet.chainId, parent, factory.address);
      if (!original || manifest.chainId !== wallet.chainId) throw Error("The saved deployment does not match this parent, network and reviewed factory.");
      setDeploymentHash(original.hash); setDeploymentPending(true); setDeploymentState("pending");
      const transaction = await rpc(p, "eth_getTransactionByHash", [original.hash]) as { to?: string | null; value?: string } | null;
      if (transaction && (transaction.to?.toLowerCase() !== factory.address.toLowerCase() || BigInt(transaction.value ?? "0x0") !== 0n)) throw Error("Original transaction did not target the reviewed factory with zero value.");
      const observed = await rpc(p, "eth_getTransactionReceipt", [original.hash]);
      if (!observed) { setStatus("Original deployment is still pending. Check this hash again before retrying."); return; }
      const receipt = await waitFinalized(p, original.hash);
      if (!receipt.status) throw Error("Original deployment receipt has no status; wait for a valid receipt.");
      if (receipt.status !== "0x1" && receipt.status !== "0x01") {
        try { localStorage.removeItem(pendingDeploymentKey(wallet.chainId, parent)); } catch { /* Manual recovery remains available. */ }
        setDeploymentPending(false); setDeploymentState("reverted"); setStatus("Original deployment reverted on-chain. No account was created."); return;
      }
      const registered = await api.post<{ address: `0x${string}` }>("/accounts/register-deployment", { transactionHash: original.hash });
      const accounts = await api.get<AccountSnapshot[]>("/accounts"); onSession(accounts.data[0]);
      try { localStorage.removeItem(pendingDeploymentKey(wallet.chainId, parent)); } catch { /* Registration is already proven by the server. */ }
      setDeploymentPending(false); setDeploymentState("registered"); setSubmissionUnknown(false);
      setStatus(`Account ${registered.data.address} registered from the original finalized factory transaction.`);
    } catch (cause) { setError(`${userFacingError(cause)} The original transaction hash is preserved; check it again without sending another deployment.`); }
    finally { reconcileLock.current = false; }
  }
  async function recoverFromHash(hashInput = recoveryHashInput) {
    if (!wallet) return;
    try {
      const parent = await authenticatedParent();
      const manifest = (await api.get<DeploymentManifest>("/deployment-manifest")).data;
      const factory=factoryFor(manifest,accountVersion);
      if (!factory) throw Error("No reviewed factory is configured for this account version.");
      const hint = parsePendingDeployment(JSON.stringify({ chainId: wallet.chainId, parent, factory: factory.address, hash: hashInput.trim() }), wallet.chainId, parent, factory.address);
      if (!hint) throw Error("Enter a valid original transaction hash.");
      try { localStorage.setItem(pendingDeploymentKey(wallet.chainId, parent), JSON.stringify(hint)); } catch { /* The supplied hash is still usable in this session. */ }
      await reconcileDeployment(hint);
    } catch (cause) { setError(userFacingError(cause)); }
  }
  async function prepareAccount(parsed: Record<string, unknown>, expectedParent?: string) {
    if (!wallet) return;
    if (deploymentPending || submissionUnknown || submitLock.current || prepareLock.current) { setError("Check the original deployment or wallet request before preparing another."); return; }
    prepareLock.current = true; setPreparing(true);
    setDeploymentHash(""); setDeploymentState(undefined);
    invalidate();
    const version = prepareVersion.current;
    try {
      setError(""); const p = provider(); const parent = await authenticatedParent(); setParentAddress(parent);
      if (expectedParent && expectedParent.toLowerCase() !== parent.toLowerCase()) throw Error("Parent session changed; review the account policy again.");
      const manifest = (await api.get<DeploymentManifest>("/deployment-manifest")).data;
      const factory = await verifyManifestPins(p, manifest, accountVersion);
      const expectedData = encodeDeploymentCall(parent, parsed);
      const response = await api.post<PreparedCall>("/accounts/prepare-deployment", { chainId: wallet.chainId, policy: parsed, accountVersion });
      if (version !== prepareVersion.current) return;
      const candidate = response.data;
      const check = verifyPreparedCall(candidate, { chainId: wallet.chainId, to: factory.address, data: expectedData, manifestVersions: new Set([manifest.version, ...SUPPORTED_MANIFEST_VERSIONS]) });
      if (!check.ok) throw Error(check.reason);
      setReviewedPolicy(parsed); setPrepared(candidate);
      setStatus(`Account deployment prepared for parent ${parent}; wallet sponsor is ${wallet.account}.`);
    } catch (e) { if (version === prepareVersion.current) setError(userFacingError(e)); }
    finally { prepareLock.current = false; setPreparing(false); }
  }
  async function submitAccount() {
    if (!wallet || !prepared || !reviewedPolicy || deploymentPending || submissionUnknown || submitLock.current || prepareLock.current) return;
    submitLock.current = true; setSubmitting(true);
    let broadcastAttempted = false;
    try {
      setError(""); const version = prepareVersion.current; const p = provider(); const parent = await authenticatedParent();
      if (version !== prepareVersion.current) throw Error("Account policy changed; prepare and review it again.");
      if (parentAddress && parentAddress.toLowerCase() !== parent.toLowerCase()) throw new Error("Authenticated parent changed; prepare the deployment again.");
      const expectedData = encodeDeploymentCall(parent, reviewedPolicy);
      const manifest = (await api.get<DeploymentManifest>("/deployment-manifest")).data;
      const factory = await verifyManifestPins(p, manifest, accountVersion);
      const check = verifyPreparedCall(prepared, { chainId: wallet.chainId, to: factory.address, data: expectedData, manifestVersions: new Set([manifest.version, ...SUPPORTED_MANIFEST_VERSIONS]) });
      if (!check.ok) throw Error(check.reason);
      if (version !== prepareVersion.current) throw Error("Account policy changed; prepare and review it again.");
      broadcastAttempted = true;
      const hash = await sendPreparedCall(p, prepared, { chainId: wallet.chainId, to: factory.address, data: expectedData, manifestVersions: new Set([manifest.version, ...SUPPORTED_MANIFEST_VERSIONS]) }, wallet);
      const hint: PendingDeployment = { chainId: wallet.chainId, parent: parent.toLowerCase() as `0x${string}`, factory: factory.address.toLowerCase() as `0x${string}`, hash };
      setDeploymentHash(hash); setDeploymentPending(true); setDeploymentState("pending");
      try { localStorage.setItem(pendingDeploymentKey(wallet.chainId, parent), JSON.stringify(hint)); }
      catch { setError("Local recovery storage is unavailable. Save the original hash shown below."); }
      await reconcileDeployment(hint);
    } catch (e) {
      if (broadcastAttempted && !deploymentHash) setSubmissionUnknown(true);
      setError(`${userFacingError(e)} Check the original deployment in your wallet before retrying.`);
    } finally { submitLock.current = false; setSubmitting(false); }
  }
  async function prepareGuided() {
    if (!wallet) return;
    try {
      const version = prepareVersion.current;
      const asset = assets.find((candidate) => candidate.address === assetAddress);
      if (!asset) throw Error("Choose a known settlement token for this network.");
      const parent = await authenticatedParent();
      if (version !== prepareVersion.current) return;
      await verifySettlementMetadata(provider(), asset);
      if (version !== prepareVersion.current) return;
      let next = buildEnrollmentPolicy({ asset, chainId: wallet.chainId, parent, paymentLimit, perPayment, buyLimit, perBuy, reserve, paymentRecipients, exceptionSigners, guardians, continuityReviewer, continuitySuccessor });
      if (accountVersion === "v2") {
        if (wallet.chainId !== 31337) throw Error("V2 guarded stock orders are restricted to the local fixture.");
        const manifest = (await api.get<DeploymentManifest>("/deployment-manifest")).data;
        const stock = manifest.factoryV2?.stockToken;
        if (!stock) throw Error("No pinned local V2 stock token is configured.");
        await verifyManifestPins(provider(), manifest, "v2");
        const raw = await rpc(provider(), "eth_call", [{ to: stock, data: encodeFunctionData({ abi: DECIMALS_ABI, functionName: "decimals" }) }, "latest"]) as `0x${string}`;
        const decimals = Number(decodeFunctionResult({ abi: DECIMALS_ABI, functionName: "decimals", data: raw }));
        const dailySell = parseAmount(v2DailySell, decimals), perSell = parseAmount(v2PerSell, decimals);
        if (BigInt(perSell) > BigInt(dailySell)) throw Error("Maximum each local sell must fit within the daily sell limit.");
        next = { ...next, approvedTokens: [stock], perSell, sellCapTokens: [stock], sellCaps: [dailySell] };
      }
      await prepareAccount(next, parent);
    } catch (e) { setError(userFacingError(e)); }
  }
  async function createSigner() { if (!wallet) return; try { setError(""); const p = provider(); const before = await readWalletSession(p); if (before.account.toLowerCase() !== wallet.account.toLowerCase() || before.chainId !== wallet.chainId) throw new Error("Wallet account or network changed; reconnect before creating a signer."); const template = (await api.get<PasskeyDeploymentTemplate>("/passkeys/deployment-template")).data; if (template.chainId !== before.chainId || template.origin !== location.origin || template.rpId !== location.hostname) throw new Error("Passkey template origin, relying-party ID, or chain does not match this browser."); const random = new Uint8Array(32); crypto.getRandomValues(random); const created = await createPasskeyCredential({ challenge: btoa(String.fromCharCode(...random)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), rp: { name: "Steward", id: template.rpId }, user: { id: btoa(String.fromCharCode(...new TextEncoder().encode(before.account))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), name: before.account, displayName: "Steward owner" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, timeout: 60_000 }); const key = extractPasskeyPublicKey(created); await verifyPasskeyDeploymentTemplate(template, key); const data = encodePasskeySignerDeployment(template, key); const sendSession = await readWalletSession(p); if (sendSession.account.toLowerCase() !== before.account.toLowerCase() || sendSession.chainId !== before.chainId) throw new Error("Wallet account or network changed before signer deployment."); const hash = await rpc(p, "eth_sendTransaction", [{ from: sendSession.account, data, value: "0x0" }]) as `0x${string}`; setSignerHash(hash); const after = await readWalletSession(p); if (after.account.toLowerCase() !== before.account.toLowerCase() || after.chainId !== before.chainId) throw new Error("Wallet account or network changed after signer submission; inspect the original hash."); const transaction = await waitTransaction(p, hash); if (transaction.from?.toLowerCase() !== before.account.toLowerCase() || transaction.to !== null || transaction.value !== "0x0" || transaction.input?.toLowerCase() !== data.toLowerCase()) throw new Error("Signer deployment transaction provenance did not match the reviewed creation bytecode."); const receipt = await waitFinalized(p, hash); if (receipt.status && receipt.status !== "0x1" && receipt.status !== "0x01") throw new Error("Signer deployment reverted."); const signer = receipt.contractAddress; if (!signer) throw new Error("Signer deployment receipt did not include a contract address."); const code = await rpc(p, "eth_getCode", [signer, "latest"]) as `0x${string}`; if (!code || code === "0x") throw new Error("Signer deployment has no runtime code."); for (const [name, expected] of [["rpIdHash", key.rpIdHash], ["origin", template.origin], ["publicKeyX", key.publicKeyX], ["publicKeyY", key.publicKeyY], ["enrolledEpoch", template.enrolledEpoch]] as const) { const call = encodeFunctionData({ abi: SIGNER_ABI, functionName: name, args: [] }); const raw = await rpc(p, "eth_call", [{ to: signer, data: call }, "latest"]) as `0x${string}`; const actual = decodeFunctionResult({ abi: SIGNER_ABI, functionName: name, data: raw }); if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`Signer getter ${name} did not match the enrolled credential.`); } localStorage.setItem(SIGNER_STORAGE_PREFIX + signer.toLowerCase(), JSON.stringify({ id: created.rawId, createdAt: new Date().toISOString() })); setCredential({ signer, id: created.rawId }); setPasskey(template); setStatus(`Passkey signer ${signer} deployed and verified. Its credential association is stored locally.`); } catch (e) { setError(userFacingError(e)); } }
  async function discover() { try { setError(""); const result = await api.post("/accounts/discover", { address: discovery }); setDiscovered(result.data); } catch (e) { setError(userFacingError(e)); } }
  return <section className="card"><h2>Create a parent account</h2>
    <p>Choose who may receive payments and who can help with exceptions, recovery and succession. These addresses become contract roles; check them with each person before signing. Trading venues and stock assets are admitted separately.</p>
    {availableVersions.length>1?<label>Account version<select value={accountVersion} onChange={(event)=>{setAccountVersion(event.target.value as "v1"|"v2");invalidate();}} disabled={deploymentPending||submitting}><option value="v1">V1 account</option><option value="v2">V2 local CoW account</option></select></label>:null}
    {accountVersion==="v2"?<p className="muted">Local mock/fork rehearsal only. V2 is not a public stock trading route.</p>:null}
    <label>Settlement token<select value={assetAddress} onChange={(e) => { setAssetAddress(e.target.value); invalidate(); }}><option value="">Choose a known token</option>{assets.map((asset) => <option key={asset.address} value={asset.address}>{asset.symbol} · {asset.name} · chain {asset.chainId}</option>)}</select></label>
    {!assets.length ? <p className="muted">No settlement token metadata is available for this network. Account setup cannot safely guess token units.</p> : null}
    <label>Daily payment limit<input value={paymentLimit} onChange={(e) => { setPaymentLimit(e.target.value); invalidate(); }} inputMode="decimal" placeholder="500" /></label>
    <label>Maximum each payment<input value={perPayment} onChange={(e) => { setPerPayment(e.target.value); invalidate(); }} inputMode="decimal" placeholder="50" /></label>
    <label>Daily buy limit<input value={buyLimit} onChange={(e) => { setBuyLimit(e.target.value); invalidate(); }} inputMode="decimal" /></label>
    <label>Maximum each buy<input value={perBuy} onChange={(e) => { setPerBuy(e.target.value); invalidate(); }} inputMode="decimal" /></label>
    <label>Settlement reserve kept for buys<input value={reserve} onChange={(e) => { setReserve(e.target.value); invalidate(); }} inputMode="decimal" /></label>
    {accountVersion === "v2" ? <><label>Local mock stock daily sell limit<input value={v2DailySell} onChange={(e) => { setV2DailySell(e.target.value); invalidate(); }} inputMode="decimal" /></label><label>Maximum each local mock stock sell<input value={v2PerSell} onChange={(e) => { setV2PerSell(e.target.value); invalidate(); }} inputMode="decimal" /></label><p className="muted">These limits use the pinned mock stock token's decimal units. Zero disables selling. This asset is local fixture only.</p></> : null}
    <p className="muted">Amounts use the selected token's units. Buying stays unavailable until a separate asset and venue route is reviewed and approved for this account.</p>
    <label>Approved payment recipients, one wallet address per line<textarea value={paymentRecipients} onChange={(e) => { setPaymentRecipients(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    <label>Two independent co-signers, one address per line<textarea value={exceptionSigners} onChange={(e) => { setExceptionSigners(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    <label>Three recovery guardians, one address per line<textarea value={guardians} onChange={(e) => { setGuardians(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    <label>Independent continuity reviewer address<input value={continuityReviewer} onChange={(e) => { setContinuityReviewer(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    <label>Named successor wallet address<input value={continuitySuccessor} onChange={(e) => { setContinuitySuccessor(e.target.value); invalidate(); }} placeholder="0x…" /></label>
    <p className="muted">The reviewer and successor are fixed at account creation in this contract version. A later succession still requires separate evidence, guardian review, successor acceptance and a challenge window.</p>
    <button type="button" onClick={prepareGuided} disabled={!wallet || !assets.length || deploymentPending || preparing || submitting || submissionUnknown}>Prepare parent account</button>
    <details><summary>Advanced policy JSON</summary><p>For a reviewed custom policy, supply all contract fields. Ordinary setup uses the form above.</p><label>Account policy JSON<textarea rows={7} value={policy} onChange={(e) => { setPolicy(e.target.value); invalidate(); }} /></label><button type="button" onClick={() => { try { void prepareAccount(JSON.parse(policy) as Record<string, unknown>); } catch (e) { setError(userFacingError(e)); } }} disabled={!wallet || deploymentPending || preparing || submitting || submissionUnknown}>Prepare account deployment</button></details>
    {reviewedPolicy ? <details><summary>Exact account policy</summary><pre className="json-block">{JSON.stringify(reviewedPolicy, null, 2)}</pre></details> : null}
    {prepared ? <TransactionReview intentSummary="Reviewed factory deployment. Confirm the exact policy before signing." prepared={prepared as any} /> : null}
    <button type="button" onClick={submitAccount} disabled={!prepared || !reviewedPolicy || deploymentPending || preparing || submitting || submissionUnknown}>Submit reviewed account deployment</button>
    {deploymentHash ? <p role="status">Original account deployment hash: {deploymentHash}. {deploymentState === "registered" ? "Finalized and registered." : deploymentState === "reverted" ? "Reverted on-chain; no account was created." : "Check finality and registration before another attempt."}</p> : null}
    {deploymentPending && wallet ? <button type="button" onClick={() => { void recoverFromHash(deploymentHash); }} disabled={submitting}>Check original deployment</button> : null}
    {submissionUnknown ? <p className="muted">The wallet response did not confirm whether a transaction was sent. Check wallet activity. Enter its hash below if found; clear this state only after confirming no transaction was sent.</p> : null}
    {submissionUnknown ? <button type="button" onClick={() => { setSubmissionUnknown(false); invalidate(); }}>I confirmed no transaction was sent</button> : null}
    <details><summary>Recover an existing deployment</summary><p>Use the original hash if registration failed or browser storage was lost. Steward will check the reviewed factory transaction and will not send another one.</p><label>Original deployment transaction hash<input value={recoveryHashInput} onChange={(e) => setRecoveryHashInput(e.target.value)} placeholder="0x…" /></label><button type="button" onClick={() => { void recoverFromHash(); }} disabled={!wallet || submitting}>Check and register original transaction</button></details>
    <hr /><h2>Optional passkey signer</h2><button type="button" onClick={createSigner} disabled={!wallet}>Create and deploy passkey signer</button>{passkey ? <p>Signer template checked for {passkey.rpId} and {passkey.origin}.</p> : null}{credential ? <p role="status">Verified signer: <span className="address">{credential.signer}</span></p> : null}{signerHash ? <p className="address">Original signer deployment hash: {signerHash}</p> : null}
    <hr /><h2>Find an existing account</h2><label>Discover account address<input value={discovery} onChange={(e) => setDiscovery(e.target.value)} placeholder="0x…" /></label><button type="button" onClick={discover}>Discover owner account</button>{discovered ? <pre className="json-block">{JSON.stringify(discovered, null, 2)}</pre> : null}
    {status ? <p role="status">{status}</p> : null}{error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}
