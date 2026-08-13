import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net'; import { tmpdir } from 'node:os'; import path from 'node:path'; import test from 'node:test';
const cli = path.resolve('bin/viq.js');
async function fixture() { const dir = await mkdtemp(path.join(tmpdir(), 'viq-cli-')); const probe = net.createServer(); await new Promise((r) => probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise((r)=>probe.close(r)); const app=spawn(process.execPath,['src/server.js',`--port=${port}`,`--storage=${dir}/data.sqlite`,'--operator-token=secret']); const url=`http://127.0.0.1:${port}`; for(let i=0;i<100;i++){try{if((await fetch(`${url}/health`)).ok)return{app,url};}catch{} await new Promise((r)=>setTimeout(r,10));} throw new Error('server start'); }
const run=(url,...args)=>spawnSync(process.execPath,[cli,'--server',url,'--json',...args],{encoding:'utf8'});
test('CLI covers list/edit/claims/events and lifecycle without lease arguments', async(t)=>{ const {app,url}=await fixture(); t.after(()=>app.kill());
  assert.equal(run(url,'project','create','ABC').status,0); assert.equal(JSON.parse(run(url,'project','list').stdout).projects.length,1);
  assert.equal(run(url,'ticket','create','ABC','CLI tracer','--body','details','--assigned-to','eva').status,0);
  assert.equal(JSON.parse(run(url,'ticket','list','ABC').stdout).tickets[0].assigned_to,'eva');
  const claim=JSON.parse(run(url,'ticket','claim','ABC-1','--actor','worker').stdout); const c=['--claim-id',claim.ticket.claim.claim_id,'--actor','worker','--claim-token',claim.claim_token,'--generation','1'];
  assert.equal(run(url,'ticket','verify','ABC-1',...c).status,0); assert.equal(run(url,'event','post','ABC-1',...c,'--message','green').status,0);
  assert.equal(JSON.parse(run(url,'event','list','--ticket','ABC-1','--after','0').stdout).events.at(-1).message,'green');
  assert.equal(JSON.parse(run(url,'ticket','submit','ABC-1',...c).stdout).ticket.state,'review');
  assert.equal(JSON.parse(run(url,'ticket','accept','ABC-1','--actor','maks','--auth','secret').stdout).ticket.state,'done');
  assert.equal(JSON.parse(run(url,'ticket','reopen','ABC-1','--actor','maks','--auth','secret').stdout).ticket.state,'open');
  assert.equal(run(url,'ticket','claim','ABC-1','--actor','worker','--ttl-ms','100').status,0);
});
