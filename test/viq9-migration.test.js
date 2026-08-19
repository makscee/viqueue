import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

test('VIQ-9 Done and its single accepted event survive restart unchanged',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'viq-nine-migrate-')),file=path.join(dir,'db.sqlite');let store=new Store(file);await store.init();await store.createProject('VIQ');await store.createActor({id:'worker',name:'Worker',kind:'agent'});await store.createActor({id:'maks',name:'Maks',kind:'human'});let ticket;for(let i=1;i<=9;i++)ticket=await store.createTicket({project:'VIQ',title:`Ticket ${i}`});const claim=await store.claim(ticket.id,{actor:'worker'}),identity={claim_id:claim.ticket.claim.claim_id,actor:'worker',generation:claim.ticket.claim.generation,claim_token:claim.claim_token};await store.submit(ticket.id,{...identity,reviewer:{type:'actor',id:'maks'}});await store.accept(ticket.id,{actor:'maks'});await store.close();store=new Store(file);await store.init();try{assert.equal((await store.getTicket('VIQ-9')).state,'done');assert.equal((await store.listEvents({ticket:'VIQ-9'})).events.filter(event=>event.type==='accepted').length,1)}finally{await store.close()}});
