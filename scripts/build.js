import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/bin', { recursive: true });
await mkdir('dist/src', { recursive: true });
await mkdir('dist/web', { recursive: true });
await cp('bin/viq.js', 'dist/bin/viq.js');
await cp('bin/viq-import.js', 'dist/bin/viq-import.js');
await cp('bin/viq-phone-auth.js', 'dist/bin/viq-phone-auth.js');
await cp('bin/viq-trace-tailscale-upstream.js', 'dist/bin/viq-trace-tailscale-upstream.js');
await cp('src/server.js', 'dist/src/server.js');
await cp('src/phone-auth-store.js', 'dist/src/phone-auth-store.js');
await cp('src/phone-gateway.js', 'dist/src/phone-gateway.js');
await cp('src/store.js', 'dist/src/store.js');
await cp('src/http-client.js', 'dist/src/http-client.js');
await cp('src/mcp-server.js', 'dist/src/mcp-server.js');
await cp('web', 'dist/web', { recursive: true });
await cp('package.json', 'dist/package.json');
console.log('built dist/');
