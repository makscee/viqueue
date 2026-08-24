import test from 'node:test';
import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadUpstreamAuthorization } from '../src/phone-gateway.js';

const valid='test_upstream_authority_0001';
const make=async(dir,name,value=valid,mode=0o600)=>{const file=path.join(dir,name);await writeFile(file,value,{mode});await chmod(file,mode);return file};
const cli=file=>spawnSync(process.execPath,['src/phone-gateway.js',`--upstream-authorization-file=${file}`],{encoding:'utf8',timeout:5000});
const rejectedCli=(file)=>{const result=cli(file);assert.notEqual(result.status,0);assert.equal(result.signal,null);assert.doesNotMatch(result.stdout+result.stderr,/test_upstream_authority_0001/)};

test('credential loader accepts only a service-owned 0600 regular single-link file',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'viq-credential-ok-'));try{const file=await make(dir,'credential',valid+'\n');assert.equal(await loadUpstreamAuthorization(file),valid)}finally{await rm(dir,{recursive:true,force:true})}});

test('CLI startup rejects missing, empty, directory, FIFO, symlink, unsafe modes, hard links, oversized, multiline, NUL, and malformed credential inputs',async(t)=>{if(fsConstants.O_NOFOLLOW===undefined)return t.skip('O_NOFOLLOW unavailable');const dir=await mkdtemp(path.join(os.tmpdir(),'viq-credential-bad-'));try{
 const missing=path.join(dir,'missing'),empty=await make(dir,'empty',''),directory=path.join(dir,'directory');await (await import('node:fs/promises')).mkdir(directory);
 const fifo=path.join(dir,'fifo');execFileSync('mkfifo',[fifo]);
 const target=await make(dir,'target'),symbolic=path.join(dir,'symbolic');await symlink(target,symbolic);
 const mode640=await make(dir,'mode640',valid,0o640),mode644=await make(dir,'mode644',valid,0o644);
 const linked=await make(dir,'linked'),secondLink=path.join(dir,'linked-again');await link(linked,secondLink);
 const oversized=await make(dir,'oversized','x'.repeat(514)),multiline=await make(dir,'multiline',valid+'\nsecond'),nul=await make(dir,'nul',valid+'\0x'),malformed=await make(dir,'malformed','contains spaces credential');
 for(const file of [missing,empty,directory,fifo,symbolic,mode640,mode644,linked,secondLink,oversized,multiline,nul,malformed])rejectedCli(file);
 }finally{await rm(dir,{recursive:true,force:true})}});

test('production ownership check is unconditional and wrong-owner seam is rejected',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'viq-credential-owner-'));try{const file=await make(dir,'credential');await assert.rejects(loadUpstreamAuthorization(file,{expectedUid:process.geteuid()+1}),/unsafe upstream authorization credential file/)}finally{await rm(dir,{recursive:true,force:true})}});

test('descriptor read rejects a credential changed after validated fstat',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'viq-credential-race-'));try{const file=await make(dir,'credential');await assert.rejects(loadUpstreamAuthorization(file,{afterOpen:()=>writeFile(file,valid+'changed',{mode:0o600})}),/unsafe upstream authorization credential file/)}finally{await rm(dir,{recursive:true,force:true})}});
