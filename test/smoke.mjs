/* docs/futari/index.html を実ブラウザで動かし、GitHub APIを差し替えて保存まわりを確かめる。
   ネットワークには一切出ない（api.github.com は下の route で全部せき止めている）。
   使い方：npm install   ← 初回のみ（Playwright）
          npm test                                */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HTML = readFileSync(join(ROOT, 'index.html'));
const TYPES = {'.js':'text/javascript', '.json':'application/json', '.wasm':'application/wasm',
               '.png':'image/png', '.txt':'text/plain', '.webmanifest':'application/manifest+json', '.html':'text/html; charset=utf-8'};
/* この環境にはPlaywright同梱のブラウザがないことがあるので、あればシステムのChromiumを使う */
const SYS = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => existsSync(p));
/* index.html のほか、同梱した読み取り部品（vendor/）も本番と同じように配る */
const overrides = new Map();   /* 更新の試験で中身を差し替えるため */
const srv = createServer((q,r)=>{
  const path = decodeURIComponent((q.url||'/').split('?')[0]);
  if (overrides.has(path)){
    r.writeHead(200,{'content-type': path.endsWith('.js')?'text/javascript':'text/plain','cache-control':'no-store'});
    r.end(overrides.get(path)); return;
  }
  if (path==='/' || path==='/index.html'){
    r.writeHead(200,{'content-type':'text/html; charset=utf-8'}); r.end(HTML); return;
  }
  let rel = path.replace(/^\/+/,'');
  if (rel.endsWith('/')) rel += 'index.html';   /* フォルダは index.html を返す（本番と同じ） */
  if (rel.includes('..')){ r.writeHead(400); r.end(); return; }
  try{
    const buf = readFileSync(join(ROOT, rel));
    const ext = (rel.match(/\.[a-z0-9]+$/i)||[''])[0].toLowerCase();
    r.writeHead(200,{'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control':'no-store'});
    r.end(buf);
  }catch(e){ r.writeHead(404); r.end(); }
});
await new Promise(res=>srv.listen(0,res));
const url = 'http://127.0.0.1:'+srv.address().port+'/';

const CORS = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,OPTIONS'};
let fail = 0;
const ok = (c,m)=>{ console.log((c?'  ok  ':'  NG  ')+m); if(!c) fail++; };

// sw.js と index.html の版がズレていると、更新が永久に掛からない事故になる
{
  const sw = readFileSync(join(ROOT,'sw.js'),'utf8');
  const a = (HTML.toString().match(/APP_VERSION\s*=\s*"([^"]+)"/)||[])[1];
  const b = (sw.match(/VERSION\s*=\s*"([^"]+)"/)||[])[1];
  console.log('\n[版の一致]');
  ok(!!a && a===b, `index.html と sw.js の版が同じ（${a} / ${b}）`);
}

const browser = await chromium.launch(SYS ? {executablePath:SYS} : {});

