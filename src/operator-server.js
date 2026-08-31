import http from 'node:http';
import { chmod, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from './store.js';

const send = (response, status, body) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(`${JSON.stringify(body)}\n`); };
async function body(request) { let raw=''; for await (const chunk of request) { raw += chunk; if (raw.length > 4096) throw new DomainError(413,'body_too_large','operator request exceeds 4KB'); } try { return raw ? JSON.parse(raw) : {}; } catch { throw new DomainError(400,'invalid_json','request body must be valid JSON'); } }
async function prepare(socketPath, uid) {
  const parent = await lstat(path.dirname(socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o022) !== 0) throw new Error('unsafe operator socket directory');
  try { const stale=await lstat(socketPath); if (!stale.isSocket() || stale.uid !== uid) throw new Error('unsafe existing operator socket path'); await unlink(socketPath); } catch(error) { if(error.code!=='ENOENT') throw error; }
}
export async function createOperatorServer({ store, socketPath='/run/viqueue-alpha/operator.sock', uid=process.geteuid?.() }={}) {
  if (!store) throw new Error('operator store is required');
  await prepare(socketPath,uid);
  const server=http.createServer(async(request,response)=>{try{
    if(request.method==='POST'&&request.url==='/v1/operator/browser-pairings'){
      const input=await body(request);if(Object.keys(input).some(key=>key!=='name')||typeof input.name!=='string')throw new DomainError(400,'invalid_browser_name','exactly one browser name is required');
      return send(response,201,await store.createLocalBrowserPairing({device_name:input.name}));
    }
    if(request.method==='POST'&&request.url==='/v1/operator/projects-tickets/clean-slate'){
      const input=await body(request);if(Object.keys(input).length!==1||input.confirm!=='FULL_PROJECT_TICKET_CLEAN_SLATE')throw new DomainError(409,'clean_slate_confirmation_required','exact clean-slate confirmation is required');
      return send(response,200,await store.cleanSlateProjectsAndTickets());
    }
    throw new DomainError(404,'route_not_found','route not found');
  }catch(error){if(error instanceof DomainError)return send(response,error.status,{error:{code:error.code,message:error.message}});return send(response,500,{error:{code:'internal_error',message:'internal server error'}});}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.off('error',reject);resolve();});});
  try { await chmod(socketPath,0o600); const socket=await lstat(socketPath); if(!socket.isSocket()||socket.uid!==uid||(socket.mode&0o777)!==0o600)throw new Error('operator socket permission verification failed'); }
  catch(error){await new Promise(resolve=>server.close(resolve));try{await unlink(socketPath)}catch{}throw error;}
  server.once('close',async()=>{try{const current=await lstat(socketPath);if(current.isSocket()&&current.uid===uid)await unlink(socketPath);}catch{}});
  return server;
}
