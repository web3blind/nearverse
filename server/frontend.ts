import express from 'express';
import { fileURLToPath } from 'node:url';
export function frontend(){
 const app=express();
 // HOT's published connector runs its dynamically generated executor in an
 // opaque-origin srcdoc sandbox. That document inherits this policy and needs
 // inline script elements; inline event handlers remain forbidden. No remote
 // script origin or eval is enabled. This is a local acceptance policy, not a
 // substitute for the separate public-launch security gate.
 app.use((_req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; script-src-elem 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://rsms.me https://fonts.cdnfonts.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.reown.com https://rsms.me https://fonts.cdnfonts.com; connect-src 'self' https: wss:; frame-src https: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});next();});
 app.get('/favicon.ico',(_req,res)=>{res.status(204).end();});
 app.use(express.static(fileURLToPath(new URL('../dist',import.meta.url)),{dotfiles:'deny',index:'index.html',setHeaders:(res,path)=>res.setHeader('Cache-Control',path.endsWith('.html')?'no-store':'public, max-age=3600')}));
 return app;
}
