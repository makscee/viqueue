import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/server.js';
import { createPhoneGateway } from '../src/phone-gateway.js';

const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
const listen=(s,p)=>new Promise(r=>s.listen(p,'127.0.0.1',r)),close=s=>new Promise(r=>s.close(r));
const work=await mkdtemp(path.join(tmpdir(),'viq-phone-e2e-')),upPort=await port(),gwPort=await port(),origin=`https://127.0.0.1:${gwPort}`,key=path.join(work,'key.pem'),cert=path.join(work,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
const app=await createApp({storage:path.join(work,'app.sqlite')});await listen(app,upPort);
const gateway=await createPhoneGateway({authDb:path.join(work,'private','auth.sqlite'),origin,upstream:`http://127.0.0.1:${upPort}`,cert:await readFile(cert),key:await readFile(key)});await listen(gateway,gwPort);
const browser=await chromium.launch({headless:true}),requests=[];
try {
 const desktop=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:800}}),page=await desktop.newPage();page.on('request',r=>requests.push({url:r.url(),referer:r.headers().referer||'',post:r.postData()||''}));
 const legacy=gateway.authStore.createPair();await page.goto(legacy.url);assert.equal(await page.evaluate(()=>location.hash),'');await page.getByRole('button',{name:'Pair this phone'}).click();await page.locator('#phone-app').waitFor({state:'visible'});
 assert.equal(await page.evaluate(async()=>{const d=await new Promise((ok,no)=>{const r=indexedDB.open('viq-phone-auth');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)}),key=await new Promise((ok,no)=>{const r=d.transaction('keys').objectStore('keys').get('device');r.onsuccess=()=>ok(r.result.key);r.onerror=()=>no(r.error)});try{await crypto.subtle.exportKey('jwk',key);return false}catch{return key.extractable===false}}),true);
 await page.reload();await page.locator('#phone-app').waitFor({state:'visible'});await page.getByLabel('New device label (optional)').fill('Phone');await page.getByRole('button',{name:'Add device'}).click();const result=page.locator('#pairing-result');await result.getByText(/expires in 10 minutes/).waitFor();const code=(await result.textContent()).match(/\b\d{6}\b/)[0];
 const mobile=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}}),mp=await mobile.newPage();await mp.goto(origin);await mp.getByLabel('Six-digit pairing code').fill(code);await mp.getByLabel('Device label (optional)').fill('Pocket');await mp.getByRole('button',{name:'Pair this device'}).click();await mp.locator('#phone-app').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>fetch('/v1/actors').then(r=>r.status)),200);assert.equal(await mp.evaluate(()=>fetch('/v1/actors').then(r=>r.status)),200);assert.equal(await page.locator('#device-list li').count(),2);
 const secondId=gateway.authStore.listDevices().find(d=>d.label==='Pocket').id;gateway.authStore.revokeDevice(secondId);assert.equal(await page.evaluate(()=>fetch('/v1/actors').then(r=>r.status)),200);await assert.rejects(mp.evaluate(()=>fetch('/v1/actors').then(r=>r.status)));
 const attacker=await browser.newContext({ignoreHTTPSErrors:true});await attacker.addCookies(await desktop.cookies());const attackerPage=await attacker.newPage();await attackerPage.goto(origin);await attackerPage.getByText(/six-digit pairing code/i).waitFor();assert.equal(await attackerPage.evaluate(()=>fetch('/v1/actors').then(r=>r.status)),403);
 assert.equal(requests.some(r=>r.url.includes(legacy.secret)||r.referer.includes(legacy.secret)||r.post.includes(legacy.secret)),false);
 await Promise.all([desktop.close(),mobile.close(),attacker.close()]);console.log('phone auth semantic E2E passed: legacy link, code creation/redemption, confined keys, two active devices, individual revoke, first-device preservation, copied-cookie denial');
} finally {await browser.close();await close(gateway);await close(app);await rm(work,{recursive:true,force:true})}
