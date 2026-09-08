import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import viqWorker from '../extensions/viq-worker/index.ts';
import { controller } from '../extensions/viq-worker/controller.mjs';

const isolatedConfig=await mkdtemp(path.join(tmpdir(),'viq-clean-session-config-'));
process.env.XDG_CONFIG_HOME=isolatedConfig;process.env.VIQ_CREDENTIAL_FILE=path.join(isolatedConfig,'missing-credential.json');process.env.VIQ_DEVICE_TOKEN='';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const toolContext=session=>({sessionManager:{getEntries:()=>session.entries,getSessionId:()=>session.id}});

function extensionHarness(runtime,{reset=true,label='session',session={id:label,entries:[]}}={}){
 const handlers=new Map(),commands=new Map(),tools=new Map(),sessionNames=[];
 const pi={
  label,
  on(name,handler){handlers.set(name,handler)},
  registerCommand(name,command){commands.set(name,command)},
  registerTool(tool){tools.set(tool.name,tool)},
  appendEntry(customType,data){session.entries.push({type:'custom',customType,data})},
  setSessionName(name){sessionNames.push(name)},
  sendUserMessage(){throw new Error('empty queue must not create a model turn')}
 };
 if(reset){controller.epoch=0;controller.adapter=null;controller.persistent=false;controller.pendingStart=false;controller.pendingTicket=null;controller.pendingCredentialFile=null;controller.rotating=false}
 controller.runtime=runtime;
 viqWorker(pi);
 const emit=async(name,event={},ctx={})=>handlers.get(name)?.(event,ctx);
 return{commands,emit,pi,session,sessionNames,tools};
}

test('Pi 0.83 event contexts rotate through command-capable replacement contexts',async t=>{
 const state={mode:'stopped',rotation_required:false};
 const runtime={
  project:null,
  status:()=>({...state}),
  async start(){state.mode='waiting';state.rotation_required=false},
  async shutdown(){},
  async settled(){return{active:false}}
 };
 const h=extensionHarness(runtime),calls=[];
 t.after(()=>{controller.runtime=null;controller.adapter=null;controller.persistent=false});
 const eventContext=()=>({ui:{setStatus(){},notify(){}},sessionManager:{}});
 let replacement2,resolveSecond;
 const secondRotation=new Promise(resolve=>{resolveSecond=resolve});
 const replacement1={newSession:async options=>{calls.push({from:'replacement-1',options});await h.emit('session_shutdown');await h.emit('session_start',{},eventContext());replacement2={newSession:async()=>{throw new Error('unexpected third rotation')}};await options.withSession(replacement2);resolveSecond();return{cancelled:false}}};
 const commandContext={ui:{notify(){}},newSession:async options=>{calls.push({from:'poll-command',options});await h.emit('session_shutdown');await h.emit('session_start',{},eventContext());await options.withSession(replacement1);return{cancelled:false}}};
 await h.emit('session_start',{},eventContext());
 await h.commands.get('viq').handler('poll',commandContext);
 assert.equal(calls.length,1);
 assert.deepEqual(Object.keys(calls[0].options),['withSession']);
 assert.equal(controller.adapter.transition,replacement1);
 assert.equal(state.mode,'waiting');

 state.mode='stopped';state.rotation_required=true;
 const pi083SettledContext={ui:{notify(){}}};
 assert.equal('newSession' in pi083SettledContext,false);
 await h.emit('agent_settled',{},pi083SettledContext);
 await secondRotation;
 assert.equal(calls.length,2);
 assert.equal(calls[1].from,'replacement-1');
 assert.deepEqual(Object.keys(calls[1].options),['withSession']);
 assert.equal(controller.adapter.transition,replacement2);
 assert.equal(state.mode,'waiting');

 await h.emit('session_shutdown');
 await h.emit('session_start',{},eventContext());
 state.mode='stopped';state.rotation_required=true;
 await h.emit('agent_settled',{},pi083SettledContext);
 await flush();
 assert.equal(calls.length,2,'manual resume has no captured transition authority');
});

test('cancelled initial rotation cannot dispatch into a later manual session',async t=>{
 const state={mode:'stopped',rotation_required:false,last_error:null},starts=[];
 const runtime={
  project:null,
  status:()=>({...state}),
  async start(){starts.push('start');state.mode='waiting'},
  async shutdown(){},
  rotationCancelled(){state.mode='stopped';state.rotation_required=false;state.last_error='viq_rotation_cancelled'}
 };
 const h=extensionHarness(runtime),eventContext=()=>({ui:{setStatus(){},notify(){}},sessionManager:{}});
 t.after(()=>{controller.runtime=null;controller.adapter=null;controller.persistent=false});
 await h.emit('session_start',{},eventContext());
 await h.commands.get('viq').handler('poll',{ui:{notify(){}},async newSession(){return{cancelled:true}}});
 assert.deepEqual(starts,[]);
 assert.equal(controller.pendingStart,false);
 assert.equal(controller.persistent,false);
 assert.equal(controller.adapter.transition,null);
 assert.equal(state.last_error,'viq_rotation_cancelled');
 await h.emit('session_start',{},eventContext());
 await flush();
 assert.deepEqual(starts,[],'manual session_start must not inherit cancelled dispatch');
});