async function run(name, {files, token, pass, repoStatus, hash, clipboard, perms, init}, body){
  const ctx = await browser.newContext({permissions:[...(clipboard?['clipboard-read','clipboard-write']:[]), ...(perms||[])]});
  const puts = [], urls = [];
  /* 余計な末尾スラッシュ（/repos/owner/repo/）は、本物のGitHubなら 400 かつCORSヘッダ無しで返る。
     ブラウザからは「Failed to fetch」としか見えない事故を再現するため、ここでも同じ扱いにする */
  const STRAY_SLASH = /\/repos\/[^/]+\/[^/]+\/(\?|$)/;
  await ctx.route('https://api.github.com/**', route=>{
    const req = route.request(), u = req.url(), m = req.method();
    urls.push(m+' '+u);
    if (STRAY_SLASH.test(u)) return route.fulfill({status:400, body:'{"message":"Bad Request"}'});
    if (m==='OPTIONS') return route.fulfill({status:204, headers:CORS});
    const keyOf = x => x.includes('settings') ? 'settings' : x.includes('chat') ? 'chat' : x.includes('todos') ? 'todos' : x.includes('links') ? 'links' : x.includes('homes') ? 'homes' : 'expenses';
    if (m==='PUT'){ const key = keyOf(u);
      const b = JSON.parse(req.postData()||'{}');
      puts.push({key, data: JSON.parse(Buffer.from(b.content,'base64').toString('utf8'))});
      files[key] = puts[puts.length-1].data;
      return route.fulfill({status:200, headers:{...CORS,'content-type':'application/json'}, body: JSON.stringify({content:{sha:'sha-'+puts.length}})});
    }
    if (/\/contents\//.test(u)){ const key = keyOf(u);
      if (files[key]==null) return route.fulfill({status:404, headers:{...CORS,'content-type':'application/json'}, body:'{"message":"Not Found"}'});
      return route.fulfill({status:200, headers:{...CORS,'content-type':'application/json'},
        body: JSON.stringify({sha:'sha-'+key, content: Buffer.from(JSON.stringify(files[key])).toString('base64')})});
    }
    if (repoStatus && repoStatus!==200) return route.fulfill({status:repoStatus, headers:{...CORS,'content-type':'application/json'}, body:'{"message":"Not Found"}'});
    return route.fulfill({status:200, headers:{...CORS,'content-type':'application/json'}, body: JSON.stringify({permissions:{push:true}})});
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e=>errs.push(String(e)));
  page.on('console', m=>{ const t=m.text(); if(m.type()==='error' && !/ERR_CERT|fonts\.(googleapis|gstatic)|api\.github\.com|404 \(Not Found\)/.test(t+' '+(m.location()||{}).url)) errs.push('console: '+t); });
  if (token) await page.addInitScript(t=>localStorage.setItem('futari.token',t), token);
  if (pass) await page.addInitScript(p=>localStorage.setItem('futari.pass',p), pass);
  if (init) await page.addInitScript(init);
  await page.goto(url + (hash||''));
  await page.waitForTimeout(900);
  console.log('\n['+name+']');
  ok(errs.length===0, 'JSエラーなし '+(errs[0]||''));
  await body(page, {puts, files, errs, urls});
  ok(!urls.some(u=>STRAY_SLASH.test(u)), 'APIのURLに余計な末尾スラッシュがない');
  await ctx.close();
}

// 1) トークンなし・GitHub側にデータなし → この端末だけに保存
await run('未接続', {files:{settings:null, expenses:null}}, async (page,{puts})=>{
  ok((await page.textContent('#sync')).includes('この端末だけ'), '表示：この端末だけに保存');
  ok(puts.length===0, '書き込みを試みない');
  for (const t of ['initial','budget','log']){
    await page.click(`[data-tab="${t}"]`); await page.waitForTimeout(150);
    ok(await page.locator('#view .card').first().isVisible(), `${t}タブが描画される`);
  }
  await page.fill('#e-amount','1200'); await page.fill('#e-memo','テスト');
  await page.click('#expForm button[type=submit]'); await page.waitForTimeout(200);
  ok((await page.textContent('#view')).includes('テスト'), '未接続でも家計簿に記録できる');
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  ok(await page.locator('#ghToken').isVisible(), 'トークン入力欄がある');
});

// 2) トークンあり → GitHubに保存され、相手の変更も取り込む
await run('同期あり', {files:{settings:null, expenses:null}, token:'github_pat_test'}, async (page,{puts,files})=>{
  ok((await page.textContent('#sync')).includes('2人で同期中'), '表示：2人で同期中');
  ok(puts.some(p=>p.key==='settings'), '初回に settings.json を作る');
  await page.click('[data-tab="log"]'); await page.waitForTimeout(150);
  await page.fill('#e-amount','3400'); await page.fill('#e-memo','スーパー');
  await page.click('#expForm button[type=submit]');
  await page.waitForTimeout(1800);
  const exp = puts.filter(p=>p.key==='expenses').pop();
  ok(!!exp && exp.data.some(e=>e.memo==='スーパー' && e.amount===3400), '支出がGitHubに書き込まれる');
  // 相手が別の支出を足した状態にして、取り込みを確認
  files.expenses = [...(files.expenses||[]), {id:'partner1', date:new Date().toISOString().slice(0,10), cat:'food', amount:800, payer:1, memo:'相手の記録', createdAt:Date.now()}];
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.click('[data-act="ghSync"]'); await page.waitForTimeout(800);
  await page.click('[data-tab="log"]'); await page.waitForTimeout(200);
  ok((await page.textContent('#view')).includes('相手の記録'), '相手の記録を取り込む');
  // 削除が相手の分を復活させずに反映されるか
  const before = puts.length;
  await page.click('button[data-act="delExp"]'); await page.waitForTimeout(1800);
  const after = puts.filter(p=>p.key==='expenses').pop();
  ok(puts.length>before && after.data.length===1, '削除がGitHubに反映される（残り1件）');
  // 設定の変更が保存されるか
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.fill('#name0','はる'); await page.locator('#name0').blur(); await page.waitForTimeout(2200);
  const st = puts.filter(p=>p.key==='settings').pop();
  ok(st.data.names[0]==='はる', '名前の変更が保存される');
  ok(!(await page.content()).includes('github_pat_test'), 'トークンがページに残らない');
});

// 3) トークンなしでGitHub側にデータがある → 見るだけ（保存はしない）
const seeded = {
  settings:{v:1, names:["ひろ","なつ"], incomes:[210000,160000], incomeType:"net", area:"shiojiri", split:"half", fixed:[130000,100000],
    budget:[{id:"rent",g:"home",label:"家賃",amt:68000}], initial:[], savings:{current:50000, monthly:[50000,30000], cushion:true, moveIn:"2027-04", bonuses:[], overrides:{}}},
  expenses:[{id:"seed1", date:new Date().toISOString().slice(0,10), cat:"food", amount:2500, payer:0, memo:"先に入っていた記録", createdAt:1}]
};
await run('見るだけ', {files:seeded}, async (page,{puts})=>{
  ok((await page.textContent('#sync')).includes('見るだけ'), '表示：見るだけ');
  ok((await page.textContent('#nameA'))==='ひろ', 'GitHub側の設定を読み込む');
  await page.click('[data-tab="log"]'); await page.waitForTimeout(200);
  ok((await page.textContent('#view')).includes('先に入っていた記録'), 'GitHub側の家計簿を読み込む');
  await page.fill('#e-amount','999'); await page.click('#expForm button[type=submit]'); await page.waitForTimeout(300);
  ok(puts.length===0, '書き込みを試みない');
  ok((await page.textContent('#toast')).includes('見るだけ'), '保存できないことを知らせる');
});

// 4) 貼り付けたバックアップに細工があっても、属性に流し込まれない
await run('細工したバックアップ', {files:{settings:null, expenses:null}}, async (page)=>{
  page.on('dialog', d=>d.accept());
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  const bad = JSON.stringify({settings:{savings:{moveIn:'x" onfocus="window.__pwned=1" data-x="'}, names:['<img src=x onerror=window.__pwned=1>','B']}, expenses:[]});
  await page.fill('#backup', bad);
  await page.click('[data-act="import"]'); await page.waitForTimeout(400);
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(250);
  await page.locator('#movein').focus().catch(()=>{});
  await page.waitForTimeout(200);
  ok(await page.evaluate(()=>window.__pwned===undefined), '仕込んだスクリプトが動かない');
  ok((await page.locator('#movein').getAttribute('data-x'))===null, '属性が増えていない');
  ok((await page.textContent('#nameA')).includes('<img'), '名前は文字として表示される');
});

// 5) つなげなかったとき、理由が画面に残る
await run('つなげないとき', {files:{settings:null, expenses:null}, repoStatus:404}, async (page,{puts})=>{
  let dialog = '';
  page.on('dialog', d=>{ dialog = d.message(); d.accept(); });
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.fill('#ghToken', 'github_pat_dummy');
  await page.click('[data-act="ghConnect"]'); await page.waitForTimeout(600);
  ok(dialog.includes('つなげませんでした'), 'ダイアログで知らせる');
  ok(dialog.includes('Repository access'), '原因の当たりを示す（対象リポジトリが選ばれていない）');
  ok(dialog.includes('404'), 'HTTPの番号を添える');
  const card = await page.textContent('#view');
  ok(card.includes('つなげませんでした') && card.includes('Repository access'), '画面にも理由が残る');
  ok(puts.length===0, '書き込みは試みない');
  ok((await page.textContent('#sync')).includes('この端末だけ'), '状態は変わらない');
});

// 6) 招待リンク（#t=…）で開くと、そのままつながる
const seeded2 = {
  settings:{v:1, names:["ひろ","なつ"], incomes:[200000,150000], incomeType:"net", area:"matsumoto", split:"ratio", fixed:[130000,100000],
    budget:[{id:"rent",g:"home",label:"家賃",amt:70000}], initial:[], savings:{current:0, monthly:[60000,40000], cushion:true, moveIn:"2027-06", bonuses:[], overrides:{}}},
  expenses:[]
};
await run('招待リンクで開く', {files:seeded2, hash:'#t=github_pat_invited'}, async (page,{puts})=>{
  ok((await page.textContent('#sync')).includes('2人で同期中'), '表示：2人で同期中');
  ok((await page.textContent('#nameA'))==='ひろ', 'GitHub側の設定を読み込む');
  ok(!page.url().includes('github_pat'), 'アドレス欄からトークンが消えている');
  ok(await page.evaluate(()=>localStorage.getItem('futari.token'))==='github_pat_invited', 'この端末に覚えている');
  await page.click('[data-tab="log"]'); await page.waitForTimeout(150);
  await page.fill('#e-amount','1500'); await page.click('#expForm button[type=submit]');
  await page.waitForTimeout(1800);
  ok(puts.some(p=>p.key==='expenses'), '招待された側も書き込める');
});

// 7) つないだ端末は、相手に渡すリンクを作れる
await run('招待リンクを作る', {files:{settings:null, expenses:null}, token:'github_pat_owner', clipboard:true}, async (page)=>{
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(200);
  ok(await page.locator('[data-act="ghInvite"]').isVisible(), 'コピーのボタンが出る');
  await page.click('[data-act="ghInvite"]'); await page.waitForTimeout(300);
  const link = await page.evaluate(()=>navigator.clipboard.readText());
  ok(link.includes('#t=github_pat_owner'), 'リンクにトークンが入っている');
  ok(link.indexOf('#') > link.indexOf('//127.0.0.1'), 'トークンは # より後ろ（サーバーに送られない）');
  ok((await page.textContent('#toast')).includes('コピーしました'), 'コピーしたと知らせる');
});

// 8) 未接続の端末では招待リンクを作れない
await run('未接続では招待リンクなし', {files:{settings:null, expenses:null}}, async (page)=>{
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(200);
  ok(await page.locator('[data-act="ghInvite"]').count()===0, 'コピーのボタンは出ない');
});

// 9〜12) 合言葉による暗号化
const PASS = 'ふたりの合言葉2026';
let encFiles = null;

await run('合言葉をかける', {files:{settings:null, expenses:null}, token:'github_pat_owner'}, async (page,{puts,files})=>{
  const answers = [PASS, PASS];
  page.on('dialog', d=>d.accept(answers.shift() ?? ''));
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(200);
  await page.click('[data-act="passSet"]'); await page.waitForTimeout(1500);
  const st = puts.filter(p=>p.key==='settings').pop();
  ok(st && st.data.enc==='aes-gcm', 'GitHubには暗号化して書き込む');
  ok(!JSON.stringify(st.data).includes('あなた'), '平文の中身が残っていない');
  ok(!JSON.stringify(st.data).includes('70000'), '金額も読み取れない');
  ok(typeof st.data.salt==='string' && typeof st.data.iv==='string', '塩とIVが付いている');
  const ex = puts.filter(p=>p.key==='expenses').pop();
  ok(ex && ex.data.enc==='aes-gcm', '家計簿も暗号化する');
  ok((await page.textContent('#sync')).includes('暗号化'), '右上に暗号化中と出る');
  encFiles = {settings: files.settings, expenses: files.expenses};
});

await run('合言葉なしでは開けない', {files:{...encFiles}}, async (page,{puts})=>{
  ok((await page.textContent('#view')).includes('合言葉を入れてください'), '合言葉の画面になる');
  ok(await page.locator('nav.tabs').isHidden(), 'タブが隠れる');
  ok(!(await page.textContent('#view')).includes('ふたり暮らしの生活費'), '中身が表示されない');
  ok((await page.textContent('#sync')).includes('合言葉まち'), '右上は合言葉まち');
  ok(puts.length===0, '書き込みもしない');
});

await run('合言葉を入れると開く', {files:{...encFiles}}, async (page)=>{
  await page.fill('#passIn', 'ちがう合言葉');
  await page.click('#lockForm button[type=submit]'); await page.waitForTimeout(700);
  ok((await page.textContent('#toast')).includes('合言葉が違います'), '違う合言葉は弾く');
  ok((await page.textContent('#view')).includes('合言葉を入れてください'), 'まだ開かない');
  await page.fill('#passIn', PASS);
  await page.click('#lockForm button[type=submit]'); await page.waitForTimeout(1200);
  ok(!(await page.textContent('#view')).includes('合言葉を入れてください'), '正しい合言葉で開く');
  ok((await page.textContent('#view')).includes('ふたり暮らしの生活費'), '中身が見える');
});

await run('招待リンクに合言葉も入る', {files:{...encFiles}, hash:'#t=github_pat_invited&k='+encodeURIComponent(PASS)}, async (page)=>{
  ok(!(await page.textContent('#view')).includes('合言葉を入れてください'), 'そのまま開く');
  ok((await page.textContent('#sync')).includes('2人で同期中（暗号化）'), '暗号化したまま同期する');
  ok(!page.url().includes(encodeURIComponent(PASS)), 'アドレス欄から合言葉が消えている');
});

// 13〜15) チャット
await run('チャット', {files:{settings:null, expenses:null, chat:null}, token:'github_pat_owner'}, async (page,{puts,files})=>{
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(200);
  ok((await page.textContent('#view')).includes('この端末を使うのはどちら'), '最初にどちらか選ばせる');
  await page.click('[data-act="setMe"][data-i="0"]'); await page.waitForTimeout(200);
  await page.fill('#chatText', '今日の夜ごはん、いる？');
  await page.click('#chatForm button[type=submit]'); await page.waitForTimeout(900);
  ok((await page.textContent('#chatwrap')).includes('今日の夜ごはん、いる？'), '自分の発言が出る');
  ok(await page.locator('.msg.mine').count()===1, '自分の側に寄って表示される');
  const c = puts.filter(p=>p.key==='chat').pop();
  ok(c && c.data.some(m=>m.text==='今日の夜ごはん、いる？' && m.who===0), 'GitHubに書き込まれる');
  ok((await page.textContent('#chatText')) === '', '送ると入力欄が空になる');
  // 相手からの発言を受け取る
  files.chat = [...c.data, {id:'m-partner', who:1, text:'いる！21時ごろ帰る', at:Date.now()}];
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.click('[data-act="ghSync"]'); await page.waitForTimeout(700);
  ok((await page.textContent('[data-tab="chat"]')).length >= 4, 'タブは残っている');
  ok(await page.locator('[data-tab="chat"] .tabdot').count()===1, '未読の印が出る');
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(300);
  ok((await page.textContent('#chatwrap')).includes('いる！21時ごろ帰る'), '相手の発言が出る');
  ok(await page.locator('.msg:not(.mine)').count()===1, '相手の側に表示される');
  ok(await page.locator('[data-tab="chat"] .tabdot').count()===0, '開くと未読の印が消える');
  // 自分の発言だけ消せる
  ok(await page.locator('.msg.mine [data-act="delMsg"]').count()===1, '自分の発言には消すボタンがある');
  ok(await page.locator('.msg:not(.mine) [data-act="delMsg"]').count()===0, '相手の発言は消せない');
  await page.click('.msg.mine [data-act="delMsg"]'); await page.waitForTimeout(900);
  const c2 = puts.filter(p=>p.key==='chat').pop();
  ok(!c2.data.some(m=>m.text==='今日の夜ごはん、いる？'), '消したことがGitHubにも反映される');
  ok(c2.data.some(m=>m.id==='m-partner'), '相手の発言は残る');
});

await run('チャットも暗号化される', {files:{settings:null, expenses:null, chat:null}, token:'github_pat_owner'}, async (page,{puts})=>{
  const answers = [PASS, PASS];
  page.on('dialog', d=>d.accept(answers.shift() ?? ''));
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(200);
  await page.click('[data-act="setMe"][data-i="1"]'); await page.waitForTimeout(150);
  await page.fill('#chatText', 'ないしょの話');
  await page.click('#chatForm button[type=submit]'); await page.waitForTimeout(900);
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.click('[data-act="passSet"]'); await page.waitForTimeout(2000);
  const c = puts.filter(p=>p.key==='chat').pop();
  ok(c && c.data.enc==='aes-gcm', 'チャットも暗号化して保存する');
  ok(!JSON.stringify(c.data).includes('ないしょ'), '本文が読み取れない');
});

await run('見るだけの端末はチャットを送れない', {files:seeded}, async (page,{puts})=>{
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(200);
  await page.click('[data-act="setMe"][data-i="0"]'); await page.waitForTimeout(150);
  await page.fill('#chatText', '送れないはず');
  await page.click('#chatForm button[type=submit]'); await page.waitForTimeout(400);
  ok(puts.length===0, '書き込みを試みない');
  ok((await page.textContent('#toast')).includes('見るだけ'), '保存できないことを知らせる');
});

// 16) レシートの読み取り（同梱したOCRを実際に動かす）
await run('レシート読み取り', {files:{settings:null, expenses:null}}, async (page)=>{
  await page.click('[data-tab="log"]'); await page.waitForTimeout(200);
  ok(await page.locator('label[for="rcpt"]').isVisible(), '読み取りのボタンがある');
  // レシートに見立てた画像をその場で作って、ファイル選択と同じように渡す
  await page.evaluate(async ()=>{
    const cv=document.createElement('canvas'); cv.width=560; cv.height=440;
    const cx=cv.getContext('2d');
    cx.fillStyle='#fff'; cx.fillRect(0,0,cv.width,cv.height);
    cx.fillStyle='#000'; cx.font='30px IPAGothic, sans-serif';
    cx.fillText('スーパーツルヤ 松本店', 24, 56);
    cx.fillText('2026年9月17日', 24, 112);
    cx.fillText('小計      1,980', 24, 224);
    cx.fillText('合計      2,178', 24, 280);
    cx.fillText('お預り    3,000', 24, 336);
    const blob=await new Promise(r=>cv.toBlob(r,'image/png'));
    const dt=new DataTransfer(); dt.items.add(new File([blob],'receipt.png',{type:'image/png'}));
    const inp=document.getElementById('rcpt');
    inp.files=dt.files;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.waitForFunction(()=>{
    const el=document.getElementById('ocrStat');
    return el && (/読めました|読み取れませんでした|失敗/.test(el.textContent));
  }, null, {timeout:180000});
  const stat = await page.textContent('#ocrStat');
  ok(/読めました/.test(stat), '読み取りが最後まで走る（'+stat.slice(0,40)+'）');
  ok((await page.inputValue('#e-amount'))==='2178', '合計の金額を拾う（小計やお預りではない）');
  ok((await page.inputValue('#e-date'))==='2026-09-17', '日付を拾う');
  ok((await page.inputValue('#e-cat'))==='food', '店名から分類を当てる');
  ok((await page.inputValue('#e-memo')).length>0, 'メモに店名が入る');
  // 読み取っただけでは記録しない
  ok((await page.textContent('#view')).includes('確かめてから'), '確認を促す');
});

// 17〜19) 合言葉を変えたとき・食い違ったときの立て直し
const PASS2 = 'あたらしい合言葉';
const rekeyFiles = {settings:null, expenses:null, chat:null};

await run('合言葉を変えても取り残さない', {files:rekeyFiles, token:'github_pat_owner'}, async (page,{puts})=>{
  const answers = [PASS, PASS, PASS2, PASS2];
  page.on('dialog', d=>d.accept(answers.shift() ?? ''));
  // 先に家計簿とチャットに中身を入れておく
  await page.click('[data-tab="log"]'); await page.waitForTimeout(200);
  await page.fill('#e-amount','1200'); await page.click('#expForm button[type=submit]'); await page.waitForTimeout(900);
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(200);
  await page.click('[data-act="setMe"][data-i="0"]'); await page.waitForTimeout(150);
  await page.fill('#chatText','やっほー'); await page.click('#chatForm button[type=submit]'); await page.waitForTimeout(900);
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(200);
  await page.click('[data-act="passSet"]'); await page.waitForTimeout(2500);
  ok(rekeyFiles.settings.enc==='aes-gcm' && rekeyFiles.expenses.enc==='aes-gcm' && rekeyFiles.chat.enc==='aes-gcm', '3つとも暗号化される');
  await page.click('[data-act="passChange"]'); await page.waitForTimeout(3000);
  const salts = new Set([rekeyFiles.settings.salt, rekeyFiles.expenses.salt, rekeyFiles.chat.salt]);
  ok(salts.size===1, '変更後は3つとも同じ鍵で書き直される');
});

await run('新しい合言葉で開き直せる', {files:{...rekeyFiles}, token:'github_pat_owner', pass:PASS2}, async (page)=>{
  const view = await page.textContent('#view');
  ok(!view.includes('合言葉を入れてください'), '新しい合言葉でそのまま開く');
  ok(!view.includes('読めません'), '読めないファイルが残っていない');
  await page.click('[data-tab="log"]'); await page.waitForTimeout(250);
  ok((await page.textContent('#view')).includes('¥1,200'), '変更前の家計簿が読める');
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(250);
  await page.click('[data-act="setMe"][data-i="0"]'); await page.waitForTimeout(200);
  ok((await page.textContent('#chatwrap')).includes('やっほー'), '変更前のチャットが読める');
});

// 片方だけ別の合言葉で保存された状態（今回の不具合そのもの）
const mixed = {...encFiles, chat:null};
mixed.expenses = JSON.parse(JSON.stringify(encFiles.settings));
mixed.expenses.salt = Buffer.from(Array.from({length:16},(_,i)=>i+99)).toString('base64');
await run('片方が別の合言葉でも閉じ込められない', {files:mixed, token:'github_pat_owner'}, async (page,{puts})=>{
  page.on('dialog', d=>d.accept());
  await page.fill('#passIn', PASS);
  await page.click('#lockForm button[type=submit]'); await page.waitForTimeout(2000);
  const view = await page.textContent('#view');
  ok(!view.includes('合言葉を入れてください'), '合言葉の画面に戻らない');
  ok(view.includes('ふたり暮らしの生活費'), '読めるものは見える');
  ok(view.includes('家計簿が読めません'), 'どれが読めないか名指しする');
  ok((await page.textContent('#toast')).includes('家計簿'), '知らせも出る');
  const before = puts.length;
  await page.click('[data-act="fixEnc"]'); await page.waitForTimeout(1500);
  ok(puts.length>before && puts.filter(p=>p.key==='expenses').length>0, '作り直すとGitHubに書き直す');
  ok(!(await page.textContent('#view')).includes('家計簿が読めません'), '作り直すと警告が消える');
});

// 20〜21) やることリスト
await run('やることリスト', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page,{puts,files})=>{
  ok((await page.textContent('#view')).includes('やることリスト'), 'ホームに出る');
  ok(await page.evaluate(()=>{
    const cards=[...document.querySelectorAll('#view .card')];
    return cards.length>0 && cards[0].textContent.includes('やることリスト');
  }), 'ホームのいちばん上にある');
  ok(await page.locator('.chips button').count()>0, '最初はよくあるやることを勧める');
  // 勧められたものを1つ追加
  const first = await page.locator('.chips button').first().textContent();
  await page.locator('.chips button').first().click(); await page.waitForTimeout(800);
  ok((await page.textContent('.todos')).includes(first.replace('＋ ','')), '押すと追加される');
  // 自分で書いて追加（期限つき）
  await page.fill('#todoText', '内見の予約をする');
  // 期限は「今日から30日後」にする（日付を固定すると、その日になった途端に3日以内扱いになって試験が崩れる）
  const far = await page.evaluate(()=>{ const x=new Date(); x.setDate(x.getDate()+30);
    return {iso:x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0'), md:(x.getMonth()+1)+'/'+x.getDate()}; });
  await page.fill('#todoDue', far.iso);
  await page.click('#todoForm button[type=submit]'); await page.waitForTimeout(800);
  ok((await page.textContent('.todos')).includes('内見の予約をする'), '書いたものが追加される');
  ok((await page.textContent('.todos')).includes(far.md), '期限が出る');
  // 期限の切迫ぐあいで色が変わる
  const mk = async (text, offsetDays)=>{
    const d = offsetDays===null ? '' : await page.evaluate(n=>{
      const x=new Date(); x.setDate(x.getDate()+n);
      return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');
    }, offsetDays);
    await page.fill('#todoText', text);
    if (d) await page.fill('#todoDue', d); else await page.fill('#todoDue','');
    await page.click('#todoForm button[type=submit]'); await page.waitForTimeout(700);
  };
  await mk('期限を過ぎたやつ', -3);
  await mk('あさってのやつ', 2);
  await mk('ずっと先のやつ', 60);
  await mk('期限なしのやつ', null);
  ok(await page.locator('.todos li.st-over').count()===1, '期限切れは赤の印（over）');
  ok(await page.locator('.todos li.st-soon').count()===1, '3日以内は黄色の印（soon）');
  ok(await page.locator('.todos li.st-later').count()>=1, '先のものは緑の印（later）');
  ok(await page.locator('.todos li.st-none', {hasText:'期限なしのやつ'}).count()===1, '期限なしは無色の印（none）');
  ok((await page.textContent('.tally')).includes('期限すぎ 1'), '上に期限すぎの数が出る');
  ok((await page.textContent('.tally')).includes('3日以内 1'), '上に3日以内の数が出る');
  ok(await page.locator('.todos li.st-over').first().evaluate(el=>{
    const bg=getComputedStyle(el).backgroundColor, bl=getComputedStyle(el).borderLeftColor;
    return bg!=='rgba(0, 0, 0, 0)' && bl!==getComputedStyle(el).borderTopColor;
  }), '期限切れの行は背景と左の線が変わる');
  ok((await page.inputValue('#todoText'))==='', '追加すると入力欄が空になる');
  const t = puts.filter(p=>p.key==='todos').pop();
  ok(t && t.data.some(x=>x.text==='内見の予約をする' && x.due===far.iso), 'GitHubに書き込まれる');
  // チェックすると終わり扱いになって下に移る
  await page.locator('.todos input[type=checkbox]').last().check(); await page.waitForTimeout(900);
  ok(await page.locator('.todos li.st-done').count()===1, 'チェックすると終わり表示になる');
  ok((await page.textContent('.tally')).includes('終わった 1'), '残りと終わりの数が出る');
  ok(await page.locator('.todos li').last().evaluate(el=>el.classList.contains('st-done')), '終わったものは下に移る');
  const t2 = puts.filter(p=>p.key==='todos').pop();
  ok(t2.data.some(x=>x.done===true), '終わりもGitHubに反映される');
  // 相手が足した分を取り込む
  files.todos = [...t2.data, {id:'todo-partner', text:'退去の連絡をする', due:'', done:false, by:1, at:Date.now()}];
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.click('[data-act="ghSync"]'); await page.waitForTimeout(800);
  await page.click('[data-tab="home"]'); await page.waitForTimeout(250);
  ok((await page.textContent('.todos')).includes('退去の連絡をする'), '相手が足した分が出る');
  // 終わった分をまとめて消す
  page.on('dialog', d=>d.accept());
  await page.click('[data-act="clearDone"]'); await page.waitForTimeout(900);
  ok(await page.locator('.todos li.st-done').count()===0, '終わった分を消せる');
  const t3 = puts.filter(p=>p.key==='todos').pop();
  ok(!t3.data.some(x=>x.done), '消したことがGitHubにも反映される');
  ok(t3.data.some(x=>x.id==='todo-partner'), '相手の分は残る');
});

await run('やることリストも暗号化される', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page,{puts})=>{
  const answers=[PASS,PASS];
  page.on('dialog', d=>d.accept(answers.shift() ?? ''));
  await page.fill('#todoText','こっそり調べる'); await page.click('#todoForm button[type=submit]'); await page.waitForTimeout(800);
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(200);
  await page.click('[data-act="passSet"]'); await page.waitForTimeout(3000);
  const t = puts.filter(p=>p.key==='todos').pop();
  ok(t && t.data.enc==='aes-gcm', 'やることリストも暗号化して保存する');
  ok(!JSON.stringify(t.data).includes('こっそり'), '中身が読み取れない');
});

// 22) アプリとして入れたときの自動更新
await run('自動更新', {files:{settings:null, expenses:null, chat:null, todos:null}}, async (page)=>{
  // 付属品が配られているか
  for (const f of ['manifest.webmanifest','sw.js','icon-192.png','icon-512.png','apple-touch-icon.png']){
    const res = await page.request.get(url+f);
    ok(res.status()===200, f+' が配られている');
  }
  const man = await (await page.request.get(url+'manifest.webmanifest')).json();
  ok(man.display==='standalone' && man.start_url==='./', 'アプリとして開く設定になっている');
  // 取り付けられたか
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller, null, {timeout:20000});
  ok(true, '更新のしくみが取り付けられる');
  // 新しい版を置くと、自分で読み込み直すか
  await page.evaluate(()=>{ window.__before = true; });
  const sw = readFileSync(join(ROOT,'sw.js'),'utf8').replace(/VERSION = "[^"]+"/, 'VERSION = "9999-99-99z"');
  overrides.set('/sw.js', sw);
  await page.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>r && r.update()));
  await page.waitForFunction(()=>window.__before===undefined, null, {timeout:40000});
  ok(true, '新しい版が出ると自分で切り替わる');
  overrides.delete('/sw.js');
});

// 23) 端末が暗いテーマでも白で表示する
{
  const ctx = await browser.newContext({colorScheme:'dark'});
  await ctx.route('https://api.github.com/**', r=>r.fulfill({status:404, headers:CORS, body:'{}'}));
  const page = await ctx.newPage();
  const errs=[];
  page.on('pageerror', e=>errs.push(String(e)));
  await page.goto(url); await page.waitForTimeout(900);
  console.log('\n[白で統一]');
  ok(errs.length===0, 'JSエラーなし');
  const bg = await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);
  const ink = await page.evaluate(()=>getComputedStyle(document.body).color);
  ok(bg==='rgb(237, 241, 239)', '端末が暗いテーマでも背景は白基調（'+bg+'）');
  ok(ink==='rgb(28, 42, 39)', '文字は濃い色のまま（'+ink+'）');
  ok(await page.evaluate(()=>document.documentElement.getAttribute('data-theme'))==='light', 'テーマは light で固定');
  ok(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)==='light', '入力欄も白基調（color-scheme: light）');
  const card = await page.evaluate(()=>{ const c=document.querySelector('#view .card'); return c? getComputedStyle(c).backgroundColor : ''; });
  ok(card==='rgb(255, 255, 255)', 'カードは白（'+card+'）');
  const html = await page.content();
  ok(!/prefers-color-scheme/.test(html), '暗いテーマの指定そのものが残っていない');
  await ctx.close();
}

