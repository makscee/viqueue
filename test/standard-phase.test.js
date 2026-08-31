import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { claimWithSession } from './helpers/worker-session.js';
import { normalizeReviewBundle } from '../extensions/viq-worker/review-bundle.mjs';
import { parseViqCommand, viqHelp, viqStatus, friendlyViqError } from '../extensions/viq-worker/command.mjs';
import { ViqWorkerRuntime } from '../extensions/viq-worker/worker-runtime.mjs';
import { reviewSourceFacts } from '../web/ui-core.js';

async function fixture(proof='human-readable') {
  const dir=await mkdtemp(path.join(tmpdir(),'viq-standard-')),store=new Store(path.join(dir,'db.sqlite'));
  await store.init();
  await store.createActor({id:'human',name:'Human',kind:'human'}); await store.createActor({id:'worker',name:'Worker',kind:'agent'});
  await store.bootstrapCoordinator({id:'human',name:'Human'});
  const pairing=await store.createPairingCode('human',{intended_kind:'worker'}); await store.pairDevice({code:pairing.code,id:'worker',name:'Worker'});
  await store.createProject({key:'APP',review_proof_class:proof});
  const ticket=await store.createTicket({project:'APP',title:'Review me',assignment:'Agent',actor:'human'});
  return {store,ticket};
}
const authority=c=>({claim_id:c.ticket.claim.claim_id,actor:c.ticket.claim.actor,device:c.ticket.claim.device_id,generation:c.ticket.claim.generation,claim_token:c.claim_token,session_capability:c.session_capability});
const bundle=(extra={})=>({version:1,summary:'Implemented the requested result.',evidence:[{kind:'commit',label:'Candidate',uri:'urn:git:abc',digest:'sha256:abc'}],verification_steps:['Open the ticket and inspect the result.'],tests:[{name:'unit',status:'passed',uri:'urn:test:unit'}],caveats:[],ui_change:false,source:{commit:'abc',review:{status:'not-reviewed'},merge:{status:'not-merged'}},release:{status:'not-released'},...extra});

test('review bundle is structured, backend-neutral, bounded, and rejects unsafe references',()=>{
  assert.deepEqual(normalizeReviewBundle(bundle()).release,{status:'not-released'});
  assert.throws(()=>normalizeReviewBundle({...bundle(),evidence:[{kind:'log',label:'bad',uri:'javascript:alert(1)'}]}),/invalid_evidence_uri/);
  assert.throws(()=>normalizeReviewBundle({...bundle(),verification_steps:[]}),/invalid_verification_steps/);
});

test('review and merge facts are independent and source URLs render as safe links before acceptance',()=>{
  const normalized=normalizeReviewBundle(bundle({source:{commit:'https://github.com/acme/app/commit/abc',pr:'https://github.com/acme/app/pull/7',review:{status:'reviewed',reference:'https://github.com/acme/app/pull/7#pullrequestreview-1'},merge:{status:'not-merged'}}}));
  assert.deepEqual(normalized.source.review,{status:'reviewed',reference:'https://github.com/acme/app/pull/7#pullrequestreview-1'});
  assert.deepEqual(normalized.source.merge,{status:'not-merged'});
  assert.deepEqual(reviewSourceFacts(normalized,{source_lifecycle:{review:{status:'reviewed',reference:'urn:review:1'},merge:{status:'not-merged',reference:null}},deployment:{status:'not-released'}}),[
    {label:'Commit',value:'https://github.com/acme/app/commit/abc',href:'https://github.com/acme/app/commit/abc'},
    {label:'Pull request',value:'https://github.com/acme/app/pull/7',href:'https://github.com/acme/app/pull/7'},
    {label:'Acceptance',value:'pending-human-accept',href:null},
    {label:'Reviewed',value:'reviewed',href:null},
    {label:'Merged',value:'not-merged',href:null},
    {label:'Release',value:'not-released',href:null},
    {label:'Production verification',value:'not-verified',href:null}
  ]);
  assert.throws(()=>normalizeReviewBundle(bundle({source:{commit:'javascript:alert(1)',review:{status:'not-reviewed'},merge:{status:'not-merged'}}})),/invalid_commit_uri/);
});

test('visual proof policy requires a prominent explicit absence acknowledgement before human acceptance',async()=>{
  const {store,ticket}=await fixture('visual'); const claim=await claimWithSession(store,ticket.id,{actor:'worker'});
  const submitted=await store.submit(ticket.id,{...authority(claim),reviewer:{type:'actor',id:'human'},review_bundle:bundle({ui_change:true})});
  assert.equal(submitted.ticket.state,'Waiting');
  await assert.rejects(store.answerQuestion(ticket.id,submitted.question.id,{actor:'human',decision:'accept'}),e=>e.code==='proof_acknowledgement_required');
  const accepted=await store.answerQuestion(ticket.id,submitted.question.id,{actor:'human',decision:'accept',proof_acknowledged:true,note:'Reviewed without visual proof'});
  assert.equal(accepted.ticket.state,'Done'); assert.equal(accepted.ticket.deployment.status,'not-released');
  await store.close();
});

