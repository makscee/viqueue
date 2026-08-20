import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server.js';

const dir=await mkdtemp(path.join(tmpdir(),'viq15-core-red-'));
const app=await createApp({storage:path.join(dir,'db.sqlite'),operatorToken:'operator-red',ingressToken:'ingress-red'});
await new Promise(r=>app.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.address().port}`;
const req=async(method,route,body,headers={})=>{const r=await fetch(base+route,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();return{status:r.status,body:text?JSON.parse(text):null}};
try{
 await req('POST','/v1/projects',{key:'RED'});
 for(const[id,kind]of[['worker','agent'],['maks','human']])await req('POST','/v1/actors',{id,name:id,kind},{authorization:'Bearer operator-red'});
 const unassigned=await req('POST','/v1/tickets',{project:'RED',title:'unassigned',actor:'maks'});
 const direct=await req('POST','/v1/tickets/RED-1/claim',{actor:'worker'});
 const ordinary=await req('POST','/v1/tickets',{project:'RED',title:'operator assignment',actor:'maks',assignee:{type:'actor',id:'worker'}},{authorization:'Bearer operator-red'});
 console.log(JSON.stringify({unassigned_direct_claim_status:direct.status,unassigned_direct_claim_token:typeof direct.body?.claim_token==='string',operator_assignment_authority:Boolean(ordinary.body?.ticket?.execution_authority)}));
}finally{await new Promise(r=>app.close(r))}
