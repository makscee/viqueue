import http from 'node:http';
import { closeSync, constants, fchmodSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const CONFIRM='FULL_PROJECT_TICKET_CLEAN_SLATE';
const fail=(message,code='operator_usage')=>{throw Object.assign(new Error(message),{code})};
const option=(args,name,{required=false}={})=>{const found=args.flatMap((v,i)=>v===name?[i]:[]);if(found.length>1)fail(`${name} may be supplied only once`);const value=found.length?args[found[0]+1]:undefined;if(found.length&&(!value||value.startsWith('--')))fail(`${name} requires a value`);if(required&&!value)fail(`${name} is required`);return value};
function reserve(file){const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_CLOEXEC,0o600);let done=false;return{commit(value){try{fchmodSync(fd,0o600);writeSync(fd,`${JSON.stringify(value)}\n`);fsyncSync(fd);closeSync(fd);done=true}catch(error){try{closeSync(fd)}catch{}try{unlinkSync(file)}catch{}done=true;throw error}},abort(){if(done)return;try{closeSync(fd)}finally{try{unlinkSync(file)}catch{}done=true}}}};
function localRequest(socketPath,requestPath,payload,expectedStatus){return new Promise((resolve,reject)=>{const raw=JSON.stringify(payload);const request=http.request({socketPath,path:requestPath,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(raw)},agent:false},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;if(body.length>8192)request.destroy(Object.assign(new Error('operator response too large'),{code:'operator_invalid_response'}))});response.on('end',()=>{let parsed;try{parsed=body?JSON.parse(body):{}}catch{return reject(Object.assign(new Error('local operator returned invalid JSON'),{code:'operator_invalid_response'}))}if(response.statusCode!==expectedStatus)return reject(Object.assign(new Error(parsed.error?.code??'local operator request failed'),{code:parsed.error?.code??'operator_request_failed'}));resolve(parsed)})});request.setTimeout(5000,()=>request.destroy(Object.assign(new Error('local operator request timed out'),{code:'operator_timeout'})));request.on('error',error=>reject(Object.assign(new Error(error.code??'local operator unavailable'),{code:'operator_unavailable'})));request.end(raw)});}
export async function runOperatorCommand(args,{request,socketPath='/run/viqueue-alpha/operator.sock'}={}){
  if(args[0]==='projects-tickets'&&args[1]==='clean-slate'){
    const rest=args.slice(2);if(rest.length!==2||rest[0]!=='--confirm'||rest[1]!==CONFIRM)fail(`usage: viq operator projects-tickets clean-slate --confirm ${CONFIRM}`);
    const result=await (request?request(socketPath,CONFIRM):localRequest(socketPath,'/v1/operator/projects-tickets/clean-slate',{confirm:CONFIRM},200));
    if(result?.success!==true||!result.removed||Object.values(result.removed).some(value=>!Number.isSafeInteger(value)||value<0))fail('local operator returned an inconsistent clean-slate result','operator_invalid_response');
    return result;
  }
  if(args[0]!=='pairing'||args[1]!=='create')fail('usage: viq operator pairing create --kind browser --name NAME --output FILE');
  const rest=args.slice(2),allowed=['--kind','--name','--output'];for(let i=0;i<rest.length;i+=2)if(!allowed.includes(rest[i])||!rest[i+1]||rest[i+1].startsWith('--'))fail('invalid operator command options');
  if(option(rest,'--kind',{required:true})!=='browser')fail('--kind must be browser (Worker handoffs use device pair-code)');
  const name=option(rest,'--name',{required:true}).trim();if(!name||name.length>200||/[\u0000-\u001f\u007f]/.test(name))fail('--name must contain 1-200 printable characters');
  const output=path.resolve(option(rest,'--output',{required:true})),reserved=reserve(output);
  try{const issued=await (request?request(socketPath,name):localRequest(socketPath,'/v1/operator/browser-pairings',{name},201));if(typeof issued.code!=='string'||!issued.code||typeof issued.device_id!=='string'||!issued.device_id||issued.device_name!==name||!Number.isSafeInteger(issued.expires_at))fail('local operator returned an inconsistent pairing handoff','operator_invalid_response');const bundle={code:issued.code,device_id:issued.device_id,device_name:issued.device_name,expires_at:issued.expires_at};reserved.commit(bundle);return{output,expires_at:bundle.expires_at}}catch(error){reserved.abort();throw error}
}
