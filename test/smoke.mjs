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

async function run(name, {files, token, repoStatus}, body){
  const ctx = await browser.newContext();
  const puts = [];
  await ctx.route('https://api.github.com/**', route=>{
    const req = route.request(), u = req.url(), m = req.method();
    if (m==='OPTIONS') return route.fulfill({status:204, headers:CORS});
    if (m==='PUT'){ const key = u.includes('settings')?'settings':'expenses';
      const b = JSON.parse(req.postData()||'{}');
      puts.push({key, data: JSON.parse(Buffer.from(b.content,'base64').toString('utf8'))});
      files[key] = puts[puts.length-1].data;
      return route.fulfill({status:200, headers:{...CORS,'content-type':'application/json'}, body: JSON.stringify({content:{sha:'sha-'+puts.length}})});
    }
    if (/\/contents\//.test(u)){ const key = u.includes('settings')?'settings':'expenses';
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
  await page.goto(url);
  await page.waitForTimeout(900);
  console.log('\n['+name+']');
  ok(errs.length===0, 'JSエラーなし '+(errs[0]||''));
  await body(page, {puts, files, errs});
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

await browser.close(); srv.close();
console.log(fail? `\n${fail}件 失敗` : '\nすべて成功');
process.exit(fail?1:0);