test('every STANDARD command has explicit final feedback and actionable error recovery',()=>{
  for(const command of ['unpair','status','poll','once','pause','resume','stop'])assert.equal(parseViqCommand(command).sub,command);
  const help=viqHelp({paired:true,mode:'idle'});for(const token of ['/viq unpair','/viq status','/viq poll','/viq once','/viq pause','/viq stop','viq_progress','viq_submit'])assert.match(help,new RegExp(token.replace('/','\\/')));
  const status=viqStatus({paired:true,device:'tower',lane_mode:'persistent',mode:'idle',next_retry_ms:6000},'https://viq.example');for(const token of ['tower','persistent','lifecycle','Ticket none','Endpoint https://viq.example','backoff','Next:'])assert.match(status,new RegExp(token));
  for(const code of ['viq_transport_error','device_not_paired','orphan_claim_requires_operator:APP-1','stale_claim','ticket_ineligible'])assert.match(friendlyViqError(new Error(code),'https://viq.example'),/(retry|pair|operator|Stop work|Refresh)/i);
});

test('/viq once makes exactly one atomic claim attempt and completes quietly when no work exists',async()=>{
  let attempts=0;const runtime=new ViqWorkerRuntime({credential:`worker.${'x'.repeat(32)}`,fetchImpl:async(url)=>{const route=new URL(url).pathname;if(route==='/v1/devices/me')return Response.json({device:{id:'worker',kind:'worker'},actor:{id:'agent'}});if(route.endsWith('/claims'))return Response.json({tickets:[]});if(route==='/v1/sessions')return Response.json({session_id:'s1',session_capability:`s1.${'y'.repeat(32)}`},{status:201});if(route==='/v1/sessions/close')return Response.json({revoked:true});if(route==='/v1/tickets/claim-next'){attempts++;return new Response(null,{status:204})}throw new Error(route)}});
  const status=await runtime.start({once:true});assert.equal(attempts,1);assert.equal(status.mode,'stopped');assert.equal(status.lane_mode,'once-complete');assert.equal(status.ticket,null);
});

test('reviewed and merged lifecycle facts have separate coordinator ledger transitions',async()=>{
  const {store,ticket}=await fixture();
  assert.deepEqual((await store.getTicket(ticket.id)).source_lifecycle,{review:{status:'not-reviewed',reference:null,updated_at:null},merge:{status:'not-merged',reference:null,updated_at:null}});
  const claim=await claimWithSession(store,ticket.id,{actor:'worker'});await store.submit(ticket.id,{...authority(claim),reviewer:{type:'actor',id:'human'},review_bundle:bundle({source:{commit:'abc',review:{status:'reviewed',reference:'urn:review:bundle-1'},merge:{status:'not-merged'}}})});
  assert.equal((await store.getTicket(ticket.id)).source_lifecycle.review.reference,'urn:review:bundle-1');
  await store.recordSourceLifecycle(ticket.id,{actor:'human',fact:'review',status:'reviewed',reference:'urn:review:human-1'});
  let current=await store.getTicket(ticket.id);assert.equal(current.source_lifecycle.review.status,'reviewed');assert.equal(current.source_lifecycle.merge.status,'not-merged');
  await store.recordSourceLifecycle(ticket.id,{actor:'human',fact:'merge',status:'merged',reference:'https://github.com/acme/app/pull/7'});
  current=await store.getTicket(ticket.id);assert.equal(current.source_lifecycle.review.status,'reviewed');assert.equal(current.source_lifecycle.merge.status,'merged');assert.equal(current.deployment.status,'not-released');
  assert.deepEqual((await store.listEvents({ticket:ticket.id})).events.slice(-2).map(e=>e.type),['review_recorded','merge_recorded']);
  await store.close();
});

test('acceptance, release recording, and production verification are separate human-ledger transitions',async()=>{
  const {store,ticket}=await fixture(); const claim=await claimWithSession(store,ticket.id,{actor:'worker'});
  const submitted=await store.submit(ticket.id,{...authority(claim),reviewer:{type:'actor',id:'human'},review_bundle:bundle()});
  await store.answerQuestion(ticket.id,submitted.question.id,{actor:'human',decision:'accept'});
  assert.equal((await store.getTicket(ticket.id)).deployment.status,'not-released');
  await store.recordReleaseStatus(ticket.id,{actor:'human',status:'released',reference:'urn:build:local-1'});
  assert.equal((await store.getTicket(ticket.id)).deployment.status,'released');
  await store.recordReleaseStatus(ticket.id,{actor:'human',status:'production-verified',reference:'https://viq.example/health'});
  assert.equal((await store.getTicket(ticket.id)).deployment.status,'production-verified');
  assert.deepEqual((await store.listEvents({ticket:ticket.id})).events.slice(-2).map(e=>e.type),['release_recorded','production_verified']);
  await store.close();
});
