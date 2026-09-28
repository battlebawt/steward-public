import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteAssetRegistry} from './asset-registry-store';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as const;
test('asset observations survive restart and isolate account and chain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'steward-assets-'));let db=new Database(join(dir,'assets.sqlite'));
 try{const first=sqliteAssetRegistry(db,31337);first.remember(a(1),[a(2),a(3)]);first.remember(a(1),[a(2)]);db.close();db=new Database(join(dir,'assets.sqlite'));
  const second=sqliteAssetRegistry(db,31337);expect(await second.list(a(1))).toEqual([a(2),a(3)]);expect(await second.list(a(4))).toEqual([]);expect(await sqliteAssetRegistry(db,4663).list(a(1))).toEqual([]);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
