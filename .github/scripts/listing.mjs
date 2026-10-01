/* 物件ページ（SUUMO・カナリー・HOME'S・アットホーム・CHINTAI・Yahoo!不動産 など）の HTML から、
   家賃・管理費・敷金・礼金・間取り・面積・駅徒歩・築年数・種類・階・設備を取り出す。
   GitHub Actions（fetch-listing.mjs）から使う。ブラウザのアプリはこの結果（data/listings.json）を読むだけ。

   方針：サイトごとの細かい作りに頼りすぎないよう、ページを「行」の並びにしてから
   「見出しの行 → 次の行が値」という形で拾う。設備は文字で探すが、
   「ある設備と無い設備を並べた一覧」（無い方を薄く表示するもの）は先に取り除く。 */

const CITY = {matsumoto:"松本市", shiojiri:"塩尻市", azumino:"安曇野市"};

export function listingId(url){
  return import("node:crypto").then(c=>c.createHash("sha256").update(String(url).trim()).digest("hex").slice(0,16));
}

export function siteOf(url){
  const h=(()=>{ try{ return new URL(url).hostname; }catch(e){ return ""; } })();
  if (/suumo\.jp$/.test(h)) return "suumo";
  if (/canary-app\.jp$/.test(h)) return "canary";
  if (/homes\.co\.jp$/.test(h)) return "homes";
  if (/athome\.co\.jp$/.test(h)) return "athome";
  if (/chintai\.net$/.test(h)) return "chintai";
  if (/realestate\.yahoo\.co\.jp$/.test(h)) return "yahoo";
  if (/nifty\.com$/.test(h)) return "nifty";
  return "other";
}

const decode = s => s.replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
/* 全角の英数字・記号をそろえる（「２０２」「ｍ²」など） */
const half = s => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0))
  .replace(/／/g,"/").replace(/＆/g,"&").replace(/（/g,"(").replace(/）/g,")").replace(/：/g,":").replace(/，/g,",").replace(/．/g,".").replace(/　/g," ");

export function toLines(html){
  let s=String(html||"");
  s=s.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi," ");
  s=s.replace(/<br\s*\/?>/gi,"\n").replace(/<\/(p|div|li|tr|th|td|dt|dd|h\d|section|table|ul|ol|span|a|strong|label|button)>/gi,"\n");
  s=s.replace(/<[^>]+>/g," ");
  s=half(decode(s));
  return s.split("\n").map(x=>x.replace(/[ \t ]+/g," ").trim()).filter(Boolean);
}

/* 「ある・無い」を並べた一覧から、無い方を消す（サイトごと） */
function dropAbsent(html, site){
  let s=html;
  if (site==="chintai") s=s.replace(/<li class="(?![^"]*\bon\b)[^"]*">\s*<span class="lazyload">[^<]*<\/span>\s*<\/li>/g,"");
  if (site==="yahoo") s=s.replace(/<li class="DetailFacility__popular__item">[\s\S]*?<\/li>/g,"");
  if (site==="athome") s=s.replace(/<ul[^>]*class="[^"]*pickup-icon-list[^"]*"[\s\S]*?<\/ul>/g,"");
  return s;
}
function dropLines(lines, site){
  const out=[];
  let skip=false;
  for (let i=0;i<lines.length;i++){
    const l=lines[i];
    if (lines[i+1]==="(非該当)"){ i++; continue; }        /* HOME'S：「オートロック (非該当)」 */
    if (l==="(該当)") continue;
    if (site==="canary" && l==="特徴"){ skip=true; continue; }   /* カナリー：アイコンの一覧（無い物も薄く並ぶ） */
    if (site==="canary" && skip && l==="入居条件") skip=false;
    if (skip) continue;
    out.push(l);
  }
  return out;
}

