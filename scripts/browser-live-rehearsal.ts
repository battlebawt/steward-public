/**
 * Local browser acceptance only. Starts an ephemeral Anvil chain, deploys the
 * reviewed contracts, and drives the real live-mode web UI with a browser
 * injected EIP-1193 provider backed by an ephemeral Anvil-only key.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createRuntime } from "../server/src/index";
import { ACTION_TYPES, actionDomain, actionMessage, contractCowOrder, type ActionIntent, type CowOrderInput } from "@steward/shared";
import {expectedV2ShellRuntimeCodeHash} from "@steward/shared";

const root = process.cwd();
const dataDir = join(root, "data");
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const dbPath = join(dataDir, `browser-live-rehearsal-${stamp}.sqlite`);
const manifestPath = join(dataDir, `browser-live-rehearsal-${stamp}.json`);
const anvilPort = 28000 + Math.floor(Math.random() * 10000);
const apiPort = 38000 + Math.floor(Math.random() * 10000);
const webPort = 48000 + Math.floor(Math.random() * 10000);
const chainUrl = `http://127.0.0.1:${anvilPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;
const ZERO = `0x${"00".repeat(20)}` as Address;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

const artifact = async (name: string) => Bun.file(join(root, `contracts/out/${name.startsWith('V2Fixture')?'StewardV2CowIntegration.t.sol':`${name}.sol`}/${name}.json`)).json() as Promise<{ abi: readonly unknown[]; bytecode: { object: Hex } }>;
const v2Mode=process.argv.includes('--v2');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rpc(method: string, params: unknown[] = []) {
  const response = await fetch(chainUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result;
}

async function waitFor(url: string, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* process is still starting */ }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function mined(client: ReturnType<typeof createPublicClient>, hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert(receipt.status === "success", `transaction reverted: ${hash}`);
  return receipt;
}

async function mineFinality() {
  await rpc("anvil_mine", ["0x40", "0x0"]);
}

async function deploy(
  client: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  name: string,
  args: unknown[],
) {
  const contract = await artifact(name);
  const hash = await wallet.deployContract({ abi: contract.abi as never, bytecode: contract.bytecode.object, args });
  const receipt = await mined(client, hash);
  assert(receipt.contractAddress, `${name} deployment had no address`);
  return { abi: contract.abi, address: receipt.contractAddress };
}

function responseFor(page: Page, method: string, path: string) {
  const pending = page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === path, { timeout: 30_000 });
  void pending.catch(() => {});
  return pending;
}

async function expectStatus(responsePromise: Promise<Response>, label: string) {
  const response = await responsePromise;
  assert(response.status() >= 200 && response.status() < 300, `${label} failed with HTTP ${response.status()}: ${await response.text()}`);
  return response;
}

async function installVirtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const created = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  }) as { authenticatorId: string };
  return { cdp, authenticatorId: created.authenticatorId };
}

