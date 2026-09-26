/* ふたりの信州暮らし帳 — 更新のしくみ
   「ホーム画面に追加」で使うと、ブラウザが古いページを抱え込んで新しい版に変わらない。
   そこでこのService Workerが、開くたびにネットワークを先に見に行くようにする（network-first）。
   読み取り部品（vendor/）だけは大きくて中身が変わらないので、一度取ったら手元から出す。

   VERSION は index.html の APP_VERSION と必ず同じ文字列にすること。
   test/smoke.mjs がズレを検出する。 */
const VERSION = "2026-09-26a";
const CACHE = "futari-" + VERSION;
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png"];

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));
});
self.addEventListener("activate", e=>{
  e.waitUntil((async()=>{
    for (const k of await caches.keys()) if (k!==CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
/* ページから「もう切り替えていい」と言われたら、新しい版に入れ替わる */
self.addEventListener("message", e=>{
  if (e.data && e.data.type==="SKIP_WAITING") self.skipWaiting();
  if (e.data && e.data.type==="VERSION" && e.source) e.source.postMessage({type:"VERSION", version:VERSION});
});

const isVendor = u => u.pathname.includes("/vendor/");

self.addEventListener("fetch", e=>{
  const req=e.request;
  if (req.method!=="GET") return;
  const url=new URL(req.url);
  if (url.origin!==self.location.origin) return;   /* GitHubのAPIやフォントは素通し */

  if (isVendor(url)){
    /* 中身が変わらない大物：あれば手元から。無ければ取ってきて覚える */
    e.respondWith((async()=>{
      const c=await caches.open(CACHE);
      const hit=await c.match(req);
      if (hit) return hit;
      const res=await fetch(req);
      if (res && res.ok) c.put(req, res.clone());
      return res;
    })());
    return;
  }

  /* それ以外（ページ本体・アイコンなど）：まずネットワーク、だめなら手元 */
  e.respondWith((async()=>{
    try{
      const res=await fetch(req, {cache:"no-store"});
      if (res && res.ok){ const c=await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    }catch(err){
      const hit=await caches.match(req);
      if (hit) return hit;
      const shell=await caches.match("./index.html");
      if (shell && req.mode==="navigate") return shell;
      throw err;
    }
  })());
});
