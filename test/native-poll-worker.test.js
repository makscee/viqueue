import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { ViqWorkerRuntime } from '../extensions/viq-worker/worker-runtime.mjs';
import { saveCredential } from '../extensions/viq-worker/credential-store.mjs';

const isolatedConfig=await mkdtemp(path.join(tmpdir(),'viq-native-runtime-config-'));
process.env.XDG_CONFIG_HOME=isolatedConfig;process.env.VIQ_CREDENTIAL_FILE=path.join(isolatedConfig,'missing-credential.json');process.env.VIQ_DEVICE_TOKEN='';

async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'viq-native-poll-')),db=path.join(dir,'db.sqlite'),store=new Store(db);await store.init();const coordinator=await store.bootstrapCoordinator({id:'coord',name:'Coordinator'});await store.createActor({id:'worker',name:'Native Pi',kind:'agent'});const code=await store.createPairingCode('coord',{intended_kind:'worker',actor_id:'worker',device_id:'native-pi',device_name:'Native Pi'});const paired=await store.pairDevice({code:code.code});await store.createProject('ABC');await store.createTicket({project:'ABC',title:'A',assignment:'Agent'});await store.createTicket({project:'ABC',title:'B',assignment:'Agent'});await store.createTicket({project:'ABC',title:'Human-only',assignment:'Human'});await store.close();const app=await createApp({storage:db});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>app.close());return{app,db,base:`http://127.0.0.1:${app.address().port}`,credential:paired.credential,coordinator}}
const readDb=(db,sql)=>{const reader=new DatabaseSync(db,{readOnly:true});try{return reader.prepare(sql).get()}finally{reader.close()}};
const sessionCounts=db=>readDb(db,'SELECT COUNT(*) total,COUNT(*) FILTER (WHERE revoked_at IS NULL) active FROM worker_sessions');

test('native poll is single-flight, heartbeats waiting/working, and requires a fresh runtime after terminal settlement',async t=>{const f=await fixture(t),prompts=[],first=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000,deliver:async prompt=>prompts.push(prompt)});await first.start();assert.equal(first.status().ticket,'ABC-2');assert.equal(prompts.length,1);await first.poll();assert.equal(prompts.length,1);const machines=await fetch(`${f.base}/v1/machines`,{headers:{authorization:`Bearer ${f.coordinator.credential}`}}).then(r=>r.json());assert.deepEqual(machines.machines.find(m=>m.id==='native-pi').state,'working');assert.equal(machines.machines.find(m=>m.id==='native-pi').ticket_id,'ABC-2');assert.equal((await first.settled()).active,true);await first.submit({summary:'done',evidence:['urn:sha256:done']});assert.equal(first.status().rotation_required,true);const second=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000,deliver:async prompt=>prompts.push(prompt)});await second.start();assert.equal(second.status().ticket,'ABC-1');assert.equal(prompts.length,2);assert.match(prompts[0],/"id": "ABC-2"/);assert.match(prompts[1],/"id": "ABC-1"/);await second.stop()});

test('worker presence rejects stale fenced ticket heartbeat',async t=>{const f=await fixture(t),runtime=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000});await runtime.start();const bad=await fetch(`${f.base}/v1/workers/heartbeat`,{method:'POST',headers:{authorization:`Bearer ${f.credential}`,'x-viq-session-capability':'bad','content-type':'application/json'},body:JSON.stringify({mode:'working',ticket_id:'ABC-2',claim_id:'bad',generation:99,claim_token:'bad'})});assert.equal(bad.status,409);await runtime.stop()});

test('independent native worker sessions on one paired device claim and release concurrently',async t=>{
 const f=await fixture(t),first=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000}),second=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000});
 await Promise.all([first.start(),second.start()]);
 assert.deepEqual(new Set([first.status().ticket,second.status().ticket]),new Set(['ABC-1','ABC-2']));
 assert.notEqual(first.session.id,second.session.id);
 const survivor=second.status().ticket,firstTicket=first.status().ticket;
 await first.release('first session complete');
 assert.equal((await f.app.viqStore.getTicket(firstTicket)).claim,null);
 assert.equal((await second.settled()).active,true);
 assert.equal((await f.app.viqStore.getTicket(survivor)).claim.session_id,second.session.id);
 await second.release('second session complete');
});

test('exact 404/409 claim rejection closes each new HTTP session before a later correct take',async t=>{
 const f=await fixture(t),runtime=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000});
 for(const [ticket,status,code]of[['ABC-999',404,'ticket_not_found'],['ABC-3',409,'ticket_ineligible']]){
  await assert.rejects(runtime.start({ticket}),error=>{assert.equal(error.status,status);assert.equal(error.code,code);return true});
  assert.deepEqual({mode:runtime.status().mode,lane_mode:runtime.status().lane_mode,ticket:runtime.status().ticket,session:runtime.session},{mode:'stopped',lane_mode:'stopped',ticket:null,session:null});
  assert.equal(sessionCounts(f.db).active,0,'definitive rejection must not leak a live worker session');
  assert.deepEqual({...readDb(f.db,"SELECT mode,ticket_id FROM worker_presence WHERE device_id='native-pi'")},{mode:'stopped',ticket_id:null});
 }
 const taken=await runtime.start({ticket:'ABC-1'});assert.equal(taken.episode.ticket.id,'ABC-1');assert.equal(runtime.status().ticket,'ABC-1');assert.equal(sessionCounts(f.db).active,1);await runtime.release('test cleanup');assert.equal(sessionCounts(f.db).active,0);
});

