import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHmac, createHash, sign } from 'node:crypto';
import { AuthStore, pairRecord, proofRecord, b64url } from '../src/phone-auth-store.js';

const origin = 'https://phone.test';
let clock = 1_700_000_000_000;
const hash = (v) => createHash('sha256').update(v).digest();
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viq-auth-'));
  clock = 1_700_000_000_000;
  const store = new AuthStore(path.join(dir, 'auth.sqlite'), { origin, now: () => clock });
  await store.init();
  const pair = store.createPair();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }); const device = 'dev_' + 'a'.repeat(24);
  const verifier = hash(Buffer.concat([Buffer.from('viq-phone-pair-verifier-v1\0'), Buffer.from(pair.secret)]));
  const mac = createHmac('sha256', verifier).update(pairRecord(origin, pair.intentId, device, jwk.x, jwk.y)).digest();
  store.consumePair({ intent_id: pair.intentId, device_id: device, public_key: { kty:'EC', crv:'P-256', x:jwk.x, y:jwk.y }, proof:b64url(mac) });
  return { dir, store, device, privateKey };
}
async function cleanup(f) { f.store.close(); await rm(f.dir, { recursive:true, force:true }); }
function signed(f, method='GET', target='/v1/actors', body=Buffer.alloc(0)) {
  const c=f.store.challenge({device_id:f.device, method, target, body_hash:b64url(hash(body))});
  const rec=proofRecord(origin,c.id,Buffer.from(c.nonce,'base64url'),f.device,c.epoch,method,target,hash(body));
  return { ...c, device_id:f.device, signature:b64url(sign(null,rec,{key:f.privateKey,dsaEncoding:'ieee-p1363'})), method,target,body };
}

test('unpaired is denied and pair token is one-use', async()=>{ clock=1_700_000_000_000; const dir=await mkdtemp(path.join(os.tmpdir(),'viq-auth-')); const s=new AuthStore(path.join(dir,'a.sqlite'),{origin,now:()=>clock}); await s.init(); assert.throws(()=>s.challenge({device_id:'missing_device_0001',method:'GET',target:'/v1/x',body_hash:b64url(hash(''))}),/authorization failed/); const p=s.createPair(); clock+=301000; assert.throws(()=>s.consumePair({}),/invalid request|authorization failed/); s.close(); await rm(dir,{recursive:true}); });
test('pair intent expires and is consumed exactly once',async()=>{clock=1_700_000_000_000;const dir=await mkdtemp(path.join(os.tmpdir(),'viq-pair-')),s=await new AuthStore(path.join(dir,'a.sqlite'),{origin,now:()=>clock}).init();try{const make=()=>{const p=s.createPair(),{publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),j=publicKey.export({format:'jwk'}),device='dev_'+b64url(crypto.getRandomValues(new Uint8Array(18))),v=hash(Buffer.concat([Buffer.from('viq-phone-pair-verifier-v1\0'),Buffer.from(p.secret)]));return{p,body:{intent_id:p.intentId,device_id:device,public_key:{kty:'EC',crv:'P-256',x:j.x,y:j.y},proof:b64url(createHmac('sha256',v).update(pairRecord(origin,p.intentId,device,j.x,j.y)).digest())}}};let x=make();clock+=301000;assert.throws(()=>s.consumePair(x.body),/authorization failed/);x=make();s.consumePair(x.body);assert.throws(()=>s.consumePair(x.body),/authorization failed/)}finally{s.close();await rm(dir,{recursive:true,force:true})}});
test('proof is one-use and substitutions fail', async()=>{ const f=await fixture(); try { const p=signed(f); assert.equal(f.store.authorize(p),true); assert.throws(()=>f.store.authorize(p),/authorization failed/); for(const key of ['method','target','body']) { const q=signed(f); if(key==='method')q.method='POST'; if(key==='target')q.target='/v1/actors?x=1'; if(key==='body')q.body=Buffer.from('x'); assert.throws(()=>f.store.authorize(q),/authorization failed/); } } finally { await cleanup(f); } });
test('expired challenge and revoke invalidate, re-pair works', async()=>{ const f=await fixture(); try { const p=signed(f); clock+=31000; assert.throws(()=>f.store.authorize(p),/authorization failed/); f.store.revoke(); assert.throws(()=>f.store.challenge({device_id:f.device,method:'GET',target:'/v1/x',body_hash:b64url(hash(''))}),/authorization failed/); const p2=f.store.createPair(); assert.ok(p2.url.includes('#pair=')); } finally { await cleanup(f); } });
test('second device denied, status and audit', async()=>{ const f=await fixture(); try { assert.throws(()=>f.store.createPair(),/active device/); const st=f.store.status(); assert.equal(st.paired,true); assert.ok(st.audit.some(x=>x.action==='paired')); } finally { await cleanup(f); } });
test('closed schemas and limits', async()=>{ const f=await fixture(); try { assert.throws(()=>f.store.challenge({device_id:f.device,method:'GET',target:'/v1/x',body_hash:b64url(hash('')),extra:1}),/invalid request/); assert.throws(()=>f.store.challenge({device_id:f.device,method:'GET',target:'x'.repeat(3000),body_hash:b64url(hash(''))}),/invalid request/); } finally { await cleanup(f); } });

