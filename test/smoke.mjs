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
               '.png':'image/png', '.txt':'text/plain', '.webmanifest':'application/manifest+json'};
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
  const rel = path.replace(/^\/+/,'');
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

async function run(name, {files, token, pass, repoStatus, hash, clipboard}, body){
  const ctx = await browser.newContext(clipboard ? {permissions:['clipboard-read','clipboard-write']} : {});
  const puts = [], urls = [];
  /* 余計な末尾スラッシュ（/repos/owner/repo/）は、本物のGitHubなら 400 かつCORSヘッダ無しで返る。
     ブラウザからは「Failed to fetch」としか見えない事故を再現するため、ここでも同じ扱いにする */
  const STRAY_SLASH = /\/repos\/[^/]+\/[^/]+\/(\?|$)/;
  await ctx.route('https://api.github.com/**', route=>{
    const req = route.request(), u = req.url(), m = req.method();
    urls.push(m+' '+u);
    if (STRAY_SLASH.test(u)) return route.fulfill({status:400, body:'{"message":"Bad Request"}'});
    if (m==='OPTIONS') return route.fulfill({status:204, headers:CORS});
    const keyOf = x => x.includes('settings') ? 'settings' : x.includes('chat') ? 'chat' : x.includes('todos') ? 'todos' : 'expenses';
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
  await page.fill('#todoDue', '2026-09-30');
  await page.click('#todoForm button[type=submit]'); await page.waitForTimeout(800);
  ok((await page.textContent('.todos')).includes('内見の予約をする'), '書いたものが追加される');
  ok((await page.textContent('.todos')).includes('9/30'), '期限が出る');
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
  ok(t && t.data.some(x=>x.text==='内見の予約をする' && x.due==='2026-09-30'), 'GitHubに書き込まれる');
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

await browser.close(); srv.close();
console.log(fail? `\n${fail}件 失敗` : '\nすべて成功');
process.exit(fail?1:0);