async function run() {
  await mkdir(dataDir, { recursive: true });
  const anvil = Bun.spawn(["anvil", "--host", "127.0.0.1", "--port", String(anvilPort), "--chain-id", "31337", "--timestamp", String(Math.floor(Date.now() / 1000)), "--silent"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const parent = privateKeyToAccount(generatePrivateKey());
  const caregiver = privateKeyToAccount(generatePrivateKey());
  const exceptionWallets = Array.from({ length: 2 }, () => privateKeyToAccount(generatePrivateKey()));
  const exceptionSigners = exceptionWallets.map(wallet => wallet.address);
  const guardians = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()).address);
  const sponsor = createWalletClient({ account: parent, chain: foundry, transport: http(chainUrl) });
  const client = createPublicClient({ chain: foundry, transport: http(chainUrl) });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let apiServer: ReturnType<typeof Bun.serve> | undefined;
  let web: ReturnType<typeof Bun.spawn> | undefined;
  let browser: Browser | undefined;
  let authenticator: Awaited<ReturnType<typeof installVirtualAuthenticator>> | undefined;
  let checks = 0;
  let walletSends = 0;
  let typedSignatures = 0;
  let activeWallet = parent;
  const check = (condition: unknown, message: string): asserts condition => { assert(condition, message); checks += 1; };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (anvil.exitCode !== null) throw new Error(`Anvil exited ${anvil.exitCode}`);
        if (await client.getChainId() === 31337) { ready = true; break; }
      } catch { /* process is still starting */ }
      await Bun.sleep(100);
    }
    check(ready, "local Anvil did not start");
    await rpc("anvil_setBalance", [parent.address, "0x3635c9adc5dea00000"]);

    const token = await deploy(client, sponsor, "MockStewardToken", ["Rehearsal settlement", "RUSD", 6]);
    const tokenCode = await client.getCode({ address: token.address });
    assert(tokenCode, "settlement token code is missing");
    const factory = await deploy(client, sponsor, "StewardFactoryV1", []);
    const implementation = await client.readContract({ address: factory.address, abi: factory.abi as never, functionName: "implementation" }) as Address;
    const factoryCode = await client.getCode({ address: factory.address });
    const implementationCode = await client.getCode({ address: implementation });
    assert(factoryCode && implementationCode, "deployed factory code is missing");
    let factoryV2:Record<string,unknown>|undefined;
    if(v2Mode){
      const stock=await deploy(client,sponsor,'MockStewardToken',['Local mock stock','MSTK',6]);
      const cowSettlement=await deploy(client,sponsor,'V2FixtureSettlement',[]);
      const guard=await deploy(client,sponsor,'V2FixtureGuard',[]);
      const module=await deploy(client,sponsor,'StewardCowV2Module',[cowSettlement.address,stock.address,guard.address,500n]);
      const v2Factory=await deploy(client,sponsor,'StewardFactoryV2Prototype',[module.address]);
      const v1Implementation=await client.readContract({address:v2Factory.address,abi:v2Factory.abi as never,functionName:'v1Implementation'}) as Address;
      const relayer=await client.readContract({address:module.address,abi:module.abi as never,functionName:'relayer'}) as Address;
      check(await client.readContract({address:v2Factory.address,abi:v2Factory.abi as never,functionName:'accountCount'})===0n,'V2 family factory was not fresh');
      const runtimeHash=expectedV2ShellRuntimeCodeHash(v1Implementation,module.address);
      const codeHash=async(address:Address)=>{const code=await client.getCode({address});assert(code,`missing V2 component code ${address}`);return keccak256(code);};
      factoryV2={address:v2Factory.address,runtimeCodeHash:await codeHash(v2Factory.address),accountRuntimeCodeHash:runtimeHash,v1Implementation,v1ImplementationCodeHash:await codeHash(v1Implementation),cowModule:module.address,cowModuleCodeHash:await codeHash(module.address),settlement:cowSettlement.address,settlementCodeHash:await codeHash(cowSettlement.address),stockToken:stock.address,stockTokenCodeHash:await codeHash(stock.address),priceGuard:guard.address,priceGuardCodeHash:await codeHash(guard.address),relayer,relayerCodeHash:await codeHash(relayer),maxFeeBps:'500'};
    }
    await writeFile(manifestPath, JSON.stringify({
      chainId: 31337,
      version: "steward-account-v1",
      accounts: [],
      routes: [],
      enrollmentTokens: [{ address: token.address, runtimeCodeHash: keccak256(tokenCode), symbol: "RUSD", name: "Rehearsal settlement", decimals: 6, provider: "fixture", sourceTermsVersion: "fixture" }],
      factory: { address: factory.address, runtimeCodeHash: keccak256(factoryCode), implementation, implementationCodeHash: keccak256(implementationCode) },
      factoryV2,
    }));

    runtime = await createRuntime({
      STEWARD_MODE: "live",
      ORIGIN: webUrl,
      DATABASE_PATH: dbPath,
      STEWARD_MANIFEST_PATH: manifestPath,
      STEWARD_RPC_URL: chainUrl,
      STEWARD_SERVICE_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      NODE_ENV: "development",
    });
    apiServer = Bun.serve({ fetch: runtime.app.fetch, hostname: "127.0.0.1", port: apiPort });
    web = Bun.spawn(["bun", "run", "--cwd", "web", "dev", "--host", "127.0.0.1"], { cwd: root, env: { ...process.env, STEWARD_WEB_PORT: String(webPort), STEWARD_API_ORIGIN: apiUrl }, stdout: "pipe", stderr: "pipe" });
    await Promise.all([waitFor(`${apiUrl}/api/v1/health/ready`), waitFor(webUrl)]);

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.exposeFunction("stewardRpc", async (method: string, params: unknown[] = []) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [activeWallet.address];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "net_version") return "31337";
      if (method === "personal_sign") {
        const value = String(params[0] ?? "0x");
        return activeWallet.signMessage({ message: value.startsWith("0x") ? ({ raw: value as Hex }) : value });
      }
      if (method === "eth_signTypedData_v4") {
        const typed = JSON.parse(String(params[1])) as { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
        delete typed.types.EIP712Domain;
        typedSignatures += 1;
        return activeWallet.signTypedData({ domain: typed.domain as never, types: typed.types as never, primaryType: typed.primaryType as never, message: typed.message as never });
      }
      if (method === "eth_sendTransaction") {
        walletSends += 1;
        await Bun.sleep(250);
        const tx = params[0] as { from?: string; to?: Address | null; data?: Hex; value?: string };
        check(tx.from?.toLowerCase() === activeWallet.address.toLowerCase(), "browser wallet submitted from an unexpected account");
        const signer = createWalletClient({ account: activeWallet, chain: foundry, transport: http(chainUrl) });
        const hash = await signer.sendTransaction({ to: tx.to ?? undefined, data: tx.data, value: BigInt(tx.value ?? "0x0") });
        await mineFinality();
        return hash;
      }
      return rpc(method, params);
    });
    await page.addInitScript(() => {
      Object.defineProperty(window, "ethereum", { configurable: false, value: { request: ({ method, params }: { method: string; params?: unknown[] }) => (window as Window & { stewardRpc: (m: string, p?: unknown[]) => Promise<unknown> }).stewardRpc(method, params ?? []) } });
    });
    authenticator = await installVirtualAuthenticator(context, page);
    const signInAs = async (wallet: typeof parent) => {
      activeWallet = wallet;
      await page.goto(`${webUrl}/start?mode=live`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Connect EIP-1193 wallet' }).click();
      await page.getByText('Wallet session authenticated.').waitFor();
    };

    const policy = {
      settlement: token.address,
      period: "86400",
      anchor: "0",
      paymentLimit: "500000000",
      buyLimit: "1000000000",
      reserve: "100000000",
      perPayment: "500000000",
      perBuy: "1000000000",
      perSell: "100000000000000000000",
      exceptionQuorum: "2",
      approvedTokens: [],
      paymentRecipients: [parent.address],
      exceptionSigners,
      guardians,
      approvedAdapters: [],
      sellCapTokens: [],
      sellCaps: [],
      continuityReviewer: exceptionSigners[0],
      continuitySuccessor: guardians[0],
      continuityPlanHash: ZERO_BYTES32,
    };
    await page.goto(`${webUrl}/start?mode=live`, { waitUntil: "networkidle" });
    check(await page.getByRole("heading", { name: "Sign in to your account." }).count() === 1, "live sign-in heading missing");
    check(await page.getByLabel("Settlement token").count() === 1, "guided settlement field is not labelled");
    await page.keyboard.press("Tab");
    check(await page.locator(":focus").count() === 1, "keyboard focus did not land on a control");
    await page.getByRole("button", { name: "Connect EIP-1193 wallet" }).click();
    await page.getByText("Wallet session authenticated.").waitFor();

    if(v2Mode){await page.getByLabel('Account version').selectOption('v2');check(await page.getByText('V2 local CoW account').count()>=1,'V2 account choice missing');}

    await page.getByLabel("Settlement token").selectOption(token.address);
    await page.getByLabel("Daily payment limit").fill("500");
    await page.getByLabel("Maximum each payment").fill("500");
    await page.getByLabel("Daily buy limit").fill("1000");
    await page.getByLabel("Maximum each buy").fill("1000");
    await page.getByLabel("Settlement reserve kept for buys").fill("100");
    if(v2Mode){await page.getByLabel('Local mock stock daily sell limit').fill('100');await page.getByLabel('Maximum each local mock stock sell').fill('100');}
    await page.getByLabel(/Approved payment recipients/).fill(parent.address);
    await page.getByLabel(/Two independent co-signers/).fill(exceptionSigners.join("\n"));
    await page.getByLabel(/Three recovery guardians/).fill(guardians.join("\n"));
    await page.getByLabel("Independent continuity reviewer address").fill(exceptionSigners[0]);
    await page.getByLabel("Named successor wallet address").fill(guardians[0]);
    const prepare = responseFor(page, "POST", "/api/v1/accounts/prepare-deployment");
    await page.getByRole("button", { name: "Prepare parent account" }).click();
    await expectStatus(prepare, "initial deployment preparation");
    await page.getByText(/Account deployment prepared for parent/).waitFor();
    let failRegistrationOnce = true;
    await page.route("**/api/v1/accounts/register-deployment", async (route) => {
      if (failRegistrationOnce) { failRegistrationOnce = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "TRANSIENT", message: "Try registration again", retryable: true } }) }); }
      else await route.continue();
    });
    const firstRegistrationAttempt = responseFor(page, "POST", "/api/v1/accounts/register-deployment");
    await page.getByRole("button", { name: "Submit reviewed account deployment" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    check((await firstRegistrationAttempt).status() === 503, "fixture did not inject the registration failure");
    check(walletSends === 1, "delayed wallet response opened duplicate account deployments");
    await page.getByText(/Original account deployment hash/).waitFor();
    await page.reload({ waitUntil: "networkidle" });
    const register = responseFor(page, "POST", "/api/v1/accounts/register-deployment");
    await page.getByRole("button", { name: "Connect EIP-1193 wallet" }).click();
    const registration = await expectStatus(register, "recovered account registration");
    check(walletSends === 1, "registration recovery broadcast a second deployment");
    const firstAccount = ((await registration.json()) as { data: { address: Address } }).data.address;
    check(/^0x[0-9a-f]{40}$/i.test(firstAccount), "initial account registration did not return an address");
    if(v2Mode){const count=await client.readContract({address:factoryV2!.address as Address,abi:(await artifact('StewardFactoryV2Prototype')).abi as never,functionName:'accountCount'});check(count===1n,'First guided V2 enrollment did not create exactly one account');}
    await page.getByText(/registered from the original finalized factory transaction/).waitFor();

    if(v2Mode){
      const mint=await sponsor.writeContract({address:token.address,abi:token.abi as never,functionName:'mint',args:[firstAccount,500_000_000n] as never});await mined(client,mint);
      await page.goto(`${webUrl}/portfolio/assets/new`,{waitUntil:'networkidle'});
      await page.getByRole('heading',{name:'Local guarded order fixture'}).waitFor();
      await page.getByLabel('Amount to sell (RUSD)').fill('1');
      await page.getByLabel('Minimum to receive (MSTK)').fill('0.95');
      await page.getByRole('button',{name:'Save exact local order'}).click();
      await page.getByRole('heading',{name:'Review BUY order'}).waitFor().catch(async error => { console.error('V2 create UI alerts', await page.locator('[role="alert"]').allTextContents()); throw error; });
      check(await page.getByText(/Exact order digest:/).count()===1,'local V2 order digest missing from review');
      await page.getByRole('button',{name:'Sign exact action'}).click();
      await page.getByText(/Approvals: 0x/).waitFor();
      const openingResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/v2\/orders\/0x[0-9a-f]{64}\/prepare$/i.test(new URL(response.url()).pathname));
      await page.getByRole('button',{name:'Prepare opening'}).click();
      await expectStatus(openingResponse,'local V2 opening preparation');
      await page.getByRole('button',{name:'Send exact local transaction'}).waitFor();
      let failOrderConfirmationOnce=true;
      await page.route('**/v2/orders/**/confirm',async route=>{if(failOrderConfirmationOnce){failOrderConfirmationOnce=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TRANSIENT',message:'Check original hash',retryable:true}})});}else await route.continue();});
      const sendsBeforeOrder=walletSends;
      await page.getByRole('button',{name:'Send exact local transaction'}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
      await page.getByText(/Original open transaction: 0x[0-9a-f]{64}/i).waitFor();
      check(walletSends===sendsBeforeOrder+1,`local V2 opening send count was ${walletSends-sendsBeforeOrder}, expected one`);
      await page.reload({waitUntil:'networkidle'});
      await page.getByRole('button',{name:/BUY · 0x/}).click();
      await page.getByText(/Original open transaction: 0x[0-9a-f]{64}/i).waitFor();
      await page.getByRole('button',{name:'Check original transaction'}).click();
      await page.getByText(/State: pending/).waitFor();
      check(walletSends===sendsBeforeOrder+1,'local V2 original-hash recovery resent opening');
      await page.unroute('**/v2/orders/**/confirm');
      await page.getByRole('button',{name:'Prepare cancel'}).click();
      await page.getByRole('button',{name:'Send exact local transaction'}).click();
      await page.getByText(/State: cancelled/).waitFor();
      check(walletSends===sendsBeforeOrder+2,'local V2 cancellation did not send exactly once');
      const stockAddress=factoryV2!.stockToken as Address;
      const stockArtifact=await artifact('MockStewardToken');
      await mined(client,await sponsor.writeContract({address:stockAddress,abi:stockArtifact.abi as never,functionName:'mint',args:[firstAccount,10_000_000n] as never}));
      await page.getByLabel('Side').selectOption('SELL');
      await page.getByLabel('Amount to sell (MSTK)').fill('1');
      await page.getByLabel('Minimum to receive (RUSD)').fill('0.95');
      await page.getByRole('button',{name:'Save exact local order'}).click();
      await page.getByRole('heading',{name:'Review SELL order'}).waitFor();
      const sellDigest=(await page.getByText(/Exact order digest:/).innerText()).match(/0x[0-9a-f]{64}/i)?.[0] as Hex|undefined;
      check(Boolean(sellDigest),'local sell order digest missing');
      await page.getByRole('button',{name:'Sign exact action'}).click();
      await page.getByText(/Approvals: 0x/).waitFor();
      await page.getByRole('button',{name:'Prepare opening'}).click();
      await page.getByRole('button',{name:'Send exact local transaction'}).waitFor();
      await page.getByRole('button',{name:'Send exact local transaction'}).click();
      await page.getByText(/State: pending/).waitFor();
      const savedSell=runtime.db.query('SELECT order_json FROM v2_orders WHERE digest=?').get(sellDigest) as {order_json:string}|null;
      check(Boolean(savedSell),'local sell order was not persisted');
      const sellOrder=JSON.parse(savedSell!.order_json) as CowOrderInput;
      const settlementArtifact=await artifact('V2FixtureSettlement');
      await mined(client,await sponsor.writeContract({address:factoryV2!.settlement as Address,abi:settlementArtifact.abi as never,functionName:'fill',args:[firstAccount,contractCowOrder(sellOrder)] as never}));
      await page.getByRole('button',{name:'Refresh order status'}).click();
      await page.getByText(/State: fill_observed/).waitFor();
      await page.getByRole('button',{name:'Prepare reconcile'}).click();
      await page.getByRole('button',{name:'Send exact local transaction'}).click();
      await page.getByText(/State: filled/).waitFor();
      check(true,'local V2 sell fill and reconcile reached the account');

      const accountAbi = (await artifact('StewardAccountV1')).abi;
      const expiry = (await client.getBlock()).timestamp + 3600n;
      await mined(client, await sponsor.writeContract({address:firstAccount,abi:accountAbi as never,functionName:'setDelegate',args:[caregiver.address,6n,expiry,10_000_000n] as never}));
      await rpc('anvil_setBalance',[caregiver.address,'0x3635c9adc5dea00000']);
      const family = runtime.db.query('SELECT id FROM accounts WHERE lower(address)=?').get(firstAccount.toLowerCase()) as {id:string}|null;
      check(Boolean(family),'local V2 account missing from the application database');
      for (const [wallet,role,scopes] of [[caregiver,'caregiver',['portfolio.view','trade.propose']],[exceptionWallets[0]!,'cosigner',['portfolio.view']],[exceptionWallets[1]!,'cosigner',['portfolio.view']]] as const) {
        const userId=crypto.randomUUID(), now=new Date().toISOString();
        runtime.db.query('INSERT INTO users(id,wallet_address,created_at) VALUES(?,?,?)').run(userId,wallet.address.toLowerCase(),now);
        runtime.db.query('INSERT INTO account_grants(id,account_id,user_id,role,scopes_json,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),family!.id,userId,role,JSON.stringify(scopes),now);
      }
      await signInAs(caregiver);
      await page.goto(`${webUrl}/portfolio/assets/new`,{waitUntil:'networkidle'});
      await page.getByRole('heading',{name:'Local guarded order fixture'}).waitFor();
      await page.getByLabel('Side').selectOption('BUY');
      await page.getByLabel('Amount to sell (RUSD)').fill('1');
      await page.getByLabel('Minimum to receive (MSTK)').fill('0.95');
      await page.getByLabel('Exception approval').selectOption('cosigners');
      await page.getByLabel(/Co-signer 1:/).check();
      await page.getByLabel(/Co-signer 2:/).check();
      await page.getByRole('button',{name:'Save exact local order'}).click();
      await page.getByRole('heading',{name:'Review BUY order'}).waitFor();
      const caregiverDigest=(await page.getByText(/Exact order digest:/).innerText()).match(/0x[0-9a-f]{64}/i)?.[0] as Hex|undefined;
      check(Boolean(caregiverDigest),'caregiver exception order digest missing');
      const signaturesBeforeSwitch=typedSignatures;
      let contextRequested!:()=>void, releaseContext!:()=>void;
      const contextStarted=new Promise<void>(resolve=>{contextRequested=resolve});
      const contextGate=new Promise<void>(resolve=>{releaseContext=resolve});
      await page.route('**/v2/orders/context',async route=>{contextRequested();await contextGate;await route.continue().catch(()=>{});});
      await page.getByRole('button',{name:'Sign exact action'}).click();
      await contextStarted;
      await signInAs(parent);
      releaseContext();
      await page.unroute('**/v2/orders/context');
      await Bun.sleep(100);
      check(typedSignatures===signaturesBeforeSwitch,'an old caregiver order requested a signature after the account switched');
      await signInAs(caregiver);
      await page.goto(`${webUrl}/portfolio/assets/new`,{waitUntil:'networkidle'});
      await page.getByRole('button',{name:new RegExp(`BUY · ${caregiverDigest!.slice(0,12)}`)}).click();
      await page.getByRole('button',{name:'Sign exact action'}).click();
      await page.getByText(/Approvals: 0x/).waitFor();
      const insufficient=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/${caregiverDigest}/prepare`));
      await page.getByRole('button',{name:'Prepare opening'}).click();
      check((await insufficient).status()===409,'caregiver exception prepared without independent co-signers');
      for (const signer of exceptionWallets) {
        await signInAs(signer);
        await page.goto(`${webUrl}/portfolio/assets/new`,{waitUntil:'networkidle'});
        await page.getByRole('button',{name:new RegExp(`BUY · ${caregiverDigest!.slice(0,12)}`)}).click();
        const approval=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/${caregiverDigest}/approvals`));
        await page.getByRole('button',{name:'Sign exact action'}).click();
        await expectStatus(approval,'independent co-signer approval');
      }
      await signInAs(caregiver);
      await page.goto(`${webUrl}/portfolio/assets/new`,{waitUntil:'networkidle'});
      await page.getByRole('button',{name:new RegExp(`BUY · ${caregiverDigest!.slice(0,12)}`)}).click();
      const authorized=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/${caregiverDigest}/prepare`));
      await page.getByRole('button',{name:'Prepare opening'}).click();
      await expectStatus(authorized,'caregiver order with exact independent approvals');
      await page.getByRole('button',{name:'Send exact local transaction'}).click();
      await page.getByText(/State: pending/).waitFor();
      await page.waitForFunction(() => { const button=[...document.querySelectorAll('button')].find(v=>v.textContent?.includes('Save exact local order')); return button && !button.disabled; });
      check((runtime.db.query('SELECT COUNT(*) count FROM v2_order_approvals WHERE order_id=(SELECT id FROM v2_orders WHERE digest=?)').get(caregiverDigest) as {count:number}).count===3,'caregiver order did not retain actor and two independent approvals');
      await mined(client,await sponsor.writeContract({address:firstAccount,abi:accountAbi as never,functionName:'revokeDelegate',args:[caregiver.address] as never}));
      const revokedPrepare=await page.evaluate(async ({accountId,digest})=>fetch(`/api/v1/accounts/${accountId}/v2/orders/${digest}/prepare`,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'}).then(response=>response.status),{accountId:family!.id,digest:caregiverDigest});
      check(revokedPrepare===403,'revoked caregiver could prepare another guarded order');
      await signInAs(parent);
      await page.goto(`${webUrl}/portfolio/assets/new`,{waitUntil:'networkidle'});
      await page.getByRole('button',{name:new RegExp(`BUY · ${caregiverDigest!.slice(0,12)}`)}).click();
      const closePreparation=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith(`/${caregiverDigest}/prepare-close`));
      await page.getByRole('button',{name:'Prepare cancel'}).click();
      await expectStatus(closePreparation,'parent close after caregiver revocation');
      const closeRow=runtime.db.query('SELECT close_prepared_data FROM v2_orders WHERE digest=?').get(caregiverDigest) as {close_prepared_data:Hex}|null;
      check(Boolean(closeRow?.close_prepared_data),'exact close calldata was not persisted');
      const firstCloseHash=await sponsor.sendTransaction({to:firstAccount,data:closeRow!.close_prepared_data,gas:500_000n});
      await mined(client,firstCloseHash);
      const revertedCloseHash=await sponsor.sendTransaction({to:firstAccount,data:closeRow!.close_prepared_data,gas:500_000n});
      const revertedReceipt=await client.waitForTransactionReceipt({hash:revertedCloseHash});
      check(revertedReceipt.status==='reverted','duplicate close did not produce an included revert');
      await mineFinality();
      const confirmClose=async(hash:Hex)=>page.evaluate(async ({accountId,digest,hash})=>{const response=await fetch(`/api/v1/accounts/${accountId}/v2/orders/${digest}/confirm`,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'cancel',hash})});return {status:response.status,body:await response.json()};},{accountId:family!.id,digest:caregiverDigest,hash});
      const uncertainClose=await confirmClose(`0x${'55'.repeat(32)}` as Hex);
      check(uncertainClose.status===409,'unknown close hash was accepted');
      const revertedClose=await confirmClose(revertedCloseHash);
      check(revertedClose.status===200&&(revertedClose.body as {data?:{outcome?:string}}).data?.outcome==='reverted','finalized matching reverted close was not classified separately');
      check((runtime.db.query('SELECT close_tx_hash FROM v2_orders WHERE digest=?').get(caregiverDigest) as {close_tx_hash:string|null}).close_tx_hash===null,'reverted close was recorded as successful');
      await page.reload({waitUntil:'networkidle'});
      await page.getByRole('button',{name:new RegExp(`BUY · ${caregiverDigest!.slice(0,12)}`)}).click();
      await page.getByLabel('Original transaction hash').fill(revertedCloseHash);
      await page.getByRole('button',{name:'Check original transaction'}).click();
      await page.getByText(/finalized as reverted/).waitFor();
      const attemptText=await page.locator('p').filter({hasText:'Transaction attempts:'}).textContent();
      check(attemptText?.includes('cancel')&&attemptText.includes('reverted'),`reverted attempt history was not visible after reload: ${attemptText}`);
      const confirmedClose=await confirmClose(firstCloseHash);
      check(confirmedClose.status===200&&(confirmedClose.body as {data?:{outcome?:string}}).data?.outcome==='confirmed','canonical successful close was not recorded after the reverted attempt');
      await signInAs(parent);
    }

    await page.getByRole("button", { name: "Create and deploy passkey signer" }).click();
    await page.getByText(/Passkey signer 0x[0-9a-f]{40} deployed and verified/).waitFor({ timeout: 30_000 });
    const signerText = await page.getByText(/Verified signer:/).innerText();
    const signer = signerText.match(/0x[0-9a-f]{40}/i)?.[0] as Address | undefined;
    check(Boolean(signer), "browser passkey deployment did not expose a signer address");
    const signerAddress = signer!;
    await page.getByLabel("Signer contract address").fill(signerAddress);
    await page.getByLabel("Chain ID").fill("31337");
    await page.getByRole("button", { name: "Sign in with existing passkey" }).click();
    await page.getByText("Passkey session authenticated by the server.").waitFor({timeout:30_000});
    check(true, "browser passkey login authenticated");
    await page.getByText("Advanced policy JSON").click();
    await page.getByLabel("Account policy JSON").fill(JSON.stringify(policy, null, 2));
    const secondPrepare = responseFor(page, "POST", "/api/v1/accounts/prepare-deployment");
    await page.getByRole("button", { name: "Prepare account deployment" }).click();
    await expectStatus(secondPrepare, "passkey-parent deployment preparation");
    const secondRegister = responseFor(page, "POST", "/api/v1/accounts/register-deployment");
    await page.getByRole("button", { name: "Submit reviewed account deployment" }).click();
    const secondRegistration = await expectStatus(secondRegister, "passkey-parent account registration");
    const targetAccount = ((await secondRegistration.json()) as { data: { address: Address } }).data.address;
    check(targetAccount.toLowerCase() !== firstAccount.toLowerCase(), "second enrollment reused the first account");
    await page.getByText(/registered from the original finalized factory transaction/).last().waitFor();

    await page.getByLabel("Discover account address").fill(targetAccount);
    const discovery = responseFor(page, "POST", "/api/v1/accounts/discover");
    await page.getByRole("button", { name: "Discover owner account" }).click();
    const discoveredResponse = await expectStatus(discovery, "owner account discovery");
    const discovered = ((await discoveredResponse.json()) as { data: { address: Address } }).data;
    check(discovered.address.toLowerCase() === targetAccount.toLowerCase(), "owner discovery returned the wrong account");

    await page.goto(`${webUrl}/policy`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Caregiver authority", exact: true }).waitFor();
    const delegateAbi = [{ type: "function", name: "delegates", stateMutability: "view", inputs: [{ name: "delegate", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint256" }, { type: "bool" }] }] as const;
    await page.getByLabel("Caregiver wallet address").fill(caregiver.address);
    await page.getByLabel(/Use the account's existing payment and trade limits/).check();
    await page.getByLabel("Optional passkey signer address").fill(signerAddress);
    await page.getByRole("button", { name: "Prepare grant" }).click();
    await page.getByText(/Grant selected caregiver powers/).waitFor();
    const sendsBeforeGrant = walletSends;
    await page.getByRole("button", { name: "Submit reviewed policy call" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await page.locator("p[role='status']").filter({ hasText: /Transaction 0x[0-9a-f]{64}: included on-chain/i }).waitFor({ timeout: 30_000 });
    check(walletSends === sendsBeforeGrant + 1, "delayed wallet response opened duplicate caregiver grants");
    const granted = await client.readContract({ address: targetAccount, abi: delegateAbi, functionName: "delegates", args: [caregiver.address] });
    check(granted[0] === 1n && granted[1] === 0n && granted[4] === true, "guided caregiver grant did not set only payment authority");
    const accountAbi = (await artifact("StewardAccountV1")).abi;
    await mined(client, await sponsor.writeContract({ address: token.address, abi: token.abi as never, functionName: "mint", args: [targetAccount, 3_000_000n] }));
    const currentVersion = (await client.readContract({ address: targetAccount, abi: accountAbi as never, functionName: "policy" }) as readonly bigint[])[10]!;
    const securityEpoch = await client.readContract({ address: targetAccount, abi: accountAbi as never, functionName: "securityEpoch" }) as bigint;
    const now = (await client.getBlock()).timestamp;
    const payment: ActionIntent = {
      actionId: `0x${"01".repeat(32)}`, kind: "PAYMENT", account: targetAccount, actor: caregiver.address,
      chainId: 31337, securityEpoch: securityEpoch.toString(), policyVersion: currentVersion.toString(), nonce: "1",
      tokenIn: token.address, tokenOut: ZERO, recipient: parent.address, amountInRaw: "1000000", minAmountOutRaw: "0",
      adapter: ZERO, routeHash: ZERO_BYTES32, validAfter: (now - 1n).toString(), deadline: (now + 3600n).toString(), exceptionMask: "0",
    };
    const paymentSignature = await caregiver.signTypedData({ domain: actionDomain(payment), types: ACTION_TYPES, primaryType: "Action", message: actionMessage(payment) });
    const beforePayment = await client.readContract({ address: token.address, abi: token.abi as never, functionName: "balanceOf", args: [parent.address] }) as bigint;
    await mined(client, await sponsor.writeContract({ address: targetAccount, abi: accountAbi as never, functionName: "executePayment", args: [actionMessage(payment), [paymentSignature]] }));
    const afterPayment = await client.readContract({ address: token.address, abi: token.abi as never, functionName: "balanceOf", args: [parent.address] }) as bigint;
    check(afterPayment - beforePayment === 1_000_000n, "granted caregiver payment was not executed within the account limit");
    await page.getByRole("button", { name: "Prepare revocation" }).click();
    await page.getByText(/Revoke this caregiver's on-chain wallet authority/).waitFor();
    await page.getByRole("button", { name: "Submit reviewed policy call" }).click();
    await page.locator("p[role='status']").filter({ hasText: /Transaction 0x[0-9a-f]{64}: included on-chain/i }).waitFor({ timeout: 30_000 });
    const revoked = await client.readContract({ address: targetAccount, abi: delegateAbi, functionName: "delegates", args: [caregiver.address] });
    check(revoked[4] === false, "guided caregiver revocation did not remove wallet authority");
    const revokedVersion = (await client.readContract({ address: targetAccount, abi: accountAbi as never, functionName: "policy" }) as readonly bigint[])[10]!;
    const afterRevoke: ActionIntent = { ...payment, actionId: `0x${"02".repeat(32)}`, nonce: "2", policyVersion: revokedVersion.toString() };
    const revokedSignature = await caregiver.signTypedData({ domain: actionDomain(afterRevoke), types: ACTION_TYPES, primaryType: "Action", message: actionMessage(afterRevoke) });
    let unauthorized = false;
    try { await client.simulateContract({ address: targetAccount, abi: accountAbi as never, account: parent.address, functionName: "executePayment", args: [actionMessage(afterRevoke), [revokedSignature]] }); }
    catch (cause) { unauthorized = cause instanceof BaseError && Boolean(cause.walk((error) => error instanceof ContractFunctionRevertedError && error.data?.errorName === "Unauthorized")); }
    check(unauthorized, "revoked caregiver's new payment did not revert Unauthorized");
    await page.getByText("Advanced policy operation").click();
    await page.getByLabel("Policy change JSON").fill(JSON.stringify({ operation: "pauseDelegatedSpending" }, null, 2));
    await page.getByRole("button", { name: "Prepare advanced policy change" }).click();
    await page.getByText(/Review this exact policy change before signing/).waitFor();
    await page.getByRole("button", { name: "Submit reviewed policy call" }).click();
    await page.locator("p[role='status']").filter({ hasText: /Transaction 0x[0-9a-f]{64}: included on-chain/i }).waitFor({ timeout: 30_000 });
    const paused = await client.readContract({ address: targetAccount, abi: [{ type: "function", name: "delegatedSpendingPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }] as const, functionName: "delegatedSpendingPaused" });
    check(paused === true, "reviewed policy call did not pause delegated spending");

    await page.goto(`${webUrl}/continuity`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Continuity", exact: true }).waitFor();
    await page.getByLabel("Continuity step").selectOption("requestSuccession");
    await page.getByLabel("New parent or successor wallet address").fill(guardians[0]);
    await page.getByLabel("Independent reviewer wallet address").fill(exceptionSigners[0]);
    await page.getByLabel("Existing succession plan hash").fill(`0x${"a".repeat(64)}`);
    await page.getByLabel("Existing evidence hash").fill(`0x${"b".repeat(64)}`);
    await page.getByLabel("Optional passkey signer address").fill(signerAddress);
    await page.getByRole("button", { name: "Prepare continuity step", exact: true }).click();
    await page.getByText(/Reviewed requestSuccession call/).waitFor();
    await page.getByRole("button", { name: "Submit reviewed continuity step" }).click();
    await page.locator("p[role='status']").filter({ hasText: /Observed wallet transaction 0x[0-9a-f]{64}: included on-chain/i }).waitFor({ timeout: 30_000 });
    const succession = await client.readContract({ address: targetAccount, abi: accountAbi as never, functionName: "succession" }) as readonly unknown[];
    check(String(succession[2]).toLowerCase() === guardians[0].toLowerCase() && Number(succession[8]) === 1, "guided succession request did not reach the account contract");
    const sendsBeforeContinuityReload = walletSends;
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("p[role='status']").filter({ hasText: /Observed wallet transaction 0x[0-9a-f]{64}: included on-chain/i }).waitFor({ timeout: 30_000 });
    check(walletSends === sendsBeforeContinuityReload, "continuity reload rebroadcast the original transaction");

    console.log(JSON.stringify({ status: "passed", checks, chainId: 31337, accountVersion:v2Mode?'v2':'v1',scope: `guided enrollment, caregiver payment and revoke, passkey-parent policy and succession request, original-hash recovery${v2Mode?', local V2 buy/cancel and sell/fill/reconcile':''}`, realFunds: false }));
    await authenticator?.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: authenticator.authenticatorId });
    await context.close();
  } finally {
    await browser?.close();
    apiServer?.stop(true);
    await runtime?.close();
    web?.kill();
    anvil.kill();
    await Promise.allSettled([web?.exited, anvil.exited]);
    await rm(dbPath, { force: true });
    await rm(`${dbPath}.demo-key`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(manifestPath, { force: true });
  }
}

if (import.meta.main) run().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
