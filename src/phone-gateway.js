import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AuthStore } from './phone-auth-store.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../web');
const PUBLIC=new Set(['/','/phone-bootstrap.js','/app.css','/app.js','/health']);
const DEVICE_ID=/^[A-Za-z0-9_-]{16,100}$/;
const json=(res,status,value)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(value)+'\n')};
const secure=(res)=>{res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");res.setHeader('x-frame-options','DENY');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('cache-control','no-store')};
async function body(req,limit){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>limit)throw Object.assign(new Error('too large'),{status:413,limit});chunks.push(c)}return Buffer.concat(chunks)}
const parse=(b)=>{try{return JSON.parse(b)}catch{throw Object.assign(new Error('invalid request'),{status:400})}};
const blocked=new Set(['authorization','cookie','host','forwarded','via','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-viq-device','x-viq-challenge','x-viq-signature']);
const responseBlocked=new Set([...blocked,'set-cookie']);
function requestTarget(req){const raw=req.url;if(typeof raw!=='string'||raw.length>2048)throw Object.assign(new Error(),{status:414});if(!raw.startsWith('/')||raw.startsWith('//')||/[\\\x00-\x1f\x7f#]/.test(raw)||/%(?![0-9a-f]{2})/i.test(raw)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c)/i.test(raw))throw Object.assign(new Error(),{status:400});return raw}

export async function createPhoneGateway({authDb,origin,upstream,cert,key,tlsTerminated=false,testMode=false,now}={}){
 if(Boolean(cert)!==Boolean(key))throw new Error('complete HTTPS certificate and key required');
 if(!cert&&!tlsTerminated&&!testMode)throw new Error('HTTPS certificate/key or explicit external TLS termination required');
 const target=new URL(upstream);if(target.protocol!=='http:'||!['127.0.0.1','localhost','::1'].includes(target.hostname)||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw new Error('fixed loopback HTTP upstream required');
 const store=await new AuthStore(authDb,{origin,now}).init();const buckets=new Map(),WINDOW=60000,MAX_BUCKETS=1024;
 const prune=(t)=>{for(const[k,v]of buckets)if(t-v.t>=WINDOW)buckets.delete(k);while(buckets.size>=MAX_BUCKETS)buckets.delete(buckets.keys().next().value)};
 const hit=(key)=>{const t=Date.now();prune(t);const v=buckets.get(key)||{t,n:0};if(t-v.t>=WINDOW){v.t=t;v.n=0}v.n++;buckets.delete(key);buckets.set(key,v);return v.n>120};
 const sourceLimited=(req)=>hit(`ip:${req.socket.remoteAddress||'unknown'}`);
 const deviceLimited=(device)=>DEVICE_ID.test(device)&&hit(`device:${device}`);
 const handler=async(req,res)=>{secure(res);try{const rawTarget=requestTarget(req),pathOnly=rawTarget.split('?',1)[0];
  if(req.method==='GET'&&rawTarget==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end(await readFile(path.join(root,'phone-index.html')))}
  if(req.method==='GET'&&['/phone-bootstrap.js','/app.css','/app.js'].includes(rawTarget)){res.setHeader('content-type',rawTarget.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');return res.end(await readFile(path.join(root,rawTarget.slice(1))))}
  if(req.method==='POST'&&rawTarget==='/__phone/pair'){if(sourceLimited(req))throw Object.assign(new Error(),{status:429});const data=parse(await body(req,8192));if(deviceLimited(data?.device_id))throw Object.assign(new Error(),{status:429});return json(res,200,store.consumePair(data))}
  if(req.method==='POST'&&rawTarget==='/__phone/challenge'){if(sourceLimited(req))throw Object.assign(new Error(),{status:429});const data=parse(await body(req,8192));if(deviceLimited(data?.device_id))throw Object.assign(new Error(),{status:429});return json(res,200,store.challenge(data))}
  if(pathOnly.startsWith('/__phone/'))throw Object.assign(new Error(),{status:404});
  const isApi=pathOnly.startsWith('/v1/');if(!isApi&&!PUBLIC.has(rawTarget))throw Object.assign(new Error(),{status:404});
  const raw=await body(req,1048576);if(isApi){if(sourceLimited(req))throw Object.assign(new Error(),{status:429});const d=req.headers['x-viq-device'];if(typeof d==='string'&&deviceLimited(d))throw Object.assign(new Error(),{status:429});const id=req.headers['x-viq-challenge'],sig=req.headers['x-viq-signature'];if([d,id,sig].some(x=>typeof x!=='string'||x.length>512))throw new Error();store.authorize({id,device_id:d,signature:sig,method:req.method,target:rawTarget,body:raw})}
  const headers={},connectionTokens=new Set(String(req.headers.connection||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean));for(const [k,v]of Object.entries(req.headers)){if(!blocked.has(k)&&!connectionTokens.has(k)&&!k.startsWith('x-viq-')&&!k.startsWith('x-forwarded-')&&v!==undefined)headers[k]=v}headers['content-length']=String(raw.length);
  const proxy=http.request({hostname:target.hostname,port:target.port,path:rawTarget,method:req.method,headers},up=>{res.statusCode=up.statusCode;const responseTokens=new Set(String(up.headers.connection||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean));for(const[k,v]of Object.entries(up.headers))if(!responseBlocked.has(k)&&!responseTokens.has(k)&&!k.startsWith('x-forwarded-')&&v!==undefined)res.setHeader(k,v);secure(res);up.pipe(res)});proxy.on('error',()=>json(res,502,{error:{code:'upstream_unavailable',message:'upstream unavailable'}}));proxy.end(raw);
 }catch(e){const status=e.status||403,message=status===413?`request body exceeds ${e.limit===8192?'8KiB':'1MiB'}`:'authorization failed';json(res,status,{error:{code:status===413?'body_too_large':'authorization_failed',message}})}};
 const server=cert&&key?https.createServer({cert,key},handler):http.createServer(handler);server.authStore=store;server.rateLimitBuckets=buckets;server.on('close',()=>store.close());return server;
}
export async function runPhoneGateway(o){const s=await createPhoneGateway(o);const port=Number(o.port||7443);s.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({event:'phone_gateway_listening',url:o.origin})));return s}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const a=Object.fromEntries(process.argv.slice(2).map(x=>{const[k,...v]=x.replace(/^--/,'').split('=');return[k.replaceAll('-','_'),v.join('=')]}));await runPhoneGateway({authDb:a.auth_db,origin:a.origin,upstream:a.upstream,cert:a.cert?await readFile(a.cert):null,key:a.key?await readFile(a.key):null,port:a.port,tlsTerminated:a.tls_terminated==='true'})}