/* ページのうち、その物件のことが書いてある範囲（上のメニューや、下の「おすすめ物件」を除く） */
const REGION = {
  suumo:   [/^お気に入りに追加する$/, /^この物件を取り扱う店舗$/],
  homes:   [/^基本情報$/, /^(営業スタッフコメント|この物件を見たい、空室確認など|同じ建物の他の部屋)$/],
  athome:  [/^間取り& ?写真$/, /^(掲載不動産会社|店舗紹介)$/],
  chintai: [/^物件概要$/, /^(この物件を見たい|似た条件の物件)/],
  yahoo:   [/^賃料$/, /^(おすすめの物件|周辺の駅から探す)$/],
  canary:  [/^建物$/, /^素敵な物件を見つけたら/]
};
function region(lines, site){
  const r=REGION[site]; if (!r) return lines;
  let a=lines.findIndex(l=>r[0].test(l)); if (a<0) a=0;
  const END=/^(この物件を取り扱う店舗|掲載不動産会社|おすすめの物件|この物件を見た人はこんな物件も見ています)$/;
  let b=lines.findIndex((l,i)=>i>a && (r[1].test(l) || END.test(l))); if (b<0) b=lines.length;
  return lines.slice(a,b);
}
/* 見出しの行を探して、その値（同じ行の残り、無ければ次の行）を返す */
function val(lines, re, take=1){
  for (let i=0;i<lines.length;i++){
    const m=lines[i].match(re);
    if (!m) continue;
    const rest=lines[i].slice(m.index+m[0].length).replace(/^\s*[:\/]?\s*/,"");
    if (rest) return rest;
    return lines.slice(i+1, i+1+take).join(" ");
  }
  return "";
}
/* 「7.15万円」「3,000円」「なし」「-」→ 円。読めなければ null */
export function yenOf(s){
  s=String(s||"").replace(/\s+/g,"");
  let m=s.match(/^([\d.]+)万(\d{1,4})?円?/);
  if (m) return Math.round(parseFloat(m[1])*10000 + (m[2]? +m[2] : 0));
  m=s.match(/^([\d,]+)円/); if (m) return +m[1].replace(/,/g,"");
  if (/^(なし|無し|無|-|―|－|0円?|不要)/.test(s)) return 0;
  return null;
}
/* 敷金・礼金：「1ヶ月」「10.5万円」「なし」 → 円 */
function depositOf(s, rent){
  s=String(s||"").replace(/\s+/g,"");
  const m=s.match(/^([\d.]+)(ヶ月|ヵ月|カ月|か月|ケ月)/);
  if (m) return rent? Math.round(parseFloat(m[1])*rent) : null;
  return yenOf(s);
}
export function normLayout(s){
  s=half(String(s||"")).toUpperCase().replace(/\s+/g,"");
  if (/ワンルーム|^1R/.test(s)) return "1R";
  const m=s.match(/^(\d+)\s*S?(LDK|DK|K|LK)/);
  if (!m) return "";
  const n=+m[1], t=m[2]==="LK"? "LDK" : m[2];
  if (n>=4) return "4K以上";
  return n+t;
}
const FEAT_RE = {
  two:      /(二人|2人|ふたり)入居(可|相談)/,
  park:     /駐車場(あり|有り|付き?|\s*\(?(空有|有|あり))|敷地内駐車場|駐車場付/,
  park2:    /駐車場[^。\n]{0,12}?([2-9])台|([2-9])台(分|可|駐車|まで)/,
  sepbath:  /バス・?トイレ(別|独立)|バス・トイレ別|風呂・トイレ別/,
  washroom: /洗面所独立|独立洗面|洗面台独立/,
  oidaki:   /追焚|追い焚|追いだき|追い炊き|オートバス/,
  dryer:    /浴室乾燥/,
  stove2:   /(コンロ|ガスコンロ|IHコンロ)\s*(二|三|2|3)口|(二|三|2|3)口(以上)?(コンロ|ガスコンロ|IH)/,
  citygas:  /都市ガス/,
  cold:     /寒冷地|二重サッシ|ペアガラス|複層ガラス|二重窓|断熱サッシ/,
  washer:   /室内洗濯(機)?(置|置き場|置場)/,
  aircon:   /エアコン/,
  net:      /(インターネット|ネット)(使用料|利用料|料金)?(無料|不要)|インターネット接続\(月額利用料無料\)|ネット無料/,
  autolock: /オートロック(?!\s*(なし|無))/,
  delivery: /宅配(ボックス|BOX|ロッカー)/i,
  pet:      /ペット(相談|飼育可|可)(?!は|の場合|能物件)/,
  noguar:   /保証人(不要|なし|無し)/
};
const BT = s => /マンション/.test(s)? "mansion" : /アパート/.test(s)? "apart" : /(一戸建|戸建|テラスハウス|タウンハウス|貸家)/.test(s)? "house" : "";

export function parseListing(html, url, now=new Date()){
  const site=siteOf(url);
  const raw=String(html||"");
  const out={site, list:false, title:"", city:"", rent:null, kanri:null, shiki:null, rei:null, layout:"", areaM2:null, walk:null, age:null, btype:"", floor:null, feats:[]};
  /* タイトル（建物名） */
  const tm=raw.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || raw.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title=half(decode(tm? tm[1] : ""));
  out.title=title.replace(/【[^】]*】/g,"").split(/[\/\[|｜]| \(|（提供元|\(提供元|の賃貸情報|の賃貸物件| 長野県|（長野県/)[0].trim().slice(0,60);

  const full=dropLines(toLines(dropAbsent(raw, site)), site);
  let lines=region(full, site);
  const all=lines.join("\n");

  /* カナリーはページに埋め込まれたデータの方が確か */
  if (site==="canary"){
    try{
      const m=raw.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      const d=JSON.parse(m[1]);
      const fb=d.props.pageProps.fallback||{};
      const est=Object.values(fb).find(v=>v && v.roomsList);
      if (est){
        const rid=(String(url).match(/rooms\/([0-9a-f-]{36})|room_id=([0-9a-f-]{36})/)||[]).slice(1).find(Boolean);
        const room=(rid && est.roomsList.find(r=>r.id===rid)) || (est.pickupRoom && est.roomsList.find(r=>r.id===est.pickupRoom.id)) || est.roomsList[0];
        out.title=est.name||out.title;
        out.city=Object.keys(CITY).find(k=>CITY[k]===est.city)||"";
        if (room){
          out.rent=room.rent??null; out.kanri=room.adminFee??null; out.shiki=room.securityDeposit??null; out.rei=room.keyMoney??null;
          out.layout=normLayout(room.layout); out.areaM2=room.square??null; out.floor=room.floor??null;
        }
        if (est.old!=null) out.age=+est.old;
        out.btype=BT(est.buildingType||"");
        const acc=(est.accessesList||[]).map(a=>+a.during).filter(n=>n>=0);
        if (acc.length) out.walk=Math.min(...acc);
        if (/空有|有|あり/.test(est.parking||"")) out.feats.push("park");
      }
    }catch(e){}
  }

  /* 一覧ページ（たくさんの物件が並ぶページ）は1件の物件として読まない */
  if (site!=="canary" && (all.match(/[\d.]+\s*万円/g)||[]).length>14) out.list=true;
  /* 家賃 */
  if (out.rent==null){
    let v=val(lines, /^(賃料|家賃)(\/管理費・共益費等)?$/, 2) || "";
    out.rent=yenOf(v);
    if (out.rent==null){ const m=all.match(/(賃料|家賃)\s*:?\s*([\d.]+)\s*万円/); if (m) out.rent=Math.round(parseFloat(m[2])*10000); }
    if (out.rent==null){ const m=title.match(/(賃料|家賃)?\s*([\d.]+)万円/); if (m) out.rent=Math.round(parseFloat(m[2])*10000); }
    if (out.rent==null && site==="suumo"){ const l=lines.find(x=>/^[\d.]+万円$/.test(x)); if (l) out.rent=yenOf(l); }
  }
  /* 管理費 */
  if (out.kanri==null){
    let m=all.match(/(管理費|共益費)[^\n\d]{0,8}?(\n|:|\s)*([\d,]+)\s*円/);
    if (m) out.kanri=+m[3].replace(/,/g,"");
    else if (/(管理費|共益費)[^\n]{0,8}(\n|\s|:)*(なし|-|―)/.test(all)) out.kanri=0;
    const ym=all.match(/万円\s*\/\s*([\d,]+)円/); if (out.kanri==null && ym) out.kanri=+ym[1].replace(/,/g,"");
  }
  /* 敷金・礼金 */
  if (out.shiki==null){
    let v=val(lines, /^敷金(\s*\/\s*保証金)?$/, 1) || val(lines, /^敷金\s*:/);
    const sr=val(lines, /^敷金\s*\/\s*礼金$/, 1);   /* HOME'S：「敷金/礼金」「1ヶ月/1ヶ月」 */
    if (!v && sr){ v=sr; if (out.rei==null) out.rei=depositOf(sr.split("/")[1], out.rent); }
    if (!v){ const m=all.match(/敷金\s*:?\s*([^\n\/]+)/); if (m) v=m[1]; }
    out.shiki=depositOf(v.split("/")[0], out.rent);
  }
  if (out.rei==null){
    let v=val(lines, /^礼金(\s*\/\s*(償却|敷引))?$/, 1) || val(lines, /^礼金\s*:/);
    if (!v){ const m=all.match(/礼金\s*:?\s*([^\n\/]+)/); if (m) v=m[1]; }
    out.rei=depositOf(v.split("/")[0], out.rent);
  }
  /* 間取り・面積 */
  if (!out.layout){
    out.layout=normLayout(val(lines, /^間取り$/, 1));
    if (!out.layout){ const m=(title+"\n"+all).match(/(\d+S?(LDK|DK|K)|ワンルーム|1R)/); if (m) out.layout=normLayout(m[1]); }
  }
  if (out.areaM2==null){
    const m=(val(lines, /^専有面積$/, 2)||"").match(/([\d.]+)/) || all.match(/専有面積\s*:?\s*([\d.]+)\s*(m|㎡)/) || title.match(/([\d.]+)\s*(㎡|m2|m²)/);
    if (m) out.areaM2=Math.round(parseFloat(m[1])*100)/100;
  }
  /* 築年数 */
  if (out.age==null){
    const near=val(lines, /^(築年数|築年月|築年)$/, 2);
    if (/新築/.test(near)) out.age=0;
    let m=near.match(/築\s*(\d+)\s*年/) || (near? null : all.match(/築\s*(\d+)\s*年/));
    if (out.age==null && m) out.age=+m[1];
    if (out.age==null){ const y=near.match(/(\d{4})\s*年/); if (y) out.age=Math.max(0, now.getFullYear()-(+y[1])); }
  }
  /* 駅徒歩（いちばん近い駅）。「〇〇まで96m（徒歩2分）」のような周辺施設とバス停は数えない */
  if (out.walk==null){
    const ws=[];
    const re=/(?<![停バ])(?:徒歩|歩)\s*(\d+)\s*分/g;
    let m;
    while ((m=re.exec(all))){
      const before=all.slice(Math.max(0,m.index-16), m.index).split("\n").pop();
      if (/まで|\dm\s*\(?$|バス|下車|停/.test(before)) continue;   /* 周辺施設・バスを降りてからの徒歩は数えない */
      ws.push(+m[1]);
    }
    if (ws.length) out.walk=Math.min(...ws);
  }
  /* 建物の種類・階 */
  if (!out.btype) out.btype=BT(val(lines, /^(建物種別|物件種目|建物|種別|種目)$/, 1)) || BT(title)
    || BT(full.find(l=>/^(賃貸)?(マンション|アパート|一戸建て?|テラスハウス)$/.test(l))||"");
  if (out.floor==null){
    const fb=all.match(/\d+階建\s*\/\s*(\d+)階/);   /* アットホーム：「2階建 / 2階」 */
    let m=fb || all.match(/(\d+)階\s*\/\s*(地上)?\d+階建/) || all.match(/建て?\s*\/\s*(\d+)階部分/) || all.match(/(\d+)階部分/);
    if (m) out.floor=+m[1];
    else { const v=val(lines, /^(階|所在階)$/, 1).match(/^(\d+)階/); if (v) out.floor=+v[1]; }
  }
  /* エリア */
  if (!out.city){
    const addr=val(lines, /^(所在地|住所)$/, 1)+" "+title+" "+(all.match(/長野県[^\n]{0,12}/)||[""])[0];
    out.city=Object.keys(CITY).find(k=>addr.includes(CITY[k]))||"";
  }
  /* 設備 */
  const feats=new Set(out.feats);
  /* 用語の説明や紹介文（「〜が高くなる傾向がある。」など）は設備の一覧ではないので見ない */
  const listText=lines.filter(l=>!/[。！!?？]/.test(l) && !(l.length>40 && !/[、,\/]/.test(l))).join("\n");
  for (const [k,re] of Object.entries(FEAT_RE)) if (re.test(listText)) feats.add(k);
  if (/^駐車場$/m.test(all)){ const v=val(lines, /^駐車場$/, 1); if (/^(有|空有|あり|敷地内|近隣)/.test(v)) feats.add("park"); }
  if (out.floor!=null && out.floor>=2) feats.add("floor2");
  if (out.shiki===0 && out.rei===0) feats.add("zero");
  out.feats=[...feats];
  for (const k of ["rent","kanri","shiki","rei","areaM2","walk","age","floor"]) if (out[k]!=null && !isFinite(out[k])) out[k]=null;
  return out;
}
