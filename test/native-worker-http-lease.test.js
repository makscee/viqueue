import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

test('HTTP claim-next always creates a leased worker claim and ignores a false downgrade',async t=>{
 const file=path.join(await mkdtemp(path.join(tmpdir(),'viq-http-lease-')),'db.sqlite'),store=new Store(file);await store.init();const coordinator=await store.bootstrapCoordinator({id:'human',name:'Human'});await store.createActor({id:'agent',name:'Agent',kind:'agent'});const pairing=await store.createPairingCode('human',{intended_kind:'worker',actor_id:'agent',device_id:'worker',device_name:'Worker'}),worker=await store.pairDevice({code:pairing.code});await store.createProject('ABC');const ticket=await store.createTicket({project:'ABC',title:'leased',assignment:'Agent'});await store.close();
 const app=await createApp({storage:file});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.address().port}`;
 const session=await fetch(`${base}/v1/sessions`,{method:'POST',headers:{authorization:`Bearer ${worker.credential}`,'content-type':'application/json'},body:'{}'}).then(r=>r.json());
 const response=await fetch(`${base}/v1/tickets/claim-next`,{method:'POST',headers:{authorization:`Bearer ${worker.credential}`,'x-viq-session-capability':session.session_capability,'content-type':'application/json'},body:JSON.stringify({worker_lease:false})});assert.equal(response.status,200);const claim=await response.json();assert.equal(claim.ticket.id,ticket.id);
 const db=new DatabaseSync(file,{readOnly:true}),row=db.prepare('SELECT lease_expires_at,claimed_at FROM claims WHERE claim_id=?').get(claim.ticket.claim.claim_id);db.close();assert.equal(Number.isFinite(row.lease_expires_at),true);assert.ok(row.lease_expires_at>row.claimed_at);
});
