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

test('HTTP sessions on one paired device claim concurrently and retain exact session mutation fences',async t=>{
 const file=path.join(await mkdtemp(path.join(tmpdir(),'viq-http-sessions-')),'db.sqlite'),store=new Store(file);await store.init();await store.bootstrapCoordinator({id:'human',name:'Human'});await store.createActor({id:'agent',name:'Agent',kind:'agent'});const pairing=await store.createPairingCode('human',{intended_kind:'worker',actor_id:'agent',device_id:'worker',device_name:'Worker'}),worker=await store.pairDevice({code:pairing.code});await store.createProject('ABC');for(const title of['one','two','three'])await store.createTicket({project:'ABC',title,assignment:'Agent'});await store.close();
 const app=await createApp({storage:file});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());const base=`http://127.0.0.1:${app.address().port}`,headers=capability=>({authorization:`Bearer ${worker.credential}`,'x-viq-session-capability':capability,'content-type':'application/json'}),post=(route,capability,body={})=>fetch(`${base}${route}`,{method:'POST',headers:headers(capability),body:JSON.stringify(body)});
 const firstSession=await post('/v1/sessions',null).then(r=>r.json()),secondSession=await post('/v1/sessions',null).then(r=>r.json());
 const firstResponse=await post('/v1/tickets/ABC-1/claim',firstSession.session_capability),secondResponse=await post('/v1/tickets/ABC-2/claim',secondSession.session_capability);assert.equal(firstResponse.status,200);assert.equal(secondResponse.status,200);const first=await firstResponse.json(),second=await secondResponse.json();
 const third=await post('/v1/tickets/ABC-3/claim',firstSession.session_capability);assert.equal(third.status,409);assert.equal((await third.json()).error.code,'session_already_claimed');
 const fence=claim=>({claim_id:claim.ticket.claim.claim_id,generation:claim.ticket.claim.generation,claim_token:claim.claim_token});
 const cross=await post('/v1/tickets/ABC-1/events',secondSession.session_capability,{...fence(first),message:'cross-session'});assert.equal(cross.status,409);assert.equal((await cross.json()).error.code,'stale_claim');
 const released=await post('/v1/tickets/ABC-1/release',firstSession.session_capability,fence(first));assert.equal(released.status,200);assert.equal((await released.json()).ticket.claim,null);
 const secondTicket=await fetch(`${base}/v1/tickets/ABC-2`,{headers:{authorization:`Bearer ${worker.credential}`}}).then(r=>r.json());assert.equal(secondTicket.ticket.claim.claim_id,second.ticket.claim.claim_id);
 await post('/v1/sessions/close',secondSession.session_capability);const revoked=await post('/v1/tickets/ABC-2/events',secondSession.session_capability,{...fence(second),message:'revoked'});assert.equal(revoked.status,409);assert.equal((await revoked.json()).error.code,'stale_claim');
});
