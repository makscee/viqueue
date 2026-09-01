import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ticket rotation creates blank persisted Pi sessions without fork inputs',async()=>{
 const source=await readFile(new URL('../extensions/viq-worker/index.ts',import.meta.url),'utf8');
 assert.equal((source.match(/ctx\.newSession\(\)/g)??[]).length,2);
 assert.doesNotMatch(source,/newSession\s*\(\s*\{/);
 assert.doesNotMatch(source,/parentSession|sessionManager|getSessionFile|withSession/);
 assert.match(source,/setSessionName\(`VIQ \$\{ticket\.id\}/);
});

test('controller carries no prior ticket prompt, history, tool, or summary state',async()=>{
 const source=await readFile(new URL('../extensions/viq-worker/controller.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/prompt|history|tool|summary|parent|fork|branch/i);
 assert.match(source,/epoch.*adapter.*persistent.*pendingStart.*rotating.*runtime/);
});