test('ambiguous exact claim result stops for external reconciliation without retrying or claiming safety',async t=>{
 const f=await fixture(t);let claimCalls=0;
 const runtime=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000,fetchImpl:async(url,init)=>{const response=await fetch(url,init);if(String(url).endsWith('/v1/tickets/ABC-1/claim')){claimCalls++;assert.equal(response.status,200);return new Response(JSON.stringify({unexpected:'corrupt claim result'}),{status:200,headers:{'content-type':'application/json'}})}return response}});
 await assert.rejects(runtime.start({ticket:'ABC-1'}),/invalid_claim_response/);
 assert.equal(claimCalls,1);assert.equal(runtime.status().mode,'blocked');assert.equal(runtime.status().lane_mode,'take');assert.match(runtime.status().last_error,/viq_external_reconciliation_required/);assert.ok(runtime.session);assert.equal(sessionCounts(f.db).active,1);assert.notEqual((await f.app.viqStore.getTicket('ABC-1')).claim,null,'the server may have mutated despite an unusable result');
});

test('an explicit credential lane remains selected across later unqualified starts despite another ambient selector',async t=>{
 const f=await fixture(t),root=await mkdtemp(path.join(await realpath(tmpdir()),'viq-lane-identity-')),ambientFile=path.join(root,'ambient-a.json'),laneFile=path.join(root,'lane-b.json'),previous=process.env.VIQ_CREDENTIAL_FILE;
 saveCredential(f.coordinator.credential,ambientFile);saveCredential(f.credential,laneFile);process.env.VIQ_CREDENTIAL_FILE=ambientFile;t.after(()=>{if(previous===undefined)delete process.env.VIQ_CREDENTIAL_FILE;else process.env.VIQ_CREDENTIAL_FILE=previous});
 const runtime=new ViqWorkerRuntime({baseUrl:f.base,credential:f.credential,pollMs:100000});
 await runtime.start({ticket:'ABC-1',credentialFile:laneFile});await runtime.release('first episode complete');
 const second=await runtime.start({ticket:'ABC-2'});assert.equal(second.episode.ticket.id,'ABC-2');assert.equal(runtime.credentialFile,laneFile);assert.equal(runtime.credential,f.credential);await runtime.release('test cleanup');
});

test('native take claims only the exact ticket and direct completion closes its fenced episode',async t=>{
 const f=await fixture(t),prompts=[],calls=[],credentialFile=path.join(await mkdtemp(path.join(await realpath(tmpdir()),'viq-take-credential-')),'worker.json');
 saveCredential(f.credential,credentialFile);
 const runtime=new ViqWorkerRuntime({baseUrl:f.base,credential:null,pollMs:100000,deliver:async prompt=>prompts.push(prompt),fetchImpl:async(url,init)=>{if(String(url).endsWith('/complete')||String(url).endsWith('/sessions/close'))calls.push({url:String(url),init});return fetch(url,init)}});
 await runtime.start({ticket:'ABC-1',credentialFile});
 assert.equal(runtime.status().ticket,'ABC-1');
 assert.equal(prompts.length,1);assert.match(prompts[0],/"id": "ABC-1"/);assert.doesNotMatch(prompts[0],/"id": "ABC-2"/);
 assert.equal((await f.app.viqStore.getTicket('ABC-2')).claim,null,'take must not fall back to the poll-selected ticket');
 const completed=await runtime.complete({outcome:'Implemented and tested.',evidence:['urn:test:focused','opaque-build-42']});
 assert.equal(completed.ticket,'ABC-1');assert.deepEqual({mode:runtime.status().mode,rotation_required:runtime.status().rotation_required,ticket:runtime.status().ticket},{mode:'stopped',rotation_required:true,ticket:null});
 const completionCall=calls.find(call=>call.url.endsWith('/v1/tickets/ABC-1/complete'));assert.ok(completionCall);const body=JSON.parse(completionCall.init.body);
 assert.equal(body.outcome,'Implemented and tested.');assert.deepEqual(body.evidence_references,['urn:test:focused','opaque-build-42']);assert.equal(typeof body.claim_id,'string');assert.equal(typeof body.claim_token,'string');assert.equal(Number.isSafeInteger(body.generation),true);assert.equal(typeof body.request_id,'string');
 assert.equal(calls.filter(call=>call.url.endsWith('/v1/sessions/close')).length,1);
 const ticket=await f.app.viqStore.getTicket('ABC-1');assert.equal(ticket.state,'Done');assert.equal(ticket.claim,null);
 const events=(await f.app.viqStore.listEvents({ticket:'ABC-1'})).events;const completion=events.filter(event=>event.type==='completed');assert.equal(completion.length,1);assert.equal(completion[0].message,'Implemented and tested.');assert.deepEqual(completion[0].metadata.evidence_references,['urn:test:focused','opaque-build-42']);
 const stale=await fetch(completionCall.url,{method:'POST',headers:completionCall.init.headers,body:JSON.stringify({...body,request_id:'after-terminal'})});assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'stale_claim');
});