// 24) 検索に出ないようにしてある
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('https://api.github.com/**', r=>r.fulfill({status:404, headers:CORS, body:'{}'}));
  await page.goto(url); await page.waitForTimeout(400);
  console.log('\n[検索よけ]');
  const robots = await page.evaluate(()=>{
    const m=document.querySelector('meta[name="robots"]'); return m? m.content : '';
  });
  ok(/noindex/.test(robots), 'ページに noindex が付いている（'+robots+'）');
  ok(/nofollow/.test(robots), 'リンクもたどらせない');
  const res = await page.request.get(url+'robots.txt');
  ok(res.status()===200, 'robots.txt が配られている');
  const body = await res.text();
  ok(/User-agent:\s*\*/.test(body) && /Disallow:\s*\//.test(body), 'robots.txt で全部を対象外にしている');
  await ctx.close();
}

// 25) 初期費用のメモ
await run('初期費用のメモ', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page,{puts})=>{
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(300);
  ok(await page.locator('.item.chk .memo').count()===0, '最初はメモ欄が出ていない');
  ok(await page.locator('[data-act="toggleNote"]').count()>0, '項目ごとにメモのボタンがある');
  await page.locator('[data-act="toggleNote"]').first().click(); await page.waitForTimeout(300);
  ok(await page.locator('.item.chk .memo').count()===1, '押すとメモ欄が開く');
  const box = page.locator('.item.chk .memo input[id^="nt-"]').first();
  await box.fill('A不動産は1か月、B社は2か月');
  await box.blur(); await page.waitForTimeout(2200);
  const st = puts.filter(p=>p.key==='settings').pop();
  ok(st && st.data.initial.some(x=>x.note==='A不動産は1か月、B社は2か月'), 'メモがGitHubに保存される');
  // 書いたメモは、開き直しても出たまま
  await page.click('[data-tab="home"]'); await page.waitForTimeout(200);
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(300);
  ok((await page.inputValue('.item.chk .memo input[id^="nt-"]'))==='A不動産は1か月、B社は2か月', 'タブを移っても残る');
  ok(await page.locator('[data-act="toggleNote"].on').count()>=1, 'メモがある項目は印が付く');
  // 空にすると閉じられる
  await page.locator('.item.chk .memo input[id^="nt-"]').first().fill('');
  await page.locator('.item.chk .memo input[id^="nt-"]').first().blur(); await page.waitForTimeout(600);
  await page.locator('[data-act="toggleNote"]').first().click(); await page.waitForTimeout(300);
  ok(await page.locator('.item.chk .memo').count()===0, 'もう一度押すと閉じる');
});