test('cancelled post-settlement rotation clears captured ownership before manual resume',async t=>{
 const state={mode:'stopped',rotation_required:false,last_error:null},starts=[];
 const runtime={
  project:null,
  status:()=>({...state}),
  async start(){starts.push('start');state.mode='waiting';state.rotation_required=false},
  async shutdown(){},
  async settled(){return{active:false}},
  rotationCancelled(){state.mode='stopped';state.rotation_required=false;state.last_error='viq_rotation_cancelled'}
 };
 const h=extensionHarness(runtime),eventContext=()=>({ui:{setStatus(){},notify(){}},sessionManager:{}});
 t.after(()=>{controller.runtime=null;controller.adapter=null;controller.persistent=false});
 let resolveCancelled;
 const cancelledRotation=new Promise(resolve=>{resolveCancelled=resolve});
 const replacement={async newSession(){resolveCancelled();return{cancelled:true}}};
 await h.emit('session_start',{},eventContext());
 await h.commands.get('viq').handler('poll',{ui:{notify(){}},newSession:async options=>{await h.emit('session_shutdown');await h.emit('session_start',{},eventContext());await options.withSession(replacement);return{cancelled:false}}});
 assert.deepEqual(starts,['start']);
 state.mode='stopped';state.rotation_required=true;
 await h.emit('agent_settled',{}, {ui:{notify(){}}});
 await cancelledRotation;
 await flush();
 assert.equal(controller.pendingStart,false);
 assert.equal(controller.persistent,false);
 assert.equal(controller.adapter.transition,null);
 assert.equal(state.last_error,'viq_rotation_cancelled');
 await h.emit('session_start',{},eventContext());
 await flush();
 assert.deepEqual(starts,['start'],'manual resume must not dispatch after cancelled rotation');
});

test('/viq take rotates first and the reloaded extension starts the exact ticket in the fresh session',async t=>{
 const state={mode:'stopped',rotation_required:false},starts=[];
 const runtime={
  project:null,
  status:()=>({...state}),
  async start(options){starts.push({options,adapter:controller.adapter?.pi.label});state.mode='working'},
  async shutdown(){state.mode='stopped'},
  rotationCancelled(){state.mode='stopped';state.rotation_required=false}
 };
 const eventContext=()=>({ui:{setStatus(){},notify(){}},sessionManager:{}}),first=extensionHarness(runtime,{label:'old'});
 t.after(()=>{controller.runtime=null;controller.adapter=null;controller.persistent=false;controller.pendingTicket=null});
 await first.emit('session_start',{},eventContext());
 let fresh;
 await first.commands.get('viq').handler('take abc-1 --credential-file /tmp/viq-lane.json',{ui:{notify(){}},newSession:async options=>{
  await first.emit('session_shutdown');
  fresh=extensionHarness(runtime,{reset:false,label:'fresh'});
  await fresh.emit('session_start',{},eventContext());
  await options.withSession({newSession:async()=>({cancelled:false})});
  return{cancelled:false};
 }});
 await flush();
 assert.deepEqual(starts,[{options:{ticket:'ABC-1',credentialFile:'/tmp/viq-lane.json'},adapter:'fresh'}]);
 assert.equal(controller.adapter.pi,fresh.pi);assert.equal(typeof controller.adapter.transition.newSession,'function');
});

