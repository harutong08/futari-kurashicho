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
const HTML = readFileSync(join(HERE, '..', 'index.html'));
/* この環境にはPlaywright同梱のブラウザがないことがあるので、あればシステムのChromiumを使う */
const SYS = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(p => existsSync(p));
const srv = createServer((q,r)=>{ r.writeHead(200,{'content-type':'text/html; charset=utf-8'}); r.end(HTML); });
await new Promise(res=>srv.listen(0,res));
const url = 'http://127.0.0.1:'+srv.address().port+'/';

const CORS = {'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,OPTIONS'};
let fail = 0;
const ok = (c,m)=>{ console.log((c?'  ok  ':'  NG  ')+m); if(!c) fail++; };

const browser = await chromium.launch(SYS ? {executablePath:SYS} : {});

async function run(name, {files, token, repoStatus, hash, clipboard}, body){
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
    const keyOf = x => x.includes('settings') ? 'settings' : x.includes('chat') ? 'chat' : 'expenses';
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

await browser.close(); srv.close();
console.log(fail? `\n${fail}件 失敗` : '\nすべて成功');
process.exit(fail?1:0);
