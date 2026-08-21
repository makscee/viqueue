import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const oid=/^[0-9a-f]{40}$/;
export async function runVaultSync({cwd,onOutput=()=>{},exec=execFileAsync}={}){
 if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw new Error('vault_sync_requires_absolute_workspace');
 const cli=path.join(cwd,'tools','vault-sync','vault-sync');
 const invoke=async args=>{let result;try{result=await exec(cli,args,{cwd,maxBuffer:1024*1024})}catch(error){for(const line of String(error.stdout??error.stderr??error.message).trim().split(/\r?\n/).filter(Boolean))onOutput(line);throw new Error('vault_sync_failed')}for(const line of `${result.stdout??''}${result.stderr??''}`.trim().split(/\r?\n/).filter(Boolean))onOutput(line);return result};
 await invoke(['sync']);
 const statusResult=await invoke(['status','--json']);let status;try{status=JSON.parse(statusResult.stdout)}catch{throw new Error('vault_sync_invalid_status')}
 if(status.dirty!==false||status.freshness!=='CURRENT'||status.relation!=='EQUAL'||!oid.test(status.local_oid??'')||status.local_oid!==status.remote_oid)throw new Error('vault_sync_not_canonical');
 return{commit:status.local_oid,branch:status.branch};
}
