import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPhoneGateway, isTailscaleAddress } from '../src/phone-gateway.js';

const listen=(server,host='127.0.0.1')=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,()=>{server.off('error',reject);resolve()})});
const close=server=>new Promise(resolve=>server.close(resolve));
const baseOptions=(dir,overrides={})=>({authDb:path.join(dir,'auth.sqlite'),origin:'https://phone.test',upstream:'https://cc-worker.twin-pogona.ts.net',upstreamAddressPolicy:'tailscale',tlsTerminated:true,...overrides});
const resolveAnswers=answers=>(hostname,options,callback)=>{assert.equal(hostname,'cc-worker.twin-pogona.ts.net');assert.equal(options.all,true);callback(null,answers)};

async function rejectsOrigin(upstream,policy='tailscale'){
 const dir=await mkdtemp(path.join(os.tmpdir(),'viq-origin-'));
 try{await assert.rejects(createPhoneGateway(baseOptions(dir,{upstream,upstreamAddressPolicy:policy})));}finally{await rm(dir,{recursive:true,force:true})}
}

test('remote HTTP is denied regardless of address policy',async()=>{
 await rejectsOrigin('http://cc-worker.twin-pogona.ts.net');
 await rejectsOrigin('http://cc-worker.twin-pogona.ts.net','tailscale');
});

test('remote HTTPS requires the single named tailscale policy',async()=>{
 await rejectsOrigin('https://cc-worker.twin-pogona.ts.net',null);
 await rejectsOrigin('https://cc-worker.twin-pogona.ts.net','anything');
});

test('remote origin rejects literals and all authority/resource substitutions',async()=>{
 for(const value of [
  'https://100.64.0.1','https://[fd7a:115c:a1e0::1]','https://user@cc-worker.twin-pogona.ts.net',
  'https://cc-worker.twin-pogona.ts.net/path','https://cc-worker.twin-pogona.ts.net/?query=1',
  'https://cc-worker.twin-pogona.ts.net/#fragment','https://cc-worker.twin-pogona.ts.net/?','https://cc-worker.twin-pogona.ts.net/#',
  'https://@cc-worker.twin-pogona.ts.net','https://cc-worker.twin-pogona.ts.net/%2e','https://cc-worker.twin-pogona.ts.net:444',
 ])await rejectsOrigin(value);
});

test('Tailscale CIDR boundaries are exact for IPv4 and canonical IPv6 ULA',()=>{
 assert.equal(isTailscaleAddress('100.64.0.0',4),true);assert.equal(isTailscaleAddress('100.127.255.255',4),true);
 assert.equal(isTailscaleAddress('100.63.255.255',4),false);assert.equal(isTailscaleAddress('100.128.0.0',4),false);
 assert.equal(isTailscaleAddress('fd7a:115c:a1e0::',6),true);assert.equal(isTailscaleAddress('fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff',6),true);
 assert.equal(isTailscaleAddress('fd7a:115c:a1df:ffff::1',6),false);assert.equal(isTailscaleAddress('::ffff:100.64.0.1',6),false);
});