test('typed viq_take keys one-ticket admission to the native Pi session across new, cancel, resume, and active states',async t=>{
 let state={mode:'stopped',rotation_required:false};const starts=[];
 const runtime={project:null,status:()=>({...state}),async start(options){starts.push(options);state={mode:'working',rotation_required:false};return{episode:{ticket:{id:options.ticket,title:`Exact ${options.ticket}`,claim:{claim_id:'public-claim',generation:1}},history:[{cursor:1,type:'ticket_created'}]}}},async complete(){state={mode:'stopped',rotation_required:true};return{ticket:starts.at(-1).ticket}},rotationCancelled(){state={mode:'stopped',rotation_required:false}}};
 const oldSession={id:'old-used-session',entries:[]},old=extensionHarness(runtime,{label:'old',session:oldSession});t.after(()=>{controller.runtime=null;controller.adapter=null});
 const oldTake=old.tools.get('viq_take'),oldComplete=old.tools.get('viq_complete');assert.ok(oldTake);assert.deepEqual(oldTake.parameters.required,['ticket_id']);assert.equal(oldTake.parameters.additionalProperties,false);assert.equal('token' in oldTake.parameters.properties,false);assert.equal(oldTake.parameters.properties.credential_file.pattern,'^/');
 const first=await oldTake.execute('call-first',{ticket_id:'ABC-1',credential_file:'/tmp/viq-lane.json'},undefined,undefined,toolContext(oldSession));
 assert.deepEqual(starts,[{ticket:'ABC-1',credentialFile:'/tmp/viq-lane.json',deliver:false}]);assert.deepEqual(old.sessionNames,['VIQ ABC-1 · Exact ABC-1']);assert.match(first.content[0].text,/VIQ TICKET CONTRACT[\s\S]*ABC-1[\s\S]*VIQ HISTORY[\s\S]*ticket_created/);assert.doesNotMatch(first.content[0].text,/\/tmp\/viq-lane|secret-token-value/);
 await oldComplete.execute('complete-first',{outcome:'done'},undefined,undefined,toolContext(oldSession));

 const freshSession={id:'fresh-session',entries:[]},fresh=extensionHarness(runtime,{reset:false,label:'fresh',session:freshSession}),freshTake=fresh.tools.get('viq_take');
 const second=await freshTake.execute('call-fresh',{ticket_id:'ABC-2'},undefined,undefined,toolContext(freshSession));
 assert.equal(second.details.ticket_id,'ABC-2','an actual new native session may take after completion');
 await assert.rejects(freshTake.execute('call-active',{ticket_id:'ABC-3'},undefined,undefined,toolContext(freshSession)),/viq_episode_reuse_forbidden/);
 await fresh.tools.get('viq_complete').execute('complete-second',{outcome:'done'},undefined,undefined,toolContext(freshSession));

 await old.commands.get('viq').handler('take ABC-3',{ui:{notify(){}},async newSession(){return{cancelled:true}}});
 await assert.rejects(oldTake.execute('call-after-cancel',{ticket_id:'ABC-3'},undefined,undefined,toolContext(oldSession)),/viq_episode_reuse_forbidden/);
 const resumed=extensionHarness(runtime,{reset:false,label:'resumed-old',session:oldSession});
 await assert.rejects(resumed.tools.get('viq_take').execute('call-resumed',{ticket_id:'ABC-3'},undefined,undefined,toolContext(oldSession)),/viq_episode_reuse_forbidden/);
 assert.deepEqual(starts.map(start=>start.ticket),['ABC-1','ABC-2']);
});

test('viq_complete is typed, calls runtime direct completion, terminates, and leaves legacy submit registered',async t=>{
 const calls=[],runtime={status:()=>({mode:'working'}),async complete(input){calls.push(input);return{ticket:'ABC-1'}}};
 const h=extensionHarness(runtime);t.after(()=>{controller.runtime=null;controller.adapter=null});
 const complete=h.tools.get('viq_complete');assert.ok(complete);assert.ok(h.tools.has('viq_submit'));
 assert.deepEqual(complete.parameters.required,['outcome']);assert.equal(complete.parameters.additionalProperties,false);assert.equal(complete.parameters.properties.outcome.maxLength,1000);assert.equal(complete.parameters.properties.evidence.items.type,'string');assert.equal(complete.parameters.properties.evidence.maxItems,50);
 const result=await complete.execute('call-1',{outcome:'Implemented and tested.',evidence:['urn:test:focused','opaque-build-42']});
 assert.deepEqual(calls,[{outcome:'Implemented and tested.',evidence:['urn:test:focused','opaque-build-42']}]);assert.equal(result.terminate,true);assert.equal(result.content[0].text,'Completed ABC-1');assert.doesNotMatch(result.content[0].text,/urn:test|opaque-build/);
});

test('ticket rotation creates blank persisted Pi sessions without fork inputs',async()=>{
 const source=await readFile(new URL('../extensions/viq-worker/index.ts',import.meta.url),'utf8');
 assert.equal((source.match(/\.newSession\(\{withSession:replacement\}\)/g)??[]).length,3);
 assert.doesNotMatch(source,/parentSession|sessionManager\.getSessionFile|\bsetup\s*:|ReplacedSessionContext/);
 assert.match(source,/type TransitionContext=Pick<ExtensionCommandContext,'newSession'>/);
 assert.match(source,/setSessionName\(`VIQ \$\{ticket\.id\}/);
});

test('controller carries no prior ticket prompt, history, tool, or summary state',async()=>{
 const source=await readFile(new URL('../extensions/viq-worker/controller.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/prompt|history|tool|summary|parent|fork|branch/i);
 assert.match(source,/epoch.*adapter.*persistent.*pendingStart.*rotating.*runtime/);
});
