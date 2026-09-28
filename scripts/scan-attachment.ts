/** Operator command. No provider upload. Install/update ClamAV separately before use. */
import { createDatabase } from '../server/src/db';
import { decodeServiceKey } from '../server/src/crypto';
import { clamAvScanner,scanAttachment } from '../server/src/operations/attachments';
const [database,attachmentId]=process.argv.slice(2);
if(!database||!attachmentId)throw Error('Usage: bun scripts/scan-attachment.ts DATABASE ATTACHMENT_ID');
const key=decodeServiceKey(process.env.STEWARD_SERVICE_KEY,false),db=createDatabase(database);
try{console.log(JSON.stringify(await scanAttachment(db,key,attachmentId,clamAvScanner(process.env.STEWARD_CLAMSCAN_PATH))));}finally{db.close();}