// 26) 長押しで並べ替え
await run('初期費用の並べ替え', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page,{puts})=>{
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(350);
  const names = async () => page.evaluate(()=>[...document.querySelectorAll('.item.chk[data-g="contract"] .lbl')].map(i=>i.value));
  const before = await names();
  ok(before[0]==='敷金（保証金）' && before[1]==='礼金', '最初の並びを確認');
  const rows = page.locator('.item.chk[data-g="contract"]');
  await rows.nth(0).scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  const grip = await rows.nth(0).locator('[data-grip]').boundingBox();
  const c = await rows.nth(2).boundingBox();
  await page.mouse.move(grip.x + grip.width/2, grip.y + grip.height/2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width/2, c.y + c.height/2 + 6, {steps:8});
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await names();
  ok(after[0]!=='敷金（保証金）', 'つまんで動かすと順番が変わる');
  ok(after.indexOf('敷金（保証金）')>0, '下に移った');
  ok(after.length===before.length, '件数は変わらない');
  ok(after.slice().sort().join()===before.slice().sort().join(), '中身は失われない');
  const st = puts.filter(p=>p.key==='settings').pop();
  ok(st && st.data.initial.filter(x=>x.g==='contract').map(x=>x.label).join()===after.join(), '並びがGitHubに保存される');
  // 短く押しただけでは動かない
  await page.locator('.item.chk[data-g="move"]').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  const b2 = await page.locator('.item.chk[data-g="move"]').first().boundingBox();
  const before2 = await page.evaluate(()=>[...document.querySelectorAll('.item.chk[data-g="move"] .lbl')].map(i=>i.value));
  await page.mouse.move(b2.x + b2.width - 60, b2.y + b2.height/2);
  await page.mouse.down(); await page.waitForTimeout(80);
  await page.mouse.move(b2.x + b2.width - 60, b2.y + b2.height/2 + 80, {steps:5});
  await page.mouse.up(); await page.waitForTimeout(400);
  const after2 = await page.evaluate(()=>[...document.querySelectorAll('.item.chk[data-g="move"] .lbl')].map(i=>i.value));
  ok(after2.join()===before2.join(), '短く押して動かしただけでは並べ替えない（画面スクロールを邪魔しない）');
  // 行の余白を長押ししても動く
  const r3 = page.locator('.item.chk[data-g="furniture"]');
  await r3.nth(0).scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  const before3 = await page.evaluate(()=>[...document.querySelectorAll('.item.chk[data-g="furniture"] .lbl')].map(i=>i.value));
  const f0 = await r3.nth(0).boundingBox(), f2 = await r3.nth(2).boundingBox();
  await page.mouse.move(f0.x + 30, f0.y + f0.height/2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.move(f0.x + 30, f2.y + f2.height/2 + 6, {steps:8});
  await page.waitForTimeout(150);
  await page.mouse.up(); await page.waitForTimeout(800);
  const after3 = await page.evaluate(()=>[...document.querySelectorAll('.item.chk[data-g="furniture"] .lbl')].map(i=>i.value));
  ok(after3[0]!==before3[0], '行を長押ししても並べ替えられる');
  ok(after3.slice().sort().join()===before3.slice().sort().join(), '中身は失われない');
});

