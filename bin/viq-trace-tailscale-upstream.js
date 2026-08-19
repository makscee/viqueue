#!/usr/bin/env node
import dns from 'node:dns';
import https from 'node:https';
import { isTailscaleAddress } from '../src/phone-gateway.js';

const USAGE = `Usage: viq-trace-tailscale-upstream --origin=https://HOST [--path=/PATH ...]\n       VIQ_TAILSCALE_UPSTREAM_ORIGIN=https://HOST viq-trace-tailscale-upstream\n`;
const args = process.argv.slice(2);
let originValue = process.env.VIQ_TAILSCALE_UPSTREAM_ORIGIN || '';
const paths = [];
const usageError = message => {
  console.error(`Error: ${message}`);
  console.error(USAGE.trimEnd());
  process.exit(2);
};
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help') {
    console.log(USAGE.trimEnd());
    process.exit(0);
  }
  if (arg === '--origin' || arg === '--path') {
    const value = args[index += 1];
    if (!value) usageError(`${arg} requires a value`);
    if (arg === '--origin') originValue = value;
    else paths.push(value);
  } else if (arg.startsWith('--origin=')) originValue = arg.slice('--origin='.length);
  else if (arg.startsWith('--path=')) paths.push(arg.slice('--path='.length));
  else usageError(`unknown option: ${arg}`);
}
if (!originValue) usageError('supply --origin or VIQ_TAILSCALE_UPSTREAM_ORIGIN');
let origin;
try {
  origin = new URL(originValue);
} catch {
  usageError('origin must be a valid HTTPS origin');
}
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  usageError('origin must be an HTTPS origin without credentials, path, query, or fragment');
}
const ORIGIN = origin.origin;
const PATHS = paths.length ? paths : ['/health', '/v1/projects'];
if (PATHS.some(requestPath => !requestPath.startsWith('/') || requestPath.startsWith('//') || requestPath.includes('#'))) {
  usageError('each probe path must be a root-relative path');
}
const answers=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('DNS timeout')),3000);
 dns.lookup(origin.hostname,{all:true,verbatim:true},(error,value)=>{clearTimeout(timer);error?reject(error):resolve(value)});
});
if(!Array.isArray(answers)||answers.length===0||answers.some(({address,family})=>!isTailscaleAddress(address,family)))throw new Error('origin did not resolve exclusively to Tailscale addresses');
const pinned=Object.freeze(answers.map(answer=>Object.freeze({...answer})));
const lookup=(hostname,options,callback)=>{
 if(hostname!==origin.hostname)return callback(new Error('unexpected hostname'));
 if(options.all)return callback(null,pinned);
 callback(null,pinned[0].address,pinned[0].family);
};
for(const requestPath of PATHS){
 const result=await new Promise((resolve,reject)=>{
  const request=https.request(ORIGIN+requestPath,{method:'GET',agent:false,lookup,headers:{accept:'application/json'}},response=>{
   let bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576)request.destroy(new Error('response too large'))});response.on('end',()=>resolve({path:requestPath,status:response.statusCode,location:response.headers.location??null,bytes}));
  });
  const timer=setTimeout(()=>request.destroy(new Error('request timeout')),10000);request.on('close',()=>clearTimeout(timer));request.on('error',reject);request.end();
 });
 console.log(JSON.stringify({...result,addresses:pinned}));
 if(result.status<200||result.status>=400)process.exitCode=1;
}
