#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const timeoutMs=Number(process.env.VIQ_ACCEPT_TIMEOUT_MS??240000);
const deadline=Date.now()+timeoutMs;
const waitFor=async(label,predicate)=>{let last;while(Date.now()<deadline){try{last=await predicate();if(last)return last}catch(error){last=error}await new Promise(resolve=>setTimeout(resolve,50))}throw new Error(`${label} timed out${last instanceof Error?`: ${last.message}`:''}`)};
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})});
const close=server=>new Promise(resolve=>server.close(resolve));
const cleanTerminal=value=>value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
const bundle={version:1,summary:'Fake provider completed the isolated acceptance ticket.',evidence:[{kind:'test',label:'Hermetic packaged acceptance',uri:'urn:viq:acceptance'}],verification_steps:['Observe the isolated coordinator transition.'],tests:[{name:'packaged two-ticket loop',status:'passed',uri:'urn:viq:test'}],caveats:[],ui_change:false,screenshots:[],source:{review:{status:'not-reviewed'},merge:{status:'not-merged'}},release:{status:'not-released'}};
const work=await realpath(await mkdtemp(path.join(os.tmpdir(),'viq-worker-accept-')));
let app,provider,pty,ptyError='',transcript='';
try{
  let archive=process.argv[2];
  if(!archive){const out=path.join(work,'package');await mkdir(out);const result=JSON.parse(execFileSync(process.execPath,['scripts/package-viq-worker.js',out],{encoding:'utf8'}));archive=result.archive}
  archive=path.resolve(archive);const release=path.join(work,'release');await mkdir(release);
  const members=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');assert.ok(members.length>1);assert.equal(members.some(member=>member.includes('node_modules')||member.startsWith('/')||member.split('/').includes('..')),false);
  for(const member of members.filter(Boolean)){const listing=execFileSync('tar',['-tvzf',archive,member],{encoding:'utf8'});assert.notEqual(listing[0],'l','worker archive must not contain symlinks')}
  execFileSync('tar',['-xzf',archive,'-C',release,'--strip-components=1']);
  const extension=path.join(release,'extensions/viq-worker/index.ts');
  await import(path.join(release,'extensions/viq-worker/worker-runtime.mjs'));

  const db=path.join(work,'coordinator.sqlite');let store=new Store(db);await store.init();const coordinator=await store.bootstrapCoordinator({id:'coord',name:'Coordinator'});await store.createActor({id:'pty-worker',name:'PTY Worker',kind:'agent'});const pairing=await store.createPairingCode('coord',{intended_kind:'worker',actor_id:'pty-worker',device_id:'pty-worker',device_name:'PTY Worker'});const paired=await store.pairDevice({code:pairing.code});await store.createProject('PTY');await store.createRole({id:'reviewer',name:'Reviewer'});await store.grantDeviceRole('coord','reviewer','coord');await store.createTicket({project:'PTY',title:'First isolated ticket',actor:'coord',assignment:'Agent'});await store.close();
  app=await createApp({storage:db});await listen(app);const viqUrl=`http://127.0.0.1:${app.address().port}`;
  const request=async(route)=>{const response=await fetch(viqUrl+route,{headers:{authorization:`Bearer ${coordinator.credential}`}});return response.status===204?null:response.json()};

  const providerTrace=[];
  provider=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());const serialized=JSON.stringify(body.messages??[]);const ticket=serialized.includes('PTY-2')?'PTY-2':serialized.includes('PTY-1')?'PTY-1':null;const hasSubmitResult=(body.messages??[]).some(message=>message.role==='tool'&&String(message.content).includes('Submitted '));const explicitSettle=serialized.includes('Settle this ticket now');
    providerTrace.push({ticket,hasSubmitResult,explicitSettle,containsPrior:ticket==='PTY-2'&&serialized.includes('PTY-1')});
    let delta,finish='stop';if((ticket==='PTY-1'&&explicitSettle)||ticket==='PTY-2'){finish='tool_calls';delta={tool_calls:[{index:0,id:`call-${ticket}`,type:'function',function:{name:'viq_submit',arguments:JSON.stringify(bundle)}}]}}else delta={content:'Claim received; waiting for an explicit settle instruction.'};
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify({id:`fake-${providerTrace.length}`,object:'chat.completion.chunk',created:1,model:'viq-fake',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);res.write(`data: ${JSON.stringify({id:`fake-${providerTrace.length}`,object:'chat.completion.chunk',created:1,model:'viq-fake',choices:[],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`);res.end('data: [DONE]\n\n');
  });await listen(provider);const providerUrl=`http://127.0.0.1:${provider.address().port}/v1`;
  const providerExtension=path.join(work,'fake-provider.ts');await writeFile(providerExtension,`export default function(pi){pi.registerProvider('viq-fake',{baseUrl:${JSON.stringify(providerUrl)},apiKey:'fake-local-key',api:'openai-completions',models:[{id:'viq-fake',name:'VIQ Fake',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:2048}]})}\n`);
  const config=path.join(work,'config'),sessions=path.join(work,'sessions');await mkdir(path.join(config,'viq'),{recursive:true,mode:0o700});await mkdir(sessions,{mode:0o700});await writeFile(path.join(config,'viq','credential.json'),`${JSON.stringify({credential:paired.credential})}\n`,{mode:0o600});
  const bridge=path.join(work,'terminal_bridge.py');await writeFile(bridge,`import json,os,pty,select,signal,sys\ncfg=json.load(open(sys.argv[1]))\npid,fd=pty.fork()\nif pid==0:\n os.chdir(cfg['cwd']);os.execvpe(cfg['argv'][0],cfg['argv'],cfg['env'])\nwhile True:\n r,_,_=select.select([fd,sys.stdin.fileno()],[],[],0.1)\n if fd in r:\n  try:d=os.read(fd,65536)\n  except OSError:break\n  if not d:break\n  os.write(sys.stdout.fileno(),d)\n if sys.stdin.fileno() in r:\n  d=os.read(sys.stdin.fileno(),65536)\n  if not d:os.kill(pid,signal.SIGTERM);break\n  os.write(fd,d)\n`,{mode:0o700});await chmod(bridge,0o700);
  const piBin=process.env.VIQ_PI_BIN??path.resolve('node_modules/.bin/pi');const env={...process.env,HOME:work,XDG_CONFIG_HOME:config,VIQ_URL:viqUrl,VIQ_WORKER_POLL_MS:'250',PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',TERM:'xterm-256color',PATH:process.env.PATH};delete env.ANTHROPIC_API_KEY;delete env.OPENAI_API_KEY;
  const cfg=path.join(work,'pty.json');await writeFile(cfg,JSON.stringify({cwd:work,argv:[piBin,'--provider','viq-fake','--model','viq-fake','--session-dir',sessions,'--no-extensions','--no-skills','--no-context-files','--extension',providerExtension,'--extension',extension],env}));
  pty=spawn('python3',[bridge,cfg],{stdio:['pipe','pipe','pipe']});pty.stdout.on('data',chunk=>transcript=(transcript+chunk.toString()).slice(-500000));pty.stderr.on('data',chunk=>ptyError+=chunk);
  const send=line=>pty.stdin.write(`${line}\r`);const outputHas=text=>cleanTerminal(transcript).includes(text);
  await waitFor('Pi TUI startup',()=>outputHas('viq-fake'));
  send('/viq');await waitFor('help notification',()=>outputHas('VIQ commands'));
  send('/viq status');await waitFor('status notification',()=>outputHas('Ticket none'));
  send('/viq poll');await waitFor('PTY-1 claim',async()=>{const value=await request('/v1/tickets/PTY-1');return value?.ticket?.state==='Working'});await waitFor('first model turn',()=>providerTrace.some(item=>item.ticket==='PTY-1'&&!item.explicitSettle));
  send('/viq pause');await waitFor('pause notification',()=>outputHas('polling paused'));
  send('/viq resume');await waitFor('resume notification',()=>outputHas('polling resumed'));
  store=new Store(db);await store.init();await store.createTicket({project:'PTY',title:'Second isolated ticket',actor:'coord',assignment:'Agent'});await store.close();
  send('Settle this ticket now with viq_submit.');
  await waitFor('PTY-1 submission',async()=>{const value=await request('/v1/tickets/PTY-1');return value?.ticket?.state==='Waiting'});
  await waitFor('fresh PTY-2 provider context',()=>providerTrace.some(item=>item.ticket==='PTY-2'));
  await waitFor('PTY-2 submission',async()=>{const value=await request('/v1/tickets/PTY-2');return value?.ticket?.state==='Waiting'});
  await waitFor('fresh idle session',()=>{const visible=cleanTerminal(transcript),submitted=visible.lastIndexOf('Submitted PTY-2');return submitted>=0&&visible.slice(submitted).includes('pi v0.83.0')&&visible.slice(submitted).includes('viq idle')});
  send('/viq stop');await waitFor('stop notification',()=>outputHas('polling stopped'));
  send('/viq once');await waitFor('once notification',()=>outputHas('one-shot complete'));
  const pool=JSON.parse(await readFile(path.join(config,'viq','pool.json'),'utf8'));assert.equal(pool.enabled,false,'once must leave persistent polling disabled');
  const files=(await readdir(sessions)).filter(name=>name.endsWith('.jsonl')).sort();const parsed=[];for(const file of files){const lines=(await readFile(path.join(sessions,file),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);parsed.push({file,lines})}assert.ok(parsed.some(session=>session.lines.some(entry=>JSON.stringify(entry).includes('viq_submit'))),'old session must durably contain viq_submit');assert.equal(providerTrace.filter(item=>item.ticket==='PTY-1'&&item.explicitSettle).length,1);assert.equal(providerTrace.filter(item=>item.ticket==='PTY-2').length,1);assert.equal(providerTrace.some(item=>item.containsPrior),false,'PTY-2 provider context must not contain PTY-1');assert.equal(providerTrace.some(item=>item.hasSubmitResult),false,'terminal tool result must not trigger another model turn');
  pty.stdin.end();await Promise.race([new Promise(resolve=>pty.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,1000))]);if(pty.exitCode===null)pty.kill('SIGTERM');
  const transitions=['persistent:idle','PTY-1:claimed','PTY-1:settled','persistent:paused','persistent:resumed','PTY-1:submitted','session:fresh','PTY-2:claimed','PTY-2:submitted','session:fresh-idle','persistent:stopped','once:complete'];
  process.stdout.write(`${JSON.stringify({ok:true,transitions,old_session_saved:true,fresh_boundary:true,provider_turns:providerTrace.length,package:path.basename(archive)})}\n`);
}catch(error){if(ptyError)process.stderr.write(ptyError);process.stderr.write(`acceptance terminal tail: ${JSON.stringify(cleanTerminal(transcript).slice(-2000))}\n`);throw error}finally{if(pty&&pty.exitCode===null)pty.kill('SIGTERM');if(provider)await close(provider);if(app)await close(app);if(process.env.VIQ_KEEP_ACCEPTANCE_TEMP!=='1'){try{execFileSync('chmod',['-R','u+w',work])}catch{}await rm(work,{recursive:true,force:true})}}
