import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { poolState, loadPoolState, savePoolState } from '../extensions/viq-worker/pool-state.mjs';
import { ViqWorkerRuntime } from '../extensions/viq-worker/worker-runtime.mjs';

const credential=`worker.${'x'.repeat(32)}`;
const claim=(id,n)=>({ticket:{id,project:'VIQ',claim:{claim_id:`c${n}`,generation:1}},claim_token:'z'.repeat(32)});
function fake(){let next=1,claimNext=0;const fetchImpl=async(url,init={})=>{const route=new URL(url).pathname;if(route==='/v1/devices/me')return Response.json({device:{id:'m1',kind:'worker'},actor:{id:'agent'}});if(route.endsWith('/claims'))return Response.json({tickets:[]});if(route==='/v1/sessions')return Response.json({session_id:`s${next}`,session_capability:`s.${'y'.repeat(32)}`},{status:201});if(route==='/v1/sessions/close')return Response.json({revoked:true});if(route==='/v1/tickets/claim-next'){claimNext++;return Response.json(claim(`VIQ-${next}`,next++))}if(route==='/v1/events')return Response.json({events:[]});if(route.endsWith('/submit'))return Response.json({ticket:{state:'Waiting'}});if(route.endsWith('/release'))return Response.json({ticket:{state:'Open'}});throw new Error(`unexpected ${init.method} ${route}`)};return{fetchImpl,get claimNext(){return claimNext}}}

test('persistent pool checkpoint is owner-only and carries continuation outside transcript',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'viq-pool-')),file=path.join(dir,'pool.json');savePoolState(poolState('VIQ','VIQ-3'),file);assert.deepEqual(loadPoolState(file),{version:1,enabled:true,project:'VIQ',continue_ticket:'VIQ-3'});assert.equal((await stat(file)).mode&0o777,0o600)});

test('one turn ending cannot pull a second ticket while its claim remains active',async()=>{const f=fake(),worker=new ViqWorkerRuntime({credential,fetchImpl:f.fetchImpl,pollMs:100000});await worker.start({project:'VIQ'});assert.equal(worker.status().ticket,'VIQ-1');await worker.poll();await worker.poll();assert.equal(f.claimNext,1);assert.equal(worker.status().ticket,'VIQ-1');await worker.release('test cleanup')});

test('terminal boundary permits a different ticket only in a fresh runtime context',async()=>{const f=fake(),first=new ViqWorkerRuntime({credential,fetchImpl:f.fetchImpl,pollMs:100000});await first.start({project:'VIQ'});assert.equal(first.status().ticket,'VIQ-1');await first.submit({summary:'done',evidence:['urn:sha256:abc']});assert.equal(first.status().rotation_required,true);await first.poll();assert.equal(f.claimNext,1);const fresh=new ViqWorkerRuntime({credential,fetchImpl:f.fetchImpl,pollMs:100000});await fresh.start({project:'VIQ'});assert.equal(fresh.status().ticket,'VIQ-2');assert.equal(f.claimNext,2);await fresh.release('test cleanup')});