test('resolver rejects empty, outside, mixed, DNS errors, and family/type confusion',async()=>{
 const cases=[
  [],
  [{address:'192.0.2.1',family:4}],
  [{address:'100.64.0.1',family:4},{address:'2001:db8::1',family:6}],
  [{address:'100.64.0.1',family:6}],
  [{address:'fd7a:115c:a1e0::1',family:4}],
  [{address:'not-an-ip',family:4}],
 ];
 for(const answers of cases){
  const dir=await mkdtemp(path.join(os.tmpdir(),'viq-dns-'));
  const gateway=await createPhoneGateway(baseOptions(dir,{testMode:true,tlsTerminated:false,testHooks:{dnsLookup:resolveAnswers(answers),connectAddress:'127.0.0.1'}}));
  await listen(gateway);
  try{assert.equal((await fetch(`http://127.0.0.1:${gateway.address().port}/health`)).status,502,JSON.stringify(answers));}finally{await close(gateway);await rm(dir,{recursive:true,force:true})}
 }
 const dir=await mkdtemp(path.join(os.tmpdir(),'viq-dnserr-'));
 const dnsLookup=(_hostname,_options,callback)=>callback(Object.assign(new Error('dns failed'),{code:'EAI_AGAIN'}));
 const gateway=await createPhoneGateway(baseOptions(dir,{testMode:true,tlsTerminated:false,testHooks:{dnsLookup,connectAddress:'127.0.0.1'}}));
 await listen(gateway);
 try{assert.equal((await fetch(`http://127.0.0.1:${gateway.address().port}/health`)).status,502)}finally{await close(gateway);await rm(dir,{recursive:true,force:true})}
 const timeoutDir=await mkdtemp(path.join(os.tmpdir(),'viq-dnstimeout-'));
 const timeoutGateway=await createPhoneGateway(baseOptions(timeoutDir,{testMode:true,tlsTerminated:false,testHooks:{dnsLookup:()=>{},dnsTimeoutMs:10,requestTimeoutMs:100}}));await listen(timeoutGateway);
 try{assert.equal((await fetch(`http://127.0.0.1:${timeoutGateway.address().port}/health`)).status,502)}finally{await close(timeoutGateway);await rm(timeoutDir,{recursive:true,force:true})}
});

test('validated answer is bound to the socket with no second resolution and every request gets a new connection',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'viq-bind-'));let resolutions=0;const connected=[];
 const dnsLookup=(hostname,options,callback)=>{resolutions++;const answer={address:'100.100.100.100',family:4};resolveAnswers([answer])(hostname,options,callback);answer.address='192.0.2.9'};
 const connect=(options)=>{connected.push({host:options.host,family:options.family,servername:options.servername,rejectUnauthorized:options.rejectUnauthorized});const socket=new tls.TLSSocket();queueMicrotask(()=>socket.destroy(new Error('fixture stop')));return socket};
 const gateway=await createPhoneGateway(baseOptions(dir,{testMode:true,tlsTerminated:false,testHooks:{dnsLookup,tlsConnect:connect}}));await listen(gateway);
 try{await Promise.all([1,2,3].map(()=>fetch(`http://127.0.0.1:${gateway.address().port}/health`)));assert.equal(resolutions,3);assert.deepEqual(connected,[1,2,3].map(()=>({host:'100.100.100.100',family:4,servername:'cc-worker.twin-pogona.ts.net',rejectUnauthorized:true})));}finally{await close(gateway);await rm(dir,{recursive:true,force:true})}
});

async function tlsFixture(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'viq-tls-upstream-'));
 await writeFile(path.join(dir,'openssl.cnf'),`[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=viq test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`);
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',path.join(dir,'openssl.cnf'),'-keyout',path.join(dir,'ca.key'),'-out',path.join(dir,'ca.pem')],{stdio:'ignore'});
 const issue=name=>execFileSync('openssl',['req','-newkey','rsa:2048','-nodes','-subj',`/CN=${name}`,'-keyout',path.join(dir,`${name}.key`),'-out',path.join(dir,`${name}.csr`)],{stdio:'ignore'});
 issue('good');issue('wrong');
 await Promise.all(['good','wrong'].map(async name=>{await writeFile(path.join(dir,`${name}.ext`),`subjectAltName=DNS:${name==='good'?'cc-worker.twin-pogona.ts.net':'other.twin-pogona.ts.net'}\nextendedKeyUsage=serverAuth\n`);execFileSync('openssl',['x509','-req','-days','1','-in',path.join(dir,`${name}.csr`),'-CA',path.join(dir,'ca.pem'),'-CAkey',path.join(dir,'ca.key'),'-CAcreateserial','-extfile',path.join(dir,`${name}.ext`),'-out',path.join(dir,`${name}.pem`)],{stdio:'ignore'})}));
 return{dir,ca:await readFile(path.join(dir,'ca.pem')),good:{key:await readFile(path.join(dir,'good.key')),cert:await readFile(path.join(dir,'good.pem'))},wrong:{key:await readFile(path.join(dir,'wrong.key')),cert:await readFile(path.join(dir,'wrong.pem'))}};
}