// 27) 足したばかりの欄が、相手の読み込みで消えない
await run('追加が消えない', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page,{files})=>{
  await page.waitForTimeout(500);
  // GitHub側には「追加前」の内容が入っている状態を作る
  const base = JSON.parse(JSON.stringify(files.settings));
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(300);
  const n0 = await page.locator('.item.chk[data-g="move"]').count();
  // 追加した直後に、相手の読み込みを起こす
  await page.click('[data-act="addInit"][data-g="move"]');
  files.settings = base;                      // 相手側は古いまま
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1800);
  const n1 = await page.locator('.item.chk[data-g="move"]').count();
  ok(n1===n0+1, '追加した欄が残っている（'+n0+'→'+n1+'）');
  ok((await page.evaluate(()=>[...document.querySelectorAll('.item.chk[data-g="move"] .lbl')].map(i=>i.value))).includes('新しい項目'), '中身も残っている');
  await page.waitForTimeout(1200);
  ok(files.settings.initial.filter(x=>x.g==='move').length===n0+1, 'GitHub側にも届いている');
});

// 28) 優先順位の色分け
await run('優先順位の色', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page)=>{
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(350);
  const cls = () => page.evaluate(() =>
    [...document.querySelectorAll('.item.chk[data-idx]')].map(r => ({
      label: r.querySelector('.lbl').value,
      pri: ['pri1','pri2','pri3','pri4','prioff'].find(c => r.classList.contains(c))
    })));
  const a = await cls();
  ok(a.slice(0,5).every(x=>x.pri==='pri1'), '上から5件が赤（pri1）');
  ok(a[5].pri==='pri2' && a[9].pri==='pri2', '6〜10件目はだいだい（pri2）');
  ok(a[10].pri==='pri3' && a[14].pri==='pri3', '11〜15件目は黄（pri3）');
  ok(a[15].pri==='pri4', '16件目からは緑（pri4）');
  ok((await page.textContent('#view')).includes('1〜5位'), '凡例が出ている');
  // 用意済みにすると順位から外れ、下が繰り上がる
  const sixth = a[5].label;
  await page.locator('.item.chk[data-idx] input[type=checkbox]').first().check();
  await page.waitForTimeout(700);
  const b = await cls();
  ok(b[0].pri==='prioff', '用意済みは灰色（prioff）');
  ok(b.find(x=>x.label===sixth).pri==='pri1', '用意済みの分だけ繰り上がる');
  ok(b.filter(x=>x.pri==='pri1').length===5, '赤はいつも5件');
});

// 29) 長い項目名が見切れない
await run('長い名前が全部見える', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page)=>{
  const LONG = '敷金（保証金）※B不動産は家賃2か月分、C社は1か月分。退去時の原状回復費を差し引いて返金される分と、ハウスクリーニング代の扱いを契約前に必ず確認すること';
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(350);
  const box = page.locator('.item.chk .lbl').first();
  await box.scrollIntoViewIfNeeded();
  const one = await box.evaluate(el=>el.clientHeight);
  await box.fill(LONG);
  await page.waitForTimeout(250);
  const m = await box.evaluate(el=>({
    clipped: el.scrollHeight > el.clientHeight + 2,
    h: el.clientHeight,
    value: el.value,
    tag: el.tagName
  }));
  ok(m.tag==='TEXTAREA', '名前の欄は折り返す欄になっている');
  ok(!m.clipped, '文字が隠れていない（はみ出しなし）');
  ok(m.h > one, '行が増えたぶん高さが伸びる（'+one+'→'+m.h+'）');
  ok(m.value===LONG, '入力した文字がそのまま入っている');
  // 保存して開き直しても、折り返したまま全部見える
  await box.blur(); await page.waitForTimeout(1200);
  await page.click('[data-tab="home"]'); await page.waitForTimeout(200);
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(400);
  const again = await page.locator('.item.chk .lbl').first().evaluate(el=>({
    clipped: el.scrollHeight > el.clientHeight + 2, h: el.clientHeight, v: el.value }));
  ok(again.v===LONG && !again.clipped && again.h>one, '描き直したあとも全部見える');
  // 金額の欄は押し出されずに残っている
  ok(await page.locator('.item.chk').first().locator('.yen').isVisible(), '金額の欄はそのまま');
});

// 30) 商品ページへのリンク
await run('項目のリンク', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page,{puts})=>{
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(350);
  // 家具・家電の1件目（冷蔵庫）にリンクを入れる
  const row = page.locator('.item.chk[data-g="furniture"]').first();
  await row.scrollIntoViewIfNeeded();
  ok(await row.locator('a.linkbtn').count()===0, 'リンクが無いうちは ↗ が出ない');
  await row.locator('[data-act="toggleNote"]').click(); await page.waitForTimeout(300);
  const url = 'https://www.amazon.co.jp/dp/B0EXAMPLE?th=1';
  await row.locator('input[type=url]').fill(url);
  await row.locator('input[type=url]').blur(); await page.waitForTimeout(900);
  const a = row.locator('a.linkbtn');
  ok(await a.count()===1, 'リンクを入れると ↗ が出る');
  ok(await a.getAttribute('href')===url, '入れたURLに飛ぶ');
  ok(await a.getAttribute('target')==='_blank', '新しいタブで開く');
  ok((await a.getAttribute('rel')||'').includes('noopener'), '開いた先から元のページを触られない（noopener）');
  ok((await row.locator('.linkhint').textContent()).includes('amazon.co.jp'), '行き先のサイト名が出る');
  const st = puts.filter(p=>p.key==='settings').pop();
  ok(st && st.data.initial.some(x=>x.url===url), 'リンクがGitHubに保存される');
  // 危ないURLはリンクにしない
  await row.locator('input[type=url]').fill('javascript:alert(1)');
  await row.locator('input[type=url]').blur(); await page.waitForTimeout(900);
  ok(await page.locator('.item.chk[data-g="furniture"]').first().locator('a.linkbtn').count()===0,
     'http(s) 以外はリンクにしない（javascript: を弾く）');
  ok(await page.evaluate(()=>window.__pwned===undefined), '仕込んだスクリプトが動かない');
});

