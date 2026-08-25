#!/usr/bin/env node
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore } from './phone-auth-store.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../web');
const PUBLIC=new Set(['/','/favicon.ico','/phone-bootstrap.js','/app.css','/app.js','/ui-core.js','/health']);
const DEVICE_ID=/^[A-Za-z0-9_-]{16,100}$/;
const DNS_TIMEOUT_MS=3000,CONNECT_TIMEOUT_MS=5000,REQUEST_TIMEOUT_MS=15000,MAX_DNS_ANSWERS=16,MAX_AUTHORIZATION_FILE_BYTES=513;
const unsafeCredential=()=>new Error('unsafe upstream authorization credential file');
export async function loadUpstreamAuthorization(file,{expectedUid=process.geteuid?.(),afterOpen}={}){
 if(typeof file!=='string'||!file||!Number.isInteger(expectedUid)||fsConstants.O_NOFOLLOW===undefined)throw unsafeCredential();
 const flags=fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|(fsConstants.O_CLOEXEC??0)|(fsConstants.O_NONBLOCK??0);let handle;
 try{
  handle=await open(file,flags);const before=await handle.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(expectedUid)||(before.mode&0o77n)!==0n||before.size<1n||before.size>BigInt(MAX_AUTHORIZATION_FILE_BYTES))throw unsafeCredential();
  if(afterOpen)await afterOpen();
  const bytes=await handle.readFile();const after=await handle.stat({bigint:true});
  if(before.dev!==after.dev||before.ino!==after.ino||before.nlink!==after.nlink||before.uid!==after.uid||before.mode!==after.mode||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||BigInt(bytes.length)!==before.size)throw unsafeCredential();
  if(bytes.includes(0))throw unsafeCredential();let value=bytes.toString('utf8');if(value.endsWith('\n'))value=value.slice(0,-1);
  if(!/^[\x21-\x7e]{16,512}$/.test(value)||value.includes('\r')||value.includes('\n'))throw unsafeCredential();return value;
 }catch(error){if(error?.message==='unsafe upstream authorization credential file')throw error;throw unsafeCredential()}finally{await handle?.close().catch(()=>{})}
}
const json=(res,status,value)=>{if(res.headersSent)return res.destroy();res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(value)+'\n')};
const secure=(res)=>{res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");res.setHeader('x-frame-options','DENY');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('cache-control','no-store')};
async function body(req,limit){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>limit)throw Object.assign(new Error('too large'),{status:413,limit});chunks.push(c)}return Buffer.concat(chunks)}
const parse=(b)=>{try{return JSON.parse(b)}catch{throw Object.assign(new Error('invalid request'),{status:400})}};
const blocked=new Set(['authorization','cookie','host','forwarded','via','connection','keep-alive','proxy-authenticate','proxy-authorization','proxy-connection','te','trailer','transfer-encoding','upgrade','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip','cf-connecting-ip','true-client-ip','fastly-client-ip','x-client-ip','x-cluster-client-ip','x-viq-device','x-viq-challenge','x-viq-signature']);
const responseBlocked=new Set([...blocked,'set-cookie']);
function requestTarget(req){const raw=req.url;if(typeof raw!=='string'||raw.length>2048)throw Object.assign(new Error(),{status:414});if(!raw.startsWith('/')||raw.startsWith('//')||/[\\\x00-\x1f\x7f#]/.test(raw)||/%(?![0-9a-f]{2})/i.test(raw)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c)/i.test(raw))throw Object.assign(new Error(),{status:400});return raw}

function parseIpv6(value){
 if(value.includes('%')||net.isIP(value)!==6)return null;
 const halves=value.split('::');if(halves.length>2)return null;
 const parseHalf=half=>half?half.split(':').map(x=>Number.parseInt(x,16)):[];
 const left=parseHalf(halves[0]),right=parseHalf(halves[1]??'');
 const missing=8-left.length-right.length;if((halves.length===1&&missing!==0)||(halves.length===2&&missing<1))return null;
 return [...left,...Array(missing).fill(0),...right];
}
export function isTailscaleAddress(address,family){
 if(family===4&&net.isIP(address)===4){const p=address.split('.').map(Number),n=((p[0]<<24)|(p[1]<<16)|(p[2]<<8)|p[3])>>>0;return (n&0xffc00000)===0x64400000}
 if(family===6){const p=parseIpv6(address);return Boolean(p&&p[0]===0xfd7a&&p[1]===0x115c&&p[2]===0xa1e0)}
 return false;
}
function parseUpstream(upstream,policy){
 let target;try{target=new URL(upstream)}catch{throw new Error('valid fixed upstream origin required')}
 const rootOnly=!target.username&&!target.password&&target.pathname==='/'&&!target.search&&!target.hash;
 const loopback=['127.0.0.1','localhost','[::1]'].includes(target.hostname);
 if(target.protocol==='http:'&&loopback&&rootOnly&&!policy)return{target,mode:'loopback'};
 const dnsName=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target.hostname);
 const canonical=`https://${target.hostname}`,exact=[canonical,`${canonical}/`,`${canonical}:443`,`${canonical}:443/`].includes(upstream);
 if(target.protocol!=='https:'||policy!=='tailscale'||!rootOnly||!exact||!dnsName||net.isIP(target.hostname)!==0||target.port)throw new Error('remote upstream requires an exact HTTPS DNS origin and --upstream-address-policy=tailscale');
 return{target,mode:'tailscale'};
}
function resolveTailscale(hostname,dnsLookup,timeoutMs=DNS_TIMEOUT_MS){
 return new Promise((resolve,reject)=>{
  let settled=false;const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value)};
  const timer=setTimeout(()=>finish(reject,new Error('upstream DNS timeout')),timeoutMs);
  try{dnsLookup(hostname,{all:true,verbatim:true},(error,answers)=>{
   if(error)return finish(reject,error);
   if(!Array.isArray(answers)||answers.length===0||answers.length>MAX_DNS_ANSWERS)return finish(reject,new Error('unsafe upstream DNS answer set'));
   const unique=[];for(const answer of answers){if(!answer||typeof answer.address!=='string'||!isTailscaleAddress(answer.address,answer.family))return finish(reject,new Error('unsafe upstream DNS answer set'));if(!unique.some(x=>x.address===answer.address&&x.family===answer.family))unique.push(Object.freeze({address:answer.address,family:answer.family}))}
   finish(resolve,Object.freeze(unique));
  })}catch(error){finish(reject,error)}
 });
}
function remoteAgent(target,testHooks={}){
 const dnsLookup=testHooks.dnsLookup??dns.lookup,tlsConnect=testHooks.tlsConnect??tls.connect;
 const agent=new https.Agent({keepAlive:false,maxSockets:1});
 agent.createConnection=(options,callback)=>{
  if(options.servername!==target.hostname&&options.hostname!==target.hostname)return callback(new Error('unexpected upstream authority'));
  resolveTailscale(target.hostname,dnsLookup,testHooks.dnsTimeoutMs).then(answers=>{
   const selected=answers[0];let socket;
   try{socket=tlsConnect({host:testHooks.connectAddress??selected.address,port:testHooks.connectPort??443,family:selected.family,servername:target.hostname,rejectUnauthorized:true,ALPNProtocols:['http/1.1']})}catch(error){return callback(error)}
   const timer=setTimeout(()=>socket.destroy(new Error('upstream connect timeout')),testHooks.connectTimeoutMs??CONNECT_TIMEOUT_MS);
   socket.once('secureConnect',()=>clearTimeout(timer));socket.once('error',()=>clearTimeout(timer));callback(null,socket);
  },callback);
 };
 return agent;
}
function proxyRequest({mode,target,testHooks},options,onResponse){
 if(mode==='loopback')return http.request({...options,hostname:target.hostname,port:target.port||80},onResponse);
 const agent=remoteAgent(target,testHooks);const request=https.request({...options,hostname:target.hostname,port:443,servername:target.hostname,agent},onResponse);request.once('close',()=>agent.destroy());return request;
}

