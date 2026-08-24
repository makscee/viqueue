#!/usr/bin/env node
import dns from 'node:dns';
import https from 'node:https';
import { isTailscaleAddress } from '../src/phone-gateway.js';

const ORIGIN='https://cc-worker.twin-pogona.ts.net';
const PATHS=['/health','/v1/projects'];
const answers=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('DNS timeout')),3000);
 dns.lookup(new URL(ORIGIN).hostname,{all:true,verbatim:true},(error,value)=>{clearTimeout(timer);error?reject(error):resolve(value)});
});
if(!Array.isArray(answers)||answers.length===0||answers.some(({address,family})=>!isTailscaleAddress(address,family)))throw new Error('origin did not resolve exclusively to Tailscale addresses');
const pinned=Object.freeze(answers.map(answer=>Object.freeze({...answer})));
const lookup=(hostname,options,callback)=>{
 if(hostname!==new URL(ORIGIN).hostname)return callback(new Error('unexpected hostname'));
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
