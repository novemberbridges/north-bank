/* Keeps the app and articles you've opened available with no internet. The article list always tries the network first. */
const VERSION='north-bank-2', DATA='north-bank-data';
const FILES=["./","./index.html","./manifest.webmanifest","./icons/apple-touch-icon.png","./icons/icon-192.png","./icons/icon-512.png","./fonts/source-serif-4-latin-400-normal.woff2","./fonts/source-serif-4-latin-400-italic.woff2","./fonts/source-serif-4-latin-600-normal.woff2","./fonts/source-serif-4-latin-700-normal.woff2","./fonts/source-sans-3-latin-400-normal.woff2","./fonts/source-sans-3-latin-600-normal.woff2","./fonts/source-sans-3-latin-700-normal.woff2"];
self.addEventListener('install',e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==VERSION&&n!==DATA).map(n=>caches.delete(n)))).then(()=>self.clients.claim())));
const networkFirst=(req,key,cacheName)=>fetch(req).then(r=>{ if(r.ok){ const copy=r.clone(); caches.open(cacheName).then(c=>c.put(key,copy)); } return r; }).catch(()=>caches.open(cacheName).then(c=>c.match(key)).then(h=>h||Response.error()));
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==location.origin) return;
  if(url.pathname.includes('/data/')){ e.respondWith(networkFirst(e.request,url.pathname,DATA)); return; }
  if(e.request.mode==='navigate'){ e.respondWith(networkFirst(e.request,'./index.html',VERSION)); return; }
  e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(h=>h||fetch(e.request)));
});
