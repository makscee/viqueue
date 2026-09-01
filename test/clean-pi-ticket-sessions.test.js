import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import viqWorker from '../extensions/viq-worker/index.ts';
import { controller } from '../extensions/viq-worker/controller.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));

function extensionHarness(runtime){
 const handlers=new Map(),commands=new Map();
 const pi={
  on(name,handler){handlers.set(name,handler)},
  registerCommand(name,command){commands.set(name,command)},
  registerTool(){},
  setSessionName(){},
  sendUserMessage(){throw new Error('empty queue must not create a model turn')}
 };
 controller.epoch=0;controller.adapter=null;controller.persistent=false;controller.pendingStart=false;controller.rotating=false;controller.runtime=runtime;
 viqWorker(pi);
 const emit=async(name,event={},ctx={})=>handlers.get(name)?.(event,ctx);
 return{commands,emit,pi};
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

test('ticket rotation creates blank persisted Pi sessions without fork inputs',async()=>{
 const source=await readFile(new URL('../extensions/viq-worker/index.ts',import.meta.url),'utf8');
 assert.equal((source.match(/\.newSession\(\{withSession:replacement\}\)/g)??[]).length,2);
 assert.doesNotMatch(source,/parentSession|sessionManager\.getSessionFile|\bsetup\s*:|ReplacedSessionContext/);
 assert.match(source,/type TransitionContext=Pick<ExtensionCommandContext,'newSession'>/);
 assert.match(source,/setSessionName\(`VIQ \$\{ticket\.id\}/);
});

test('controller carries no prior ticket prompt, history, tool, or summary state',async()=>{
 const source=await readFile(new URL('../extensions/viq-worker/controller.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/prompt|history|tool|summary|parent|fork|branch/i);
 assert.match(source,/epoch.*adapter.*persistent.*pendingStart.*rotating.*runtime/);
});
