/* 物件ページの読み取り（.github/scripts/listing.mjs と fetch-listing.mjs）の試験。
   実際のサイトの作りを真似た小さな見本で確かめる（本物のページはここに置かない）。
   使い方：node test/listing.mjs */
import {parseListing, normLayout, yenOf} from '../.github/scripts/listing.mjs';
import {run, idOf, okUrl} from '../.github/scripts/fetch-listing.mjs';
import {mkdtempSync, writeFileSync, readFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

let fail=0;
const ok=(c,m)=>{ console.log((c?'  ok  ':'  NG  ')+m); if(!c) fail++; };
const NOW=new Date('2026-10-01');
const page=(title, body)=>`<!doctype html><html><head><title>${title}</title></head><body>
  <nav><a>新築</a><a>ペット相談可</a><a>駅徒歩5分以内</a><a>オートロック</a></nav>${body}
  <footer><h2>この物件を取り扱う店舗</h2><p>松本駅 歩2分</p><p>駐車場あり</p></footer></body></html>`;

console.log('\n[部品]');
ok(yenOf('7.15万円')===71500 && yenOf('3,000円')===3000 && yenOf('なし')===0 && yenOf('-')===0, '金額の読み方（万円・円・なし）');
ok(normLayout('１ＳＬＤＫ')==='1LDK' && normLayout('ワンルーム')==='1R' && normLayout('2DK')==='2DK' && normLayout('4LDK')==='4K以上', '間取りをそろえる（S付き・ワンルーム・4部屋以上）');

console.log('\n[SUUMO]');
{
  const html=page('【SUUMO】サンプルハイツ／長野県松本市平田東３／平田駅の賃貸・部屋探し情報', `
  <ul><li>お気に入りに追加する</li></ul>
  <div>7.15万円</div><div>管理費・共益費: 3500円</div><div>敷金: -</div><div>礼金: 10.5万円</div>
  <table><tr><th>所在地</th><td>長野県松本市平田東３</td></tr>
  <tr><th>駅徒歩</th><td><div>ＪＲ篠ノ井線/平田駅 歩9分</div><div>ＪＲ篠ノ井線/松本駅 バス14分 (バス停)五月町 歩5分</div></td></tr>
  <tr><th>間取り</th><td>2LDK</td></tr><tr><th>専有面積</th><td>51.29m<sup>2</sup></td></tr>
  <tr><th>築年数</th><td>築7年</td></tr><tr><th>階</th><td>2階</td></tr><tr><th>建物種別</th><td>アパート</td></tr></table>
  <h3>部屋の特徴・設備</h3><li>バストイレ別、エアコン、追焚機能浴室、洗面所独立、2口コンロ、室内洗濯置、複層ガラス、保証人不要</li>
  <div>保証会社 ※ペット可は２．５万</div>
  <table><tr><th>駐車場</th><td>敷地内3300円</td></tr></table>`);
  const r=parseListing(html,'https://suumo.jp/chintai/jnc_000000000001/',NOW);
  ok(r.title==='サンプルハイツ' && r.city==='matsumoto', '建物名とエリア');
  ok(r.rent===71500 && r.kanri===3500 && r.shiki===0 && r.rei===105000, '家賃・管理費・敷金・礼金');
  ok(r.layout==='2LDK' && r.areaM2===51.29 && r.age===7 && r.btype==='apart' && r.floor===2, '間取り・面積・築年数・種類・階');
  ok(r.walk===9, '駅徒歩はバスを降りてからの徒歩を数えない（9分）');
  for (const k of ['sepbath','aircon','oidaki','washroom','stove2','washer','cold','noguar','park','floor2']) ok(r.feats.includes(k), '設備：'+k);
  ok(!r.feats.includes('pet') && !r.feats.includes('autolock'), '上のメニューや「ペット可は〜」の説明文では設備にしない');
}

console.log("\n[HOME'S]");
{
  const html=page("【ホームズ】サンプルコート[2LDK/賃料8.6万円/2階/58.7㎡]の賃貸アパート住宅情報", `
  <h2>基本情報</h2><dl><dt>賃料</dt><dd>8.6万円</dd><dt>管理費等</dt><dd>3,900円</dd><dt>敷金/礼金</dt><dd>なし/1.5ヶ月</dd>
  <dt>交通</dt><dd>JR篠ノ井線 松本駅 バス21分 白金下車 徒歩1分</dd><dd>JR大糸線 北松本駅 徒歩14分</dd>
  <dt>所在地</dt><dd>長野県松本市白板２丁目</dd><dt>築年月</dt><dd>2001年3月</dd><dt>間取り</dt><dd>2LDK ( LDK 12帖 )</dd>
  <dt>専有面積</dt><dd>58.7㎡</dd><dt>所在階/階数</dt><dd>2階/2階建</dd></dl>
  <h3>物件のこだわり／設備・条件</h3><ul><li>駐車場あり</li><li>(該当)</li><li>オートロック</li><li>(非該当)</li><li>ペット相談</li><li>(非該当)</li><li>バス・トイレ別</li><li>(該当)</li></ul>
  <div>入居条件</div><div>ペット不可、</div><div>二人入居可</div>`);
  const r=parseListing(html,'https://www.homes.co.jp/chintai/room/abc/',NOW);
  ok(r.title==='サンプルコート' && r.rent===86000 && r.kanri===3900 && r.shiki===0 && r.rei===129000, '名前・家賃・管理費・敷金なし・礼金1.5か月');
  ok(r.layout==='2LDK' && r.areaM2===58.7 && r.floor===2 && r.age===25, '間取り・面積・階・築年数（築年月から計算）');
  ok(r.walk===14, 'バスを降りてからの徒歩1分は数えない');
  ok(r.feats.includes('park') && r.feats.includes('sepbath') && r.feats.includes('two'), '「(該当)」の設備と二人入居可');
  ok(!r.feats.includes('autolock') && !r.feats.includes('pet'), '「(非該当)」とペット不可は設備にしない');
}

console.log('\n[CHINTAI]');
{
  const html=page('サンプル荘 1階／長野県塩尻市大門（家賃5.8万円/2DK）の賃貸物件情報 | CHINTAI', `
  <h2>物件概要</h2><dl><dt>家賃</dt><dd>5.8<span>万円</span></dd><dt>管理費等</dt><dd>2,000円</dd><dt>敷金 / 保証金</dt><dd>2ヶ月 / --</dd><dt>礼金 / 償却</dt><dd>-- / --</dd>
  <dt>交通</dt><dd>篠ノ井線/塩尻駅</dd><dd>徒歩 25<span>分</span></dd><dt>住所</dt><dd>長野県塩尻市大門</dd><dt>間取り</dt><dd>2DK</dd><dt>専有面積</dt><dd>39.6m²</dd>
  <dt>築年</dt><dd>1996年01月(築30年)</dd><dt>建物種別</dt><dd>アパート</dd><dt>物件階層</dt><dd>1階/2階建</dd></dl>
  <ul class="kodawari"><li class="bathToilet on"><span class="lazyload">バス・トイレ別</span></li><li class="autoLock"><span class="lazyload">オートロック</span></li><li class="parking on"><span class="lazyload">駐車場付き</span></li></ul>
  <p>プロパンガスは、災害時の復旧が早いが、一般的に都市ガスよりも価格が高くなる傾向がある。</p><div>無料駐車場 2台</div><div>二人入居可</div>
  <h2>この物件を見たい、空室状況を知りたい</h2><p>オートロック 都市ガス</p>`);
  const r=parseListing(html,'https://www.chintai.net/detail/bk-x/',NOW);
  ok(r.title==='サンプル荘 1階' && r.city==='shiojiri' && r.rent===58000 && r.kanri===2000 && r.shiki===116000 && r.rei===0, '名前・塩尻市・家賃・管理費・敷金2か月');
  ok(r.walk===25 && r.age===30 && r.layout==='2DK' && r.floor===1, '徒歩（行をまたいだ「徒歩 25 分」）・築年数・間取り・階');
  ok(r.feats.includes('sepbath') && r.feats.includes('park') && r.feats.includes('park2') && r.feats.includes('two'), 'ある設備（on）・駐車場2台・二人入居可');
  ok(!r.feats.includes('autolock') && !r.feats.includes('citygas'), '無い設備（onなし）と用語の説明文は設備にしない');
}

console.log('\n[Yahoo!不動産]');
{
  const html=page('サンプルハイツII 長野県松本市村井町北1 (6万円／2DK)｜賃貸物件', `
  <div>アパート</div><dl><dt>賃料</dt><dd>6 万円</dd><dt>管理費・共益費等：</dt><dd>なし</dd><dt>敷金：</dt><dd>2ヶ月</dd><dt>礼金：</dt><dd>なし</dd></dl>
  <dl><dt>間取り</dt><dd>2DK</dd><dt>専有面積</dt><dd>44.58m<sup>2</sup></dd><dt>築年数</dt><dd>築31年（1995年03月）</dd><dt>階建/階</dt><dd>地上2階建て/2階部分</dd>
  <dt>所在地</dt><dd>長野県松本市村井町北1</dd><dt>交通</dt><dd>村井駅 /篠ノ井線 徒歩9分</dd></dl>
  <ul><li class="DetailFacility__popular__item"><div>オートロック</div></li><li class="DetailFacility__popular__item"><div>二人入居可</div></li></ul>
  <div>バス・トイレ</div><div>バス・トイレ独立 / 追いだき機能</div><div>ツルヤまで96m (徒歩2分)</div>
  <h2>おすすめの物件</h2><div>徒歩1分 オートロック</div>`);
  const r=parseListing(html,'https://realestate.yahoo.co.jp/rent/detail/x/',NOW);
  ok(r.title==='サンプルハイツII' && r.rent===60000 && r.kanri===0 && r.shiki===120000 && r.rei===0, '名前・家賃・管理費なし・敷金2か月');
  ok(r.walk===9 && r.floor===2 && r.age===31 && r.btype==='apart', '徒歩（周辺のお店までの徒歩は数えない）・階・築年数・種類');
  ok(r.feats.includes('sepbath') && r.feats.includes('oidaki') && !r.feats.includes('autolock') && !r.feats.includes('two'), '人気設備のアイコン一覧（有無が混ざる）は使わず、詳しい欄だけを見る');
}

console.log('\n[カナリー]');
{
  const data={props:{pageProps:{fallback:{'GET_ESTATE':{name:'サンプルパーク', city:'安曇野市', old:12, buildingType:'マンション', parking:'空有',
    accessesList:[{during:18},{during:7}], pickupRoom:{id:'11111111-1111-1111-1111-111111111111'},
    roomsList:[{id:'11111111-1111-1111-1111-111111111111', rent:52000, adminFee:3000, securityDeposit:0, keyMoney:52000, layout:'1K', floor:1, square:26.4},
               {id:'22222222-2222-2222-2222-222222222222', rent:71000, adminFee:4000, securityDeposit:71000, keyMoney:0, layout:'2LDK', floor:3, square:55.1}]}}}}};
  const html=`<html><head><title>【今週最新】サンプルパークの賃貸情報（安曇野市 / 豊科駅）| カナリー</title>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></head><body>
    <div>建物</div><div>マンション</div><h2>特徴</h2><div>オートロック</div><div>ペット相談可</div><div>入居条件</div><div>二人入居可</div>
    <div>バス・トイレ</div><div>給湯、バストイレ別、追焚機能</div><div>素敵な物件を見つけたらシェアしよう！</div><div>宅配ボックス</div></body></html>`;
  const r=parseListing(html,'https://web.canary-app.jp/chintai/buildings/x/#room_id=22222222-2222-2222-2222-222222222222',NOW);
  ok(r.title==='サンプルパーク' && r.city==='azumino' && r.btype==='mansion' && r.age===12 && r.walk===7, '建物の情報（埋め込みデータから）');
  ok(r.rent===71000 && r.kanri===4000 && r.layout==='2LDK' && r.areaM2===55.1 && r.floor===3 && r.rei===0, 'URLで指定した部屋の家賃・間取り');
  ok(r.feats.includes('park') && r.feats.includes('two') && r.feats.includes('sepbath') && r.feats.includes('oidaki') && r.feats.includes('floor2'), '設備');
  ok(!r.feats.includes('autolock') && !r.feats.includes('pet') && !r.feats.includes('delivery'), 'アイコンの一覧（有無が混ざる）と、ページ下の別物件は使わない');
  const r2=parseListing(html,'https://web.canary-app.jp/chintai/rooms/11111111-1111-1111-1111-111111111111/',NOW);
  ok(r2.rent===52000 && r2.layout==='1K', '部屋のURL（/rooms/…）でも、その部屋を読む');
}

console.log('\n[一覧ページ]');
{
  const html=page('松本市の賃貸物件一覧', '<div>お気に入りに追加する</div>'+Array.from({length:20},(_,i)=>`<div>${5+i/10}万円</div><div>2DK</div>`).join(''));
  ok(parseListing(html,'https://suumo.jp/chintai/nagano/sc_matsumoto/',NOW).list===true, '物件がたくさん並ぶページは「一覧」と分かる');
}

console.log('\n[読み取り係（fetch-listing）]');
{
  ok(okUrl('https://suumo.jp/x') && !okUrl('http://suumo.jp/x') && !okUrl('https://127.0.0.1/') && !okUrl('https://localhost/') && !okUrl('javascript:alert(1)'), 'https の普通のサイトだけ読む');
  const dir=mkdtempSync(join(tmpdir(),'fl-')); mkdirSync(join(dir,'data'));
  const cwd=process.cwd(); process.chdir(dir);
  const U1='https://suumo.jp/chintai/jnc_1/', U2='https://www.homes.co.jp/chintai/room/2/', U3='https://example.com/list', U4='https://www.athome.co.jp/x';
  writeFileSync('data/fetch.json', JSON.stringify([{id:idOf(U1),url:U1,at:100},{id:idOf(U2),url:U2,at:200},{id:'z',url:U3,at:300},{url:'http://bad/',at:1},{url:U4,at:400}]));
  const pages={[U1]: page('【SUUMO】ひとつめ／長野県松本市', '<div>お気に入りに追加する</div><div>6万円</div><table><tr><th>間取り</th><td>2DK</td></tr></table>'),
               [U3]: page('一覧', '<div>お気に入りに追加する</div>'+Array.from({length:20},()=>'<div>5万円</div>').join('')),
               [U4]: '<html><title>x</title><body>なにもない</body></html>'};
  let calls=0;
  const fetchPage=async u=>{ calls++; return u===U2? {err:'サイトに読み取りを断られました（403）'} : {html:pages[u]}; };
  const out=await run({fetchPage, now:()=>1000});
  const by=Object.fromEntries(out.map(x=>[x.url,x]));
  ok(calls===4, 'httpの依頼は読まない（4件だけ読む）');
  ok(by[U1].ok && by[U1].rent===60000 && by[U1].layout==='2DK' && by[U1].id===idOf(U1) && by[U1].reqAt===100, '読めた結果をidつきで書く');
  ok(!by[U2].ok && by[U2].err.includes('403'), '断られたら理由を書く');
  ok(!by[U3].ok && by[U3].err.includes('一覧'), '一覧ページは物件として読まない');
  ok(!by[U4].ok && by[U4].err.includes('見つかりません'), '物件の情報が無いページは読めなかったと書く');
  calls=0; await run({fetchPage, now:()=>2000});
  ok(calls===0, '読んだものは二度読まない');
  writeFileSync('data/fetch.json', JSON.stringify([{url:U1,at:500}]));
  calls=0; const out2=await run({fetchPage, now:()=>3000});
  ok(calls===1 && out2.find(x=>x.url===U1).reqAt===500, '「読み直す」（新しい依頼）なら読み直す');
  ok(JSON.parse(readFileSync('data/fetch.json','utf8')).length===1, '依頼のファイルは書き換えない（アプリと取り合わない）');
  process.chdir(cwd);
}

console.log(fail? `\n${fail}件 失敗` : '\nすべて成功');
process.exit(fail?1:0);
