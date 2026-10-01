/* 物件ページの読み取り係（GitHub Actions で動く）。
   アプリが data/fetch.json に「このURLを読んで」と書くと、このスクリプトがページを取ってきて
   data/listings.json に結果を書く。アプリはそれを読んで、物件の家賃や設備を自動で入れる。

   data/fetch.json    … [{id, url, at}]           アプリが書く（ここでは書き換えない）
   data/listings.json … [{id, url, reqAt, at, ok, site, title, rent, …}]  ここだけが書く

   どちらも暗号化しない（GitHub Actions は合言葉を知らないため）。入るのは物件の広告の内容だけ。 */
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {parseListing} from "./listing.mjs";

const REQ="data/fetch.json", OUT="data/listings.json";
const MAX_PER_RUN=8, KEEP=200, TIMEOUT=20000, MAX_BYTES=6*1024*1024;
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const read=(p,d)=>{ try{ const v=JSON.parse(readFileSync(p,"utf8")); return Array.isArray(v)? v : d; }catch(e){ return d; } };
export const idOf=u=>createHash("sha256").update(String(u).trim()).digest("hex").slice(0,16);

/* https の普通のサイトだけ。IPアドレスや社内向けの名前は読まない */
export function okUrl(u){
  try{
    const x=new URL(u);
    if (x.protocol!=="https:") return false;
    const h=x.hostname;
    if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || /(^|\.)(local|internal|localhost)$/.test(h)) return false;
    return true;
  }catch(e){ return false; }
}

async function getPage(url){
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(), TIMEOUT);
  try{
    const r=await fetch(url, {headers:{"User-Agent":UA, "Accept":"text/html,application/xhtml+xml", "Accept-Language":"ja,en;q=0.5"}, redirect:"follow", signal:ctl.signal});
    if (!r.ok) return {err: r.status===403||r.status===429? "サイトに読み取りを断られました（"+r.status+"）" : r.status===404? "ページが見つかりません（掲載終了かもしれません）" : "読み込めませんでした（"+r.status+"）"};
    const buf=await r.arrayBuffer();
    if (buf.byteLength>MAX_BYTES) return {err:"ページが大きすぎます"};
    return {html:new TextDecoder("utf-8").decode(buf), finalUrl:r.url};
  }catch(e){ return {err: e.name==="AbortError"? "時間内に読み込めませんでした" : "読み込めませんでした"}; }
  finally{ clearTimeout(t); }
}

export async function run({fetchPage=getPage, now=()=>Date.now()}={}){
  const reqs=read(REQ,[]), list=read(OUT,[]);
  const byId=new Map(list.map(x=>[x.id,x]));
  const todo=[];
  for (const q of reqs){
    if (!q || !q.url || !okUrl(q.url)) continue;
    const id=idOf(q.url), done=byId.get(id);
    if (done && (done.reqAt||0) >= (q.at||0)) continue;          /* もう読んである */
    const same=todo.find(x=>x.id===id);
    if (same){ same.at=Math.max(same.at, q.at||0); continue; }
    todo.push({id, url:q.url, at:q.at||0});
  }
  for (const q of todo.slice(0, MAX_PER_RUN)){
    const page=await fetchPage(q.url);
    let rec;
    if (page.err) rec={ok:false, err:page.err};
    else {
      const p=parseListing(page.html, page.finalUrl && !/#/.test(q.url)? page.finalUrl : q.url);
      if (p.list) rec={ok:false, site:p.site, err:"物件の一覧ページのようです。1件の物件のページを開いてからURLをコピーしてください"};
      else if (p.rent==null && !p.layout) rec={ok:false, site:p.site, err:"物件の情報が見つかりませんでした（物件の詳細ページのURLか確認してください）"};
      else { delete p.list; rec=Object.assign({ok:true}, p); }
    }
    byId.set(q.id, Object.assign({id:q.id, url:q.url, reqAt:q.at, at:now()}, rec));
    console.log((rec.ok? "ok  " : "NG  ")+q.url+(rec.ok? "  "+rec.title+" ¥"+rec.rent+" "+rec.layout : "  "+rec.err));
  }
  const out=[...byId.values()].sort((a,b)=>(b.at||0)-(a.at||0)).slice(0, KEEP);
  writeFileSync(OUT, JSON.stringify(out, null, 1)+"\n");
  return out;
}

if (import.meta.url===`file://${process.argv[1]}`) await run();