async function fixtureRequest(material,{proxyEnv=false,redirect=false}={}){
 const upstream=https.createServer(material,(req,res)=>{if(redirect){res.statusCode=302;res.setHeader('location','https://evil.example/steal');return res.end('redirect')}res.end(JSON.stringify({method:req.method,url:req.url,host:req.headers.host,forwarded:req.headers.forwarded,realIp:req.headers['x-real-ip'],cfIp:req.headers['cf-connecting-ip'],proxyConnection:req.headers['proxy-connection'],authorization:req.headers.authorization}))});await listen(upstream);
 const dir=await mkdtemp(path.join(os.tmpdir(),'viq-tls-gw-'));let dnsCalls=0;
 const dnsLookup=(_hostname,options,callback)=>{dnsCalls++;assert.equal(options.all,true);callback(null,[{address:'100.64.0.7',family:4}])};
 const gateway=await createPhoneGateway(baseOptions(dir,{testMode:true,tlsTerminated:false,testHooks:{dnsLookup,connectAddress:'127.0.0.1',connectPort:upstream.address().port}}));await listen(gateway);
 const old={HTTP_PROXY:process.env.HTTP_PROXY,HTTPS_PROXY:process.env.HTTPS_PROXY,http_proxy:process.env.http_proxy,https_proxy:process.env.https_proxy};if(proxyEnv)Object.assign(process.env,{HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',http_proxy:'http://127.0.0.1:1',https_proxy:'http://127.0.0.1:1'});
 return{dir,upstream,gateway,get dnsCalls(){return dnsCalls},async cleanup(){Object.assign(process.env,Object.fromEntries(Object.entries(old).map(([k,v])=>[k,v??''])));await close(gateway);await close(upstream);await rm(dir,{recursive:true,force:true})}};
}

test('exact TLS fixture preserves target/method, ignores proxy env, strips authority headers, and does not follow redirects',async()=>{
 const certs=await tlsFixture();tls.setDefaultCACertificates([...tls.getCACertificates('default'),certs.ca.toString()]);
 try{
  const f=await fixtureRequest(certs.good,{proxyEnv:true});try{const response=await fetch(`http://127.0.0.1:${f.gateway.address().port}/health`,{method:'POST',headers:{host:'evil.example',forwarded:'for=bad','x-real-ip':'192.0.2.1','cf-connecting-ip':'192.0.2.2','proxy-connection':'keep-alive',authorization:'Bearer bad'}});assert.equal(response.status,200);const received=await response.json();assert.deepEqual(received,{method:'POST',url:'/health',host:'cc-worker.twin-pogona.ts.net'});for(const name of ['forwarded','realIp','cfIp','proxyConnection','authorization'])assert.equal(received[name],undefined);assert.equal(f.dnsCalls,1)}finally{await f.cleanup()}
  const r=await fixtureRequest(certs.good,{redirect:true});try{const response=await fetch(`http://127.0.0.1:${r.gateway.address().port}/health`,{redirect:'manual'});assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://evil.example/steal');assert.equal(r.dnsCalls,1)}finally{await r.cleanup()}
 }finally{await rm(certs.dir,{recursive:true,force:true})}
});

test('standard CA and hostname verification reject untrusted and wrong-host certificates',async()=>{
 const certs=await tlsFixture();
 try{
  tls.setDefaultCACertificates(tls.getCACertificates('default'));const untrusted=await fixtureRequest(certs.good);try{assert.equal((await fetch(`http://127.0.0.1:${untrusted.gateway.address().port}/health`)).status,502)}finally{await untrusted.cleanup()}
  tls.setDefaultCACertificates([...tls.getCACertificates('default'),certs.ca.toString()]);const wrong=await fixtureRequest(certs.wrong);try{assert.equal((await fetch(`http://127.0.0.1:${wrong.gateway.address().port}/health`)).status,502)}finally{await wrong.cleanup()}
 }finally{await rm(certs.dir,{recursive:true,force:true})}
});
