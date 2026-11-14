// @vitest-environment node
import {afterEach,expect,it} from 'vitest';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {frontend} from '../server/frontend';
let server:Server|undefined;
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}});
it('serves the connector-compatible local CSP without allowing inline handlers or remote scripts',async()=>{
 server=frontend().listen(0,'127.0.0.1');await once(server,'listening');
 const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/favicon.ico`);
 expect(response.status).toBe(204);
 const policy=response.headers.get('content-security-policy')!;
 expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
 expect(policy).toContain("script-src-elem 'self' 'unsafe-inline';");
 expect(policy).toContain("script-src-attr 'none';");
 expect(policy).toContain("style-src 'self' 'unsafe-inline' https://rsms.me https://fonts.cdnfonts.com;");
 expect(policy).toContain("font-src 'self' data: https://fonts.reown.com https://rsms.me https://fonts.cdnfonts.com;");
 expect(policy).toContain("object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 expect(response.headers.get('referrer-policy')).toBe('no-referrer');
 expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