test('only the latest pair intent is valid and revoke invalidates a pending intent',async()=>{clock=1_700_000_000_000;const dir=await mkdtemp(path.join(os.tmpdir(),'viq-pending-pair-')),s=await new AuthStore(path.join(dir,'a.sqlite'),{origin,now:()=>clock}).init();const redeem=(p)=>{const{publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),j=publicKey.export({format:'jwk'}),device='dev_'+b64url(crypto.getRandomValues(new Uint8Array(18))),v=hash(Buffer.concat([Buffer.from('viq-phone-pair-verifier-v1\0'),Buffer.from(p.secret)]));return{intent_id:p.intentId,device_id:device,public_key:{kty:'EC',crv:'P-256',x:j.x,y:j.y},proof:b64url(createHmac('sha256',v).update(pairRecord(origin,p.intentId,device,j.x,j.y)).digest())}};try{const stale=redeem(s.createPair()),pending=redeem(s.createPair());assert.throws(()=>s.consumePair(stale),/authorization failed/);assert.equal(s.revoke(),false);assert.throws(()=>s.consumePair(pending),/authorization failed/);assert.ok(s.status().audit.some(x=>x.action==='pair_intents_revoked'))}finally{s.close();await rm(dir,{recursive:true,force:true})}});

test('origin must be an exact canonical HTTPS origin',()=>{const unused=path.join(os.tmpdir(),'unused.sqlite');for(const bad of ['http://phone.test','https://user@phone.test','https://phone.test/path','https://phone.test/?q=1','https://phone.test/#x','https://phone.test/','HTTPS://phone.test','https://PHONE.test'])assert.throws(()=>new AuthStore(unused,{origin:bad}),/canonical/);assert.equal(new AuthStore(unused,{origin:'https://phone.test:7443'}).origin,'https://phone.test:7443')});

test('pre-existing database parent permissions remain unchanged and database is 0600',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'viq-mode-'));await chmod(dir,0o751);const file=path.join(dir,'auth.sqlite'),s=await new AuthStore(file,{origin}).init();try{assert.equal((await stat(dir)).mode&0o777,0o751);assert.equal((await stat(file)).mode&0o777,0o600)}finally{s.close();await rm(dir,{recursive:true,force:true})}});

test('pair and challenge expire at the exact boundary',async()=>{clock=1_700_000_000_000;const dir=await mkdtemp(path.join(os.tmpdir(),'viq-boundary-')),s=await new AuthStore(path.join(dir,'a.sqlite'),{origin,now:()=>clock}).init();try{const p=s.createPair(),{publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),j=publicKey.export({format:'jwk'}),device='dev_'+b64url(crypto.getRandomValues(new Uint8Array(18))),v=hash(Buffer.concat([Buffer.from('viq-phone-pair-verifier-v1\0'),Buffer.from(p.secret)])),body={intent_id:p.intentId,device_id:device,public_key:{kty:'EC',crv:'P-256',x:j.x,y:j.y},proof:b64url(createHmac('sha256',v).update(pairRecord(origin,p.intentId,device,j.x,j.y)).digest())};clock=p.expires;assert.throws(()=>s.consumePair(body),/authorization failed/)}finally{s.close();await rm(dir,{recursive:true,force:true})}const f=await fixture();try{const proof=signed(f);clock=proof.expires;assert.throws(()=>f.store.authorize(proof),/authorization failed/)}finally{await cleanup(f)}});

test('concurrent second-device redemption has exactly one winner',async()=>{clock=1_700_000_000_000;const dir=await mkdtemp(path.join(os.tmpdir(),'viq-concurrent-pair-')),s=await new AuthStore(path.join(dir,'a.sqlite'),{origin,now:()=>clock}).init();try{const p=s.createPair(),make=()=>{const {publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),j=publicKey.export({format:'jwk'}),device='dev_'+b64url(crypto.getRandomValues(new Uint8Array(18))),v=hash(Buffer.concat([Buffer.from('viq-phone-pair-verifier-v1\0'),Buffer.from(p.secret)]));return{intent_id:p.intentId,device_id:device,public_key:{kty:'EC',crv:'P-256',x:j.x,y:j.y},proof:b64url(createHmac('sha256',v).update(pairRecord(origin,p.intentId,device,j.x,j.y)).digest())}},results=await Promise.allSettled([Promise.resolve().then(()=>s.consumePair(make())),Promise.resolve().then(()=>s.consumePair(make()))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);assert.equal(s.db.prepare('SELECT count(*) n FROM devices WHERE active=1').get().n,1)}finally{s.close();await rm(dir,{recursive:true,force:true})}});