// 31) 並べ替えの動きがなめらか
await run('並べ替えの動き', {files:{settings:null, expenses:null, chat:null, todos:null}, token:'github_pat_owner'}, async (page)=>{
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(350);
  const rows = page.locator('.item.chk[data-g="contract"]');
  await rows.nth(0).scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  const g = await rows.nth(0).locator('[data-grip]').boundingBox();
  const start = await rows.nth(0).boundingBox();
  await page.mouse.move(g.x+g.width/2, g.y+g.height/2);
  await page.mouse.down(); await page.waitForTimeout(80);
  // 行の高さの半分より小さく動かす（まだ入れ替わらない範囲）
  const dy = Math.floor(start.height/2) - 6;
  await page.mouse.move(g.x+g.width/2, g.y+g.height/2+dy, {steps:6});
  await page.waitForTimeout(80);
  const moved = await rows.nth(0).boundingBox();
  ok(Math.abs((moved.y - start.y) - dy) <= 3, '指の動きにそのまま付いてくる（ずれ '+Math.round(moved.y-start.y-dy)+'px）');
  ok(await page.locator('.item.chk.dragging').count()===1, 'つかんでいる行が浮いて見える');
  const t = await page.locator('.item.chk.dragging').evaluate(el=>getComputedStyle(el).transform);
  ok(t && t!=='none', 'つかんでいる行に位置のずらしが当たっている');
  // さらに動かして入れ替え、よけた行に滑りの指定が入る
  const third = await rows.nth(2).boundingBox();
  await page.mouse.move(g.x+g.width/2, third.y+third.height/2+6, {steps:8});
  await page.waitForTimeout(40);
  const sliding = await page.evaluate(()=>[...document.querySelectorAll('.item.chk[data-g="contract"]')]
      .filter(r=>!r.classList.contains('dragging'))
      .some(r=>/transform/.test(r.style.transition||'')));
  ok(sliding, 'よけた行が滑って動く（transitionが当たる）');
  await page.mouse.up();
  await page.waitForTimeout(900);
  const leftover = await page.evaluate(()=>[...document.querySelectorAll('.item.chk')]
      .some(r=>r.style.transform || r.style.transition || r.style.willChange));
  ok(!leftover, '離したあとは指定が残らない（元の見た目に戻る）');
  ok(await page.locator('.item.chk.dragging').count()===0, '浮いた見た目も解除される');
});

// 32〜33) 参考リンク
await run('参考リンク', {files:{settings:null, expenses:null, chat:null, todos:null, links:null}, token:'github_pat_owner'}, async (page,{puts,files})=>{
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(350);
  ok(await page.evaluate(()=>{ const c=document.querySelector('#view .card'); return !!c && c.textContent.includes('参考リンク'); }),
     '初期費用タブのいちばん上にある');
  ok(await page.locator('#refGo').isHidden(), 'URLを貼る前は「開く」が出ない');
  // 貼った瞬間に飛べる
  const U1 = 'https://suumo.jp/chintai/jnc_000012345678/';
  await page.fill('#refUrl', U1);
  ok(await page.locator('#refGo').isVisible(), '貼った瞬間に「開く」が出る（追加する前から）');
  ok(await page.locator('#refGo').getAttribute('href')===U1, '「開く」の行き先が貼ったURL');
  ok(await page.locator('#refGo').getAttribute('target')==='_blank', '新しいタブで開く');
  ok((await page.locator('#refGo').getAttribute('rel')||'').includes('noopener'), 'noopenerが付いている');
  await page.fill('#refTitle', '松本駅近の2LDK');
  await page.click('#refForm button[type=submit]'); await page.waitForTimeout(900);
  const first = page.locator('.refs .ref').first();
  ok((await first.locator('.refttl').textContent()).includes('松本駅近の2LDK'), 'タイトルで一覧に並ぶ');
  ok(await first.locator('a.reft').getAttribute('href')===U1, 'タイトルを押すと飛べる（ほしい物リストのように）');
  ok((await first.locator('.refhost').textContent()).includes('suumo.jp'), '行き先のサイト名が出る');
  ok((await page.inputValue('#refUrl'))==='' && (await page.inputValue('#refTitle'))==='', '追加すると入力欄が空になる');
  const l1 = puts.filter(p=>p.key==='links').pop();
  ok(l1 && l1.data.some(x=>x.url===U1 && x.title==='松本駅近の2LDK'), 'GitHubに保存される');
  // 共有シートの「文字＋URL」をそのまま貼る
  await page.fill('#refUrl', 'ニトリ 冷蔵庫 2ドア https://www.nitori-net.jp/ec/product/9999999s/');
  ok((await page.inputValue('#refUrl'))==='https://www.nitori-net.jp/ec/product/9999999s/', '文字が混ざっていてもURLだけ取り出す');
  ok((await page.inputValue('#refTitle'))==='ニトリ 冷蔵庫 2ドア', '残りの文字はタイトルに回る');
  await page.click('#refForm button[type=submit]'); await page.waitForTimeout(900);
  ok(await page.locator('.refs .ref').count()===2, '2件になる');
  ok((await page.locator('.refs .ref').first().locator('.refttl').textContent()).includes('ニトリ'), '新しいものが上に来る');
  // 同じURLは二重に入れない
  await page.fill('#refUrl', U1); await page.click('#refForm button[type=submit]'); await page.waitForTimeout(500);
  ok(await page.locator('.refs .ref').count()===2, '同じURLは二重に入らない');
  ok((await page.textContent('#toast')).includes('もう入っています'), 'その旨を知らせる');
  // 危ないURLは入らない
  await page.fill('#refUrl', 'javascript:alert(1)');
  ok(await page.locator('#refGo').isHidden(), 'javascript: には「開く」を出さない');
  await page.click('#refForm button[type=submit]'); await page.waitForTimeout(400);
  ok(await page.locator('.refs .ref').count()===2, 'javascript: は追加されない');
  // 相手が足した分を取り込む
  await page.fill('#refUrl', '');
  const cur = puts.filter(p=>p.key==='links').pop().data;
  files.links = [...cur, {id:'link-partner', title:'引越し見積もり比較', url:'https://example.com/hikkoshi', at:1, by:1}];
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.click('[data-act="ghSync"]'); await page.waitForTimeout(800);
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(350);
  ok((await page.textContent('.refs')).includes('引越し見積もり比較'), '相手が足した分が出る');
  // 消す
  const n0 = await page.locator('.refs .ref').count();
  await page.locator('.refs .ref').first().locator('[data-act="delLink"]').click(); await page.waitForTimeout(900);
  ok(await page.locator('.refs .ref').count()===n0-1, '消せる');
  const l2 = puts.filter(p=>p.key==='links').pop();
  ok(l2.data.length===n0-1 && l2.data.some(x=>x.id==='link-partner'), '消したことがGitHubに反映され、相手の分は残る');
});

await run('参考リンクも暗号化される', {files:{settings:null, expenses:null, chat:null, todos:null, links:null}, token:'github_pat_owner'}, async (page,{puts})=>{
  const answers=[PASS,PASS];
  page.on('dialog', d=>d.accept(answers.shift() ?? ''));
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(300);
  await page.fill('#refUrl', 'https://example.com/himitsu-bukken');
  await page.click('#refForm button[type=submit]'); await page.waitForTimeout(800);
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(200);
  await page.click('[data-act="passSet"]'); await page.waitForTimeout(3000);
  const l = puts.filter(p=>p.key==='links').pop();
  ok(l && l.data.enc==='aes-gcm', '参考リンクも暗号化して保存する');
  ok(!JSON.stringify(l.data).includes('himitsu'), 'URLが読み取れない');
});

