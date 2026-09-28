import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Response } from 'playwright';
import { createDatabase } from '../server/src/db';
import { DemoChainGateway } from '../server/src/chain';
import { seedDemoDatabase } from '../server/src/demo';
import { extractPasskeyPublicKey } from '../web/src/lib/passkeys';

const root = process.cwd();
const dataDir = join(root, 'data');
const dbPath = join(dataDir, `browser-smoke-${Date.now()}.sqlite`);
const apiPort=24000+Math.floor(Math.random()*10000);
const webPort=apiPort+10000;
const webUrl = `http://localhost:${webPort}`;
const apiUrl = `http://localhost:${apiPort}`;

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function waitFor(url: string, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* process is still starting */ }
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function responseFor(page: Page, method: string, path: string) {
  const pending=page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === path, { timeout: 10_000 });
  void pending.catch(()=>{}); // Preserve the primary UI failure if cleanup closes a pending wait.
  return pending;
}

async function expectResponse(responsePromise: Promise<Response>, label: string) {
  const response = await responsePromise;
  assert(response.status() >= 200 && response.status() < 300, `${label} failed with HTTP ${response.status()}: ${await response.text()}`);
  return response;
}

async function virtualWebAuthnSmoke(context: import('playwright').BrowserContext, page: Page): Promise<boolean> {
  let authenticatorId: string | undefined;
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const virtual = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }) as { authenticatorId: string };
    authenticatorId = virtual.authenticatorId;
    const wire = await page.evaluate(async () => {
      const challenge = new Uint8Array(32).fill(7);
      const userId = new Uint8Array(16).fill(9);
      const created = await navigator.credentials.create({ publicKey: { challenge, rp: { name: 'Steward' }, user: { id: userId, name: 'virtual-owner', displayName: 'Virtual owner' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 10_000 } }) as PublicKeyCredential;
      if (!created || !(created.response instanceof AuthenticatorAttestationResponse)) throw new Error('virtual authenticator did not create an attestation');
      const assertion = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32).fill(8), allowCredentials: [{ id: created.rawId, type: 'public-key' }], userVerification: 'required', timeout: 10_000 } }) as PublicKeyCredential;
      if (!assertion || !(assertion.response instanceof AuthenticatorAssertionResponse)) throw new Error('virtual authenticator did not return an assertion');
      const b64 = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return { rawId: b64(created.rawId), attestationObject: b64(created.response.attestationObject), assertionData: b64(assertion.response.authenticatorData), assertionSignature: b64(assertion.response.signature) };
    });
    const key = extractPasskeyPublicKey(wire);
    assert(/^0x[0-9a-f]{64}$/i.test(key.publicKeyX) && /^0x[0-9a-f]{64}$/i.test(key.publicKeyY), 'virtual authenticator public key extraction failed');
    assert(wire.assertionData.length > 0 && wire.assertionSignature.length > 0, 'virtual authenticator assertion was empty');
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    return true;
  } catch (error) {
    if (authenticatorId) {
      try { const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }); } catch { /* cleanup is best effort */ }
    }
    // Unsupported CDP is a runner limitation; extraction/assertion failures after setup are application failures.
    if(authenticatorId)throw error;
    console.log(`virtual WebAuthn smoke unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function seed() {
  await mkdir(dataDir, { recursive: true });
  const db = createDatabase(dbPath);
  seedDemoDatabase(db, new DemoChainGateway(31337));
  db.close();
}

async function startProcess(command: string[], env: Record<string, string>) {
  return Bun.spawn(command, { cwd: root, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
}

async function run() {
  await seed();
  const server = await startProcess(['bun', 'server/src/index.ts'], { STEWARD_MODE: 'demo', DEMO_MODE: 'true', PORT: String(apiPort), ORIGIN: webUrl, DATABASE_PATH: dbPath });
  const web = await startProcess(['bun', 'run', '--cwd', 'web', 'dev', '--host', '127.0.0.1'], {STEWARD_WEB_PORT:String(webPort),STEWARD_API_ORIGIN:apiUrl});
  let browser: Browser | undefined;
  try {
    await Promise.race([waitFor(`${apiUrl}/api/v1/health/ready`),server.exited.then(code=>{throw new Error(`Owned API process exited ${code}`);})]);
    await Promise.race([waitFor(webUrl),web.exited.then(code=>{throw new Error(`Owned Vite process exited ${code}`);})]);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    let expectedAuthDenial = false;
    page.on('console', (message) => { if (message.type() === 'error' && !expectedAuthDenial) consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`${webUrl}/start?mode=demo`, { waitUntil: 'networkidle' });
    const virtualWebAuthnRan = await virtualWebAuthnSmoke(context, page);
    await page.keyboard.press('Tab');
    assert(await page.locator(':focus').count() === 1, 'keyboard focus did not land on a control');
    const demoResponse = responseFor(page, 'POST', '/api/v1/auth/demo');
    await page.getByRole('button', { name: 'Start demo session' }).click();
    await expectResponse(demoResponse, 'demo session');
    await page.getByText(/Demo session active on chain 31337/).waitFor();

    const accountResponse = responseFor(page, 'GET', '/api/v1/accounts');
    await page.getByRole('navigation', { name: 'Main sections' }).getByRole('link', { name: 'Portfolio',exact:true }).click();
    await expectResponse(accountResponse, 'account list');
    await page.getByText('demo-account').waitFor();
    await page.getByText('0x2000000000000000000000000000000000000002').waitFor();
    await page.getByText('Demo Settlement').waitFor();

    await page.getByRole('link', { name: 'Buy or sell admitted assets' }).click();
    await page.getByLabel('Asset').selectOption('demo-stock');
    await page.getByLabel('Amount to spend USDG').fill('1.25');
    const buyResponse = responseFor(page, 'POST', '/api/v1/accounts/demo-account/quotes');
    await page.getByRole('button', { name: 'Request quote' }).click();
    const buy = await expectResponse(buyResponse, 'buy quote');
    assert(buy.request().postDataJSON().amountInRaw === '1250000', 'buy quote did not use settlement token decimals');
    await page.getByRole('heading', { name: 'Quote ready for review' }).waitFor();
    await page.getByLabel('Action').selectOption('SELL');
    await page.getByLabel('Amount to sell DEMO').fill('2.5');
    const sellResponse = responseFor(page, 'POST', '/api/v1/accounts/demo-account/quotes');
    await page.getByRole('button', { name: 'Request quote' }).click();
    const sell = await expectResponse(sellResponse, 'sell quote');
    assert(sell.request().postDataJSON().amountInRaw === '250000000', 'sell quote did not use asset token decimals');
    await page.getByText('2.5 DEMO').waitFor();

    let releaseQuote!: () => void;
    const heldQuote = new Promise<void>((resolve) => { releaseQuote = resolve; });
    await page.route('**/api/v1/accounts/demo-account/quotes', async (route) => { await heldQuote; await route.continue(); });
    await page.getByLabel('Action').selectOption('BUY');
    await page.getByLabel('Amount to spend USDG').fill('3');
    const staleResponse = responseFor(page, 'POST', '/api/v1/accounts/demo-account/quotes');
    await page.getByRole('button', { name: 'Request quote' }).click();
    await page.getByLabel('Amount to spend USDG').fill('4');
    releaseQuote();
    await expectResponse(staleResponse, 'delayed quote');
    await page.waitForTimeout(50);
    assert(await page.getByRole('heading', { name: 'Quote ready for review' }).count() === 0, 'stale quote was displayed after amount changed');
    await page.unroute('**/api/v1/accounts/demo-account/quotes');

    await page.getByRole('link', { name: 'Care' }).click();
    await page.getByLabel('Approved recipient').selectOption('0x4000000000000000000000000000000000000004');
    await page.getByLabel('Amount USDG').fill('1.25');
    const intentResponse = responseFor(page, 'POST', '/api/v1/accounts/demo-account/intents');
    await page.getByRole('button', { name: 'Create payment request' }).click();
    await expectResponse(intentResponse, 'payment intent');
    await page.getByRole('heading', { name: /^Request / }).waitFor();
    await page.getByText('1.25 USDG').first().waitFor();

    await page.getByRole('navigation', { name: 'Main sections' }).getByRole('link', { name: 'Family' }).click();
    await page.getByLabel("Family member's wallet address").fill('0x3000000000000000000000000000000000000003');
    await page.getByLabel('Role').selectOption('caregiver');
    assert((await page.getByLabel('App permissions, one per line').inputValue()).includes('payment.propose'), 'caregiver invitation omitted payment proposal scope');
    await page.getByLabel('Role').selectOption('cosigner');
    assert((await page.getByLabel('App permissions, one per line').inputValue()).includes('continuity.review'), 'co-signer invitation omitted continuity review scope');
    await page.getByLabel('Role').selectOption('caregiver');
    const invitationResponse = responseFor(page, 'POST', '/api/v1/accounts/demo-account/invitations');
    await page.getByRole('button', { name: 'Create invitation' }).click();
    await expectResponse(invitationResponse, 'family invitation');
    await page.getByRole('heading', { name: 'Invitation ready to share' }).waitFor();

    await page.getByRole('navigation', { name: 'Main sections' }).getByRole('link', { name: 'Record' }).click();
    const activityResponse = responseFor(page, 'GET', '/api/v1/accounts/demo-account/activity');
    await expectResponse(activityResponse, 'activity');
    await page.getByText('intent.created').first().waitFor();

    await page.getByRole('link', { name: 'Continuity' }).click();
    await page.getByLabel('Type').selectOption('recovery');
    await page.getByLabel('Successor full address').fill('0x5000000000000000000000000000000000000005');
    const caseResponse = responseFor(page, 'POST', '/api/v1/accounts/demo-account/continuity-cases');
    await page.getByRole('button', { name: 'Create case' }).click();
    const createdCase = await expectResponse(caseResponse, 'continuity case');
    await page.getByRole('cell', { name: 'requested' }).first().waitFor();
    const caseId = ((await createdCase.json()) as { data: { id: string } }).data.id;
    await page.getByLabel('Family case').last().selectOption(caseId);
    await page.getByLabel('Evidence reference, if available').fill('fixture case note');
    const transitionResponse = responseFor(page, 'POST', `/api/v1/accounts/demo-account/continuity-cases/${caseId}/transitions`);
    await page.getByRole('button', { name: 'Update case record' }).click();
    await expectResponse(transitionResponse, 'continuity review transition');
    await page.getByText(/Workflow record updated/).waitFor();

    await page.getByRole('link', { name: 'Settings' }).click();
    const revokeResponse = responseFor(page, 'DELETE', '/api/v1/auth/sessions/current');
    await page.getByRole('button', { name: 'Revoke current session' }).click();
    await expectResponse(revokeResponse, 'session revoke');
    await page.getByText('Session revoked.').waitFor();

    expectedAuthDenial = true;
    const deniedResponse = responseFor(page, 'GET', '/api/v1/accounts');
    await page.getByRole('navigation', { name: 'Main sections' }).getByRole('link', { name: 'Portfolio',exact:true }).click();
    const denied = await deniedResponse;
    assert(denied.status() === 401, `protected account data was not denied after revoke: ${denied.status()}`);
    await page.getByText('Sign in is required').waitFor();
    expectedAuthDenial = false;

    assert(consoleErrors.length === 0, `browser console errors:\n${consoleErrors.join('\n')}`);
    assert(pageErrors.length === 0, `browser page errors:\n${pageErrors.join('\n')}`);
    console.log(`browser smoke passed: demo session, account snapshot, intent, activity, continuity, revoke, protected denial; virtual WebAuthn ${virtualWebAuthnRan ? 'passed' : 'not run'}`);
    await context.close();
  } finally {
    await browser?.close();
    server.kill(); web.kill();
    await Promise.allSettled([server.exited, web.exited]);
    await rm(dbPath, { force: true });
    await rm(`${dbPath}.demo-key`, {force:true});
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
  }
}

if (import.meta.main) {
  run().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
}
