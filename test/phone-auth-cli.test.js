import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

test('trusted CLI issues one code with server-bound browser metadata',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'viq-phone-cli-')),db=path.join(dir,'auth.sqlite'),run=(...args)=>spawnSync(process.execPath,['bin/viq-phone-auth.js',...args,`--db=${db}`,'--origin=https://phone.test','--json'],{encoding:'utf8'});try{let result=run('status');assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).paired,false);result=run('pair-create','--device-id=browser_cli_0001','--actor-id=operator','--label=Operator browser');assert.equal(result.status,0);const pair=JSON.parse(result.stdout);assert.match(pair.code,/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);assert.deepEqual(Object.keys(pair).sort(),['code','expires']);assert.equal(result.stderr.includes(pair.code),false);result=run('status');const status=JSON.parse(result.stdout);assert.equal(status.audit[0].action,'pair_created');assert.equal(status.audit[0].device_id,'browser_cli_0001');assert.deepEqual(JSON.parse(status.audit[0].detail),{expires:pair.expires,actor_id:'operator',admin:true,label:'Operator browser'});result=run('revoke');assert.equal(JSON.parse(result.stdout).revoked,false)}finally{await rm(dir,{recursive:true,force:true})}});