// 35〜36) おすすめ物件
const F0 = ()=>({settings:null, expenses:null, chat:null, todos:null, links:null, homes:null});
async function addHome(page, h){
  await page.click('[data-act="homeFormOpen"]'); await page.waitForTimeout(250);
  const f = page.locator('#homeForm');
  if (h.url) await f.locator('[data-hd="url"]').fill(h.url);
  if (h.title) await f.locator('[data-hd="title"]').fill(h.title);
  if (h.city) await f.locator('[data-hd="city"]').selectOption(h.city);
  if (h.rent!=null) await f.locator('[data-hd="rent"]').fill(String(h.rent));
  if (h.kanri!=null) await f.locator('[data-hd="kanri"]').fill(String(h.kanri));
  if (h.layout) await f.locator('[data-hd="layout"]').selectOption(h.layout);
  if (h.areaM2!=null) await f.locator('[data-hd="areaM2"]').fill(String(h.areaM2));
  for (const k of (h.feats||[])) await f.locator(`[data-act="hdFeat"][data-k="${k}"]`).click();
  await f.locator('button[type=submit]').click(); await page.waitForTimeout(700);
}
await run('おすすめ物件', {files:F0(), token:'github_pat_owner'}, async (page,{puts,files})=>{
  page.on('dialog', d=>d.accept());
  await page.click('[data-tab="bukken"]'); await page.waitForTimeout(350);
  ok(await page.locator('.condsum').count()===1, '物件タブに条件のまとめが出る');
  const sum0 = await page.textContent('.condsum');
  ok(sum0.includes('松本') && sum0.includes('2LDK') && sum0.includes('必須 2人入居可'), '最初の条件（松本・2LDKなど・2人入居可が必須）');
  // 探しに行くリンク
  const canary = page.locator('a[href^="https://web.canary-app.jp/chintai/nagano/cities/"]');
  ok(await canary.count()===1, '選んだエリアのカナリーへのリンクがある');
  ok(await canary.getAttribute('target')==='_blank' && (await canary.getAttribute('rel')||'').includes('noopener'), '新しいタブで安全に開く');
  ok(await page.locator('a[href="https://suumo.jp/chintai/nagano/sc_matsumoto/"]').count()===1, 'SUUMOの松本市ページへのリンクもある');
  // 条件を変える
  await page.click('[data-act="condToggle"]'); await page.waitForTimeout(250);
  await page.click('[data-act="condCity"][data-k="shiojiri"]'); await page.waitForTimeout(400);
  ok((await page.textContent('.condsum')).includes('塩尻'), 'エリアを足せる');
  ok(await page.locator('a[href^="https://web.canary-app.jp/"]').count()===2, '足したエリアの探すリンクも増える');
  const featBtn = ()=>page.locator('[data-act="condFeat"][data-k="oidaki"]');
  const st0 = await featBtn().getAttribute('class');
  ok(st0.includes('want'), '追い焚きは最初「あれば嬉しい」');
  await featBtn().click(); await page.waitForTimeout(300);
  ok((await featBtn().getAttribute('class')).includes('must'), 'もう一度押すと「必須」');
  await featBtn().click(); await page.waitForTimeout(300);
  ok(!/want|must/.test(await featBtn().getAttribute('class')), 'さらに押すと外れる');
  await featBtn().click(); await page.waitForTimeout(300);   // 「あれば嬉しい」に戻す
  ok(await page.locator('select#f-search-maxRent').count()===1 && await page.locator('select#f-search-minArea').count()===1, '賃料の上限と面積も選択式（打ち込まない）');
  ok(await page.locator('#view input[data-f^="search."]').count()===0, '条件に打ち込む欄はない');
  const rentOpts = await page.$$eval('#f-search-maxRent option', o=>o.map(x=>x.textContent));
  ok(rentOpts.includes('7.5万円以下') && rentOpts.includes('指定なし'), '「7.5万円以下」「指定なし」などから選べる');
  await page.selectOption('#f-search-maxRent', '70000'); await page.waitForTimeout(700);
  ok((await page.textContent('.condsum')).includes('¥70,000以下'), '選ぶとすぐ条件に反映される');
  await page.selectOption('#f-search-maxRent', '75000'); await page.waitForTimeout(700);
  await page.selectOption('#f-search-minArea', '45'); await page.waitForTimeout(500);
  ok((await page.textContent('.condsum')).includes('45㎡以上'), '面積も選ぶと反映される');
  await page.selectOption('#f-search-minArea', '40'); await page.waitForTimeout(500);
  const sp = puts.filter(p=>p.key==='settings').pop();
  ok(sp && sp.data.search && sp.data.search.cities.includes('shiojiri'), '条件も2人で共有される（GitHubに保存）');
  await page.click('[data-act="condToggle"]'); await page.waitForTimeout(200);
  ok(await page.locator('.home').count()===0 && (await page.textContent('#view')).includes('まだ候補がありません'), '最初は候補なし');
  // 追加：共有シートの「文字＋URL」を貼る
  await page.click('[data-act="homeFormOpen"]'); await page.waitForTimeout(250);
  await page.locator('#homeForm [data-hd="url"]').fill('グリーンハイツ 201 https://web.canary-app.jp/chintai/rooms/abc123/');
  ok((await page.locator('#homeForm [data-hd="url"]').inputValue())==='https://web.canary-app.jp/chintai/rooms/abc123/', 'URLだけ取り出す');
  ok((await page.locator('#homeForm [data-hd="title"]').inputValue())==='グリーンハイツ 201', '残りの文字は物件名に回る');
  await page.locator('#homeForm [data-hd="city"]').selectOption('matsumoto');
  await page.locator('#homeForm [data-hd="rent"]').fill('66000');
  await page.locator('#homeForm [data-hd="kanri"]').fill('3000');
  await page.locator('#homeForm [data-hd="layout"]').selectOption('2LDK');
  await page.locator('#homeForm [data-hd="areaM2"]').fill('52.5');
  for (const k of ['two','park','sepbath','oidaki']) await page.locator(`#homeForm [data-act="hdFeat"][data-k="${k}"]`).click();
  ok(await page.locator('#homeForm [data-act="hdFeat"][data-k="two"]').getAttribute('aria-pressed')==='true', '当てはまるものを押すと選ばれる');
  await page.click('[data-tab="home"]'); await page.waitForTimeout(150); await page.click('[data-tab="bukken"]'); await page.waitForTimeout(250);
  ok((await page.locator('#homeForm [data-hd="title"]').inputValue())==='グリーンハイツ 201', 'タブを移っても書きかけが消えない');
  await page.locator('#homeForm button[type=submit]').click(); await page.waitForTimeout(800);
  ok(await page.locator('.home').count()===1 && await page.locator('#homeForm').count()===0, '候補に入り、入力欄が閉じる');
  const h1 = puts.filter(p=>p.key==='homes').pop();
  ok(h1 && h1.data[0].title==='グリーンハイツ 201' && h1.data[0].rent===66000 && h1.data[0].areaM2===52.5, 'GitHubに保存される');
  ok(await page.locator('.home .ttl a').first().getAttribute('href')==='https://web.canary-app.jp/chintai/rooms/abc123/', '物件名を押すと物件ページに飛べる');
  // 条件外（予算オーバー・駐車場なし）
  await addHome(page, {title:'高いマンション', city:'matsumoto', rent:90000, kanri:5000, layout:'2LDK', areaM2:60, feats:['two']});
  // 設備が多い物件（こちらが1位になるはず）
  await addHome(page, {title:'設備充実アパート', city:'shiojiri', rent:64000, kanri:2000, layout:'2DK', areaM2:48, feats:['two','park','sepbath','washroom','oidaki','citygas','cold']});
  const order = await page.$$eval('.home .ttl', a=>a.map(x=>x.textContent.trim()));
  ok(order[0]==='設備充実アパート' && order[1]==='グリーンハイツ 201' && order[2]==='高いマンション', 'おすすめ順に並ぶ（条件外は最後）：'+order.join(' / '));
  ok((await page.locator('.home').first().locator('.rank').textContent()).includes('1位'), '1位の表示');
  const ng = page.locator('.home.ng');
  ok(await ng.count()===1, '条件外は1件');
  const ngt = await ng.textContent();
  ok(ngt.includes('条件外') && ngt.includes('オーバー') && ngt.includes('駐車場あり'), '条件外の理由が出る（予算オーバー・必須の駐車場）');
  // 条件を変えると並びも変わる：上限を上げて駐車場を外す
  await page.click('[data-act="condToggle"]'); await page.waitForTimeout(250);
  await page.selectOption('#f-search-maxRent', '100000'); await page.waitForTimeout(500);
  const park = page.locator('[data-act="condFeat"][data-k="park"]');
  await park.click(); await page.waitForTimeout(300);   // 必須 → 外す
  ok(await page.locator('.home.ng').count()===0, '条件をゆるめると条件外がなくなる');
  await page.click('[data-act="condToggle"]'); await page.waitForTimeout(200);
  // この家賃で試算
  await page.locator('.home', {hasText:'グリーンハイツ 201'}).locator('[data-act="homeUse"]').click(); await page.waitForTimeout(700);
  const sb = puts.filter(p=>p.key==='settings').pop().data;
  ok(sb.budget.find(b=>b.id==='rent').amt===66000 && sb.budget.find(b=>b.id==='kanri').amt===3000, '「この家賃で試算」で予算の家賃・管理費が変わる');
  // お気に入り
  const g = ()=>page.locator('.home', {hasText:'グリーンハイツ 201'});
  await g().locator('[data-act="homeFav"]').click(); await page.waitForTimeout(700);
  ok((await g().locator('[data-act="homeFav"]').textContent())==='★', '★を付けられる');
  ok(puts.filter(p=>p.key==='homes').pop().data.find(x=>x.title==='グリーンハイツ 201').fav===true, '★も保存される');
  // 直す
  await g().locator('[data-act="homeEdit"]').click(); await page.waitForTimeout(300);
  ok((await page.locator('#homeForm [data-hd="rent"]').inputValue())==='66000', '直すと今の値が入った状態で開く');
  await page.locator('#homeForm [data-hd="rent"]').fill('61000');
  await page.locator('#homeForm button[type=submit]').click(); await page.waitForTimeout(800);
  const h2 = puts.filter(p=>p.key==='homes').pop().data;
  ok(h2.length===3 && h2.find(x=>x.title==='グリーンハイツ 201').rent===61000, '直した内容で上書き（増えない）');
  ok(h2.find(x=>x.title==='グリーンハイツ 201').fav===true, '直しても★は残る');
  // 相手が足した分を取り込む
  files.homes = [...h2, {id:'home-partner', title:'相手が見つけた家', city:'azumino', rent:58000, kanri:0, layout:'3DK', areaM2:62, walk:'', age:'', btype:'', feats:['two','park'], memo:'', at:1, by:1}];
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(150);
  await page.click('[data-act="ghSync"]'); await page.waitForTimeout(800);
  await page.click('[data-tab="bukken"]'); await page.waitForTimeout(300);
  ok((await page.textContent('.homes')).includes('相手が見つけた家'), '相手が足した物件が出る');
  // 消す
  await page.locator('.home', {hasText:'高いマンション'}).locator('[data-act="homeDel"]').click(); await page.waitForTimeout(800);
  const h3 = puts.filter(p=>p.key==='homes').pop().data;
  ok(!h3.some(x=>x.title==='高いマンション') && h3.some(x=>x.id==='home-partner'), '消したことがGitHubに反映され、相手の分は残る');
  // 危ないURLはリンクにしない
  await page.click('[data-act="homeFormOpen"]'); await page.waitForTimeout(250);
  await page.locator('#homeForm [data-hd="url"]').fill('javascript:alert(1)');
  await page.locator('#homeForm [data-hd="title"]').fill('あやしい');
  await page.locator('#homeForm button[type=submit]').click(); await page.waitForTimeout(500);
  ok(!(await page.textContent('.homes')).includes('あやしい'), 'javascript: のURLは入らない');
  ok(await page.locator('.homes a[href^="javascript"]').count()===0, '危ないリンクは作らない');
});