export async function createPhoneGateway({authDb,origin,upstream,upstreamAddressPolicy,upstreamAuthorization,cert,key,tlsTerminated=false,testMode=false,testHooks,now}={}){
 if(upstreamAuthorization!==undefined&&(typeof upstreamAuthorization!=='string'||!/^[\x21-\x7e]{16,512}$/.test(upstreamAuthorization)))throw new Error('valid upstream authorization credential required');
 if(Boolean(cert)!==Boolean(key))throw new Error('complete HTTPS certificate and key required');
 if(!cert&&!tlsTerminated&&!testMode)throw new Error('HTTPS certificate/key or explicit external TLS termination required');
 if(testHooks&&!testMode)throw new Error('test hooks require test mode');
 const route=parseUpstream(upstream,upstreamAddressPolicy);
 const store=await new AuthStore(authDb,{origin,now}).init();const buckets=new Map(),WINDOW=60000,MAX_BUCKETS=1024;
 const prune=(t)=>{for(const[k,v]of buckets)if(t-v.t>=WINDOW)buckets.delete(k);while(buckets.size>=MAX_BUCKETS)buckets.delete(buckets.keys().next().value)};
 const hit=(key)=>{const t=Date.now();prune(t);const v=buckets.get(key)||{t,n:0};if(t-v.t>=WINDOW){v.t=t;v.n=0}v.n++;buckets.delete(key);buckets.set(key,v);return v.n>120};
 const sourceLimited=(req)=>hit(`ip:${req.socket.remoteAddress||'unknown'}`);
 const deviceLimited=(device)=>DEVICE_ID.test(device)&&hit(`device:${device}`);
 const handler=async(req,res)=>{secure(res);try{const rawTarget=requestTarget(req),pathOnly=rawTarget.split('?',1)[0];
  if(req.method==='GET'&&rawTarget==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end(await readFile(path.join(root,'phone-index.html')))}
  if(req.method==='GET'&&rawTarget==='/favicon.ico'){res.statusCode=204;return res.end()}
  if(req.method==='GET'&&['/phone-bootstrap.js','/app.css','/app.js','/ui-core.js'].includes(rawTarget)){res.setHeader('content-type',rawTarget.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');return res.end(await readFile(path.join(root,rawTarget.slice(1))))}
  if(req.method==='POST'&&rawTarget==='/__phone/pair'){if(sourceLimited(req))throw Object.assign(new Error(),{status:429});const data=parse(await body(req,8192));if(deviceLimited(data?.device_id))throw Object.assign(new Error(),{status:429});return json(res,200,store.consumePair(data))}
  if(req.method==='POST'&&rawTarget==='/__phone/challenge'){if(sourceLimited(req))throw Object.assign(new Error(),{status:429});const data=parse(await body(req,8192));if(deviceLimited(data?.device_id))throw Object.assign(new Error(),{status:429});return json(res,200,store.challenge(data))}
  if(req.method==='POST'&&rawTarget==='/__phone/revoke'){if(sourceLimited(req))throw Object.assign(new Error(),{status:429});const raw=await body(req,8192),device=req.headers['x-viq-device'],id=req.headers['x-viq-challenge'],signature=req.headers['x-viq-signature'];if([device,id,signature].some(x=>typeof x!=='string'||x.length>512)||deviceLimited(device))throw new Error();store.authorize({id,device_id:device,signature,method:req.method,target:rawTarget,body:raw});return json(res,200,{revoked:store.revoke(device)})}
  if(pathOnly.startsWith('/__phone/'))throw Object.assign(new Error(),{status:404});
  const isApi=pathOnly.startsWith('/v1/');if(!isApi&&!PUBLIC.has(rawTarget))throw Object.assign(new Error(),{status:404});
  const raw=await body(req,1048576);if(isApi){if(!upstreamAuthorization)throw new Error();if(sourceLimited(req))throw Object.assign(new Error(),{status:429});const d=req.headers['x-viq-device'];if(typeof d==='string'&&deviceLimited(d))throw Object.assign(new Error(),{status:429});const id=req.headers['x-viq-challenge'],sig=req.headers['x-viq-signature'];if([d,id,sig].some(x=>typeof x!=='string'||x.length>512))throw new Error();store.authorize({id,device_id:d,signature:sig,method:req.method,target:rawTarget,body:raw})}
  const headers={},connectionTokens=new Set(String(req.headers.connection||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean));for(const [k,v]of Object.entries(req.headers)){if(!blocked.has(k)&&!connectionTokens.has(k)&&!k.startsWith('x-viq-')&&!k.startsWith('x-forwarded-')&&v!==undefined)headers[k]=v}if(isApi)headers.authorization=`Bearer ${upstreamAuthorization}`;headers['content-length']=String(raw.length);
  let timer;const proxy=proxyRequest({...route,testHooks:testHooks??{}},{path:rawTarget,method:req.method,headers},up=>{res.statusCode=up.statusCode;const responseTokens=new Set(String(up.headers.connection||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean));for(const[k,v]of Object.entries(up.headers))if(!responseBlocked.has(k)&&!responseTokens.has(k)&&!k.startsWith('x-forwarded-')&&v!==undefined)res.setHeader(k,v);secure(res);up.on('error',()=>res.destroy());up.on('end',()=>clearTimeout(timer));up.pipe(res)});timer=setTimeout(()=>proxy.destroy(new Error('upstream request timeout')),testHooks?.requestTimeoutMs??REQUEST_TIMEOUT_MS);proxy.on('error',()=>{clearTimeout(timer);json(res,502,{error:{code:'upstream_unavailable',message:'upstream unavailable'}})});proxy.end(raw);
 }catch(e){const status=e.status||403,pairingMessage=/^pairing code is (?:invalid(?: or already used)?|already used|expired)$/.test(e.message)?e.message:null,message=status===413?`request body exceeds ${e.limit===8192?'8KiB':'1MiB'}`:pairingMessage||'authorization failed';json(res,status,{error:{code:status===413?'body_too_large':'authorization_failed',message}})}};
 const server=cert&&key?https.createServer({cert,key},handler):http.createServer(handler);server.authStore=store;server.rateLimitBuckets=buckets;server.on('close',()=>store.close());return server;
}
export async function runPhoneGateway(o){const s=await createPhoneGateway(o);const port=Number(o.port||7443);s.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({event:'phone_gateway_listening',url:o.origin})));return s}
const gatewayHelp=`Usage: viqueue-phone-gateway --auth-db=PATH --origin=https://PHONE_ORIGIN --upstream=ORIGIN [options]\n\nDefault upstream: loopback HTTP only (for example http://127.0.0.1:7373).\nRemote upstream: exact HTTPS DNS origin plus --upstream-address-policy=tailscale.\nOptions: --upstream-authorization-file=PATH; --cert=PATH --key=PATH | --tls-terminated=true; --port=7443\n`;
if(process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1])){
 if(process.argv.slice(2).includes('--help')){process.stdout.write(gatewayHelp);process.exit(0)}
 const a=Object.fromEntries(process.argv.slice(2).map(x=>{const[k,...v]=x.replace(/^--/,'').split('=');return[k.replaceAll('-','_'),v.join('=')]}));
 await runPhoneGateway({authDb:a.auth_db,origin:a.origin,upstream:a.upstream,upstreamAddressPolicy:a.upstream_address_policy,upstreamAuthorization:a.upstream_authorization_file?await loadUpstreamAuthorization(a.upstream_authorization_file):undefined,cert:a.cert?await readFile(a.cert):null,key:a.key?await readFile(a.key):null,port:a.port,tlsTerminated:a.tls_terminated==='true'});
}
