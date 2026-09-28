/** Disposable container only: downloads official definitions and scans two synthetic fixtures. */
import { Database } from 'bun:sqlite';
import { startScannerDefinitions } from '../server/src/operations/scanner-definitions';
import { clamAvScanner } from '../server/src/operations/attachments';

const db = new Database(':memory:');
const worker = startScannerDefinitions({ db });
try {
  await worker.tick();
  if (worker.state.lastError) throw Error(worker.state.lastError);
  const scanner = clamAvScanner('/app/scripts/clamscan.sh');
  if (!(await scanner(new TextEncoder().encode('disposable clean document'))).clean) throw Error('CLEAN_FIXTURE_REJECTED');
  const eicar = 'X5O!P%@AP[4' + String.fromCharCode(92) + 'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  if (eicar.length !== 68) throw Error('EICAR_FIXTURE_INVALID');
  if ((await scanner(new TextEncoder().encode(eicar))).clean) throw Error('EICAR_FIXTURE_ACCEPTED');
  console.log(JSON.stringify({ status: 'passed', checks: 3, scope: 'signature update, clean fixture, EICAR rejection', hosted: false }));
} finally { await worker.stop(); db.close(); }