await run('候補物件も暗号化される', {files:F0(), token:'github_pat_owner'}, async (page,{puts})=>{
  const answers=[PASS,PASS];
  page.on('dialog', d=>d.accept(answers.shift() ?? ''));
  await page.click('[data-tab="bukken"]'); await page.waitForTimeout(300);
  await addHome(page, {title:'ひみつ荘', city:'matsumoto', rent:60000});
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(200);
  await page.click('[data-act="passSet"]'); await page.waitForTimeout(3000);
  const h = puts.filter(p=>p.key==='homes').pop();
  ok(h && h.data.enc==='aes-gcm', '候補物件も暗号化して保存する');
  ok(!JSON.stringify(h.data).includes('ひみつ'), '物件名が読み取れない');
});

// 37〜38) チャットの通知
const spyNotes = ()=>{
  window.__notes=[];
  const rec=(t,o)=>window.__notes.push({title:t, body:(o||{}).body||'', hidden:document.hidden});
  if (window.ServiceWorkerRegistration){ ServiceWorkerRegistration.prototype.showNotification=function(t,o){ rec(t,o); return Promise.resolve(); }; }
  if (window.Notification){ const N=window.Notification; window.Notification=function(t,o){ rec(t,o); }; window.Notification.permission=N.permission; window.Notification.requestPermission=N.requestPermission.bind(N);
    Object.defineProperty(window.Notification,'permission',{get:()=>N.permission}); }
  localStorage.setItem('futari.me','0');
};
await run('チャットの通知', {files:{...F0(), chat:[{id:'old1', who:1, text:'前の発言', at:1000}]}, token:'github_pat_owner', perms:['notifications'], init:spyNotes}, async (page,{files})=>{
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(300);
  ok((await page.textContent('.notirow')).includes('通知はオフ'), '最初は通知オフ');
  await page.click('[data-act="notifyOn"]'); await page.waitForTimeout(300);
  ok((await page.textContent('.notirow')).includes('通知オン'), 'ボタンでオンにできる');
  ok(await page.evaluate(()=>localStorage.getItem('futari.notify'))==='1', 'この端末に覚える');
  ok((await page.evaluate(()=>window.__notes.length))===0, '開いた時点で届いていた昔の発言では鳴らない');
  // ほかのタブを見ているときに相手が書く
  await page.click('[data-tab="home"]'); await page.waitForTimeout(200);
  files.chat = [...files.chat, {id:'p1', who:1, text:'今日ごはんいる？', at:Date.now()+1000}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(800);
  const n1 = await page.evaluate(()=>window.__notes);
  ok(n1.length===1 && n1[0].title.includes('からメッセージ') && n1[0].body==='今日ごはんいる？', '相手の新しい発言で通知が出る（名前と本文）');
  ok(await page.locator('[data-tab="chat"] .tabdot').count()===1, 'チャットのタブにも印');
  // 同じ発言では二度鳴らない
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(600);
  ok((await page.evaluate(()=>window.__notes.length))===1, '同じ発言で二度は鳴らない');
  // 自分の発言では鳴らない
  files.chat = [...files.chat, {id:'m1', who:0, text:'自分の発言', at:Date.now()+2000}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(600);
  ok((await page.evaluate(()=>window.__notes.length))===1, '自分の発言では鳴らない');
  // チャットを開いて見ているときは鳴らさない
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(200);
  files.chat = [...files.chat, {id:'p2', who:1, text:'見てる間の発言', at:Date.now()+3000}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(800);
  ok((await page.evaluate(()=>window.__notes.length))===1, 'チャットを見ている間は鳴らさない');
  ok((await page.textContent('#chatwrap')).includes('見てる間の発言'), '（画面にはそのまま出る）');
  // オフにすると鳴らない
  await page.click('[data-act="notifyOff"]'); await page.waitForTimeout(200);
  ok((await page.textContent('.notirow')).includes('通知はオフ'), 'オフにできる');
  await page.click('[data-tab="home"]'); await page.waitForTimeout(200);
  files.chat = [...files.chat, {id:'p3', who:1, text:'オフ中の発言', at:Date.now()+4000}];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(800);
  ok((await page.evaluate(()=>window.__notes.length))===1, 'オフの間は鳴らない');
});

await run('通知から開くとチャット', {files:F0(), token:'github_pat_owner', hash:'?open=chat', init:()=>localStorage.setItem('futari.me','0')}, async (page)=>{
  ok((await page.getAttribute('[data-tab="chat"]','aria-selected'))==='true', '?open=chat で開くとチャット画面になる');
  ok(!page.url().includes('open=chat'), '開いたあとアドレスから消える（再読み込みで戻らない）');
  const sw = readFileSync(join(ROOT,'sw.js'),'utf8');
  ok(sw.includes('notificationclick') && sw.includes('./?open=chat'), '通知を押したときの動きが sw.js にある');
});

// 34) サンプル版
{
  const ctx = await browser.newContext();
  const apiCalls = [];
  await ctx.route('https://api.github.com/**', r=>{ apiCalls.push(r.request().url()); return r.fulfill({status:500, headers:CORS, body:'{}'}); });
  const page = await ctx.newPage();
  const errs=[];
  page.on('pageerror', e=>errs.push(String(e)));
  // 本物の持ち主が同じブラウザで使っている状態を作っておく
  await page.addInitScript(()=>{
    if (!sessionStorage.getItem('__seeded')){
      localStorage.setItem('futari.token','github_pat_REAL');
      localStorage.setItem('futari.pass','ほんものの合言葉');
      localStorage.setItem('futari.settings', JSON.stringify({names:['本物の名前A','本物の名前B']}));
      sessionStorage.setItem('__seeded','1');
    }
  });
  console.log('\n[サンプル版]');
  await page.goto(url+'demo/'); await page.waitForTimeout(1200);
  ok(page.url().includes('?demo'), '/demo/ から本体の ?demo に移る');
  ok(errs.length===0, 'JSエラーなし '+(errs[0]||''));
  ok(await page.locator('#demoBanner').isVisible(), 'サンプル版の帯が出る');
  ok((await page.textContent('#nameA'))==='Aさん' && (await page.textContent('#nameB'))==='Bさん', '名前は伏せてある（Aさん・Bさん）');
  ok(!(await page.textContent('body')).includes('本物の名前'), '本物の名前は一切出ない');
  ok((await page.textContent('#sync')).includes('サンプル'), '右上にサンプルと出る');
  ok(await page.locator('.todos li').count()>=5, 'やることリストに見本が入っている');
  ok(await page.locator('.todos li.st-over').count()>=1, '期限切れの見本もある（色分けが見える）');
  await page.click('[data-tab="initial"]'); await page.waitForTimeout(300);
  ok(await page.locator('.refs .ref').count()===3, '参考リンクの見本が入っている');
  ok(await page.locator('.item.chk.off').count()>=1, '用意済みの見本もある');
  await page.click('[data-tab="bukken"]'); await page.waitForTimeout(300);
  ok(await page.locator('.home').count()===4, '候補物件の見本が入っている');
  ok(await page.locator('.home.ng').count()>=1, '条件外の見本もある');
  await page.click('[data-tab="log"]'); await page.waitForTimeout(300);
  ok(await page.locator('.explist li').count()>=5, '家計簿に今月の見本が入っている');
  await page.click('[data-tab="chat"]'); await page.waitForTimeout(300);
  ok(await page.locator('.msg').count()===4, 'チャットの見本が入っている');
  await page.click('[data-tab="budget"]'); await page.waitForTimeout(300);
  ok(await page.locator('#ghToken').count()===0, 'GitHubにつなぐ欄は出ない');
  ok(await page.locator('[data-act="ghInvite"]').count()===0, '招待リンクも出ない（本物のトークンが漏れない）');
  // 触ってみる
  await page.click('[data-tab="home"]'); await page.waitForTimeout(200);
  await page.fill('#todoText','サンプルで足したやること'); await page.click('#todoForm button[type=submit]'); await page.waitForTimeout(500);
  ok((await page.textContent('.todos')).includes('サンプルで足したやること'), 'サンプルでも普通に触れる');
  ok(apiCalls.length===0, 'GitHubには一度もつながない（'+apiCalls.length+'回）');
  const real = await page.evaluate(()=>({
    token: localStorage.getItem('futari.token'),
    pass: localStorage.getItem('futari.pass'),
    settings: localStorage.getItem('futari.settings'),
    todos: localStorage.getItem('futari.todos'),
    demoTodos: localStorage.getItem('demo.futari.todos')
  }));
  ok(real.token==='github_pat_REAL' && real.pass==='ほんものの合言葉', '本物のトークンと合言葉はそのまま');
  ok(real.settings.includes('本物の名前A'), '本物の設定を上書きしない');
  ok(real.todos===null, '本物のやることリストに書き込まない');
  ok(real.demoTodos && real.demoTodos.includes('サンプルで足したやること'), 'サンプルの分は別の場所に残る');
  // 最初の状態に戻す
  page.on('dialog', d=>d.accept());
  await page.click('#demoBanner [data-act="demoReset"]'); await page.waitForTimeout(1500);
  ok(!(await page.textContent('.todos')).includes('サンプルで足したやること'), '「最初の状態に戻す」で見本に戻る');
  ok(await page.evaluate(()=>localStorage.getItem('futari.token'))==='github_pat_REAL', '戻しても本物には触れない');
  await ctx.close();
}

await browser.close(); srv.close();
console.log(fail? `\n${fail}件 失敗` : '\nすべて成功');
process.exit(fail?1:0);
