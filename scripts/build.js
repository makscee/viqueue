import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/bin', { recursive: true });
await mkdir('dist/src', { recursive: true });
await cp('bin/viq.js', 'dist/bin/viq.js');
await cp('src/server.js', 'dist/src/server.js');
await cp('src/store.js', 'dist/src/store.js');
await cp('package.json', 'dist/package.json');
console.log('built dist/');
