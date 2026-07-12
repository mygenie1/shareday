/* ============================================================
   STATE  —  in prototype this lives in memory.
   In production: categories + events → IndexedDB (device only).
   Only events with isPrivate=false are ever uploaded, as a
   "public snapshot", to the server keyed by a share token.
   ============================================================ */
/* saved theme wins; fall back to the OS setting only when nothing was saved.
   The <head> inline script (layout.tsx) reads the same key to set data-theme
   before first paint, so this just keeps in-memory state in sync (no FOUC). */
function readSavedTheme(){
  try{ const t=localStorage.getItem('shareday-theme'); if(t==='dark'||t==='light') return t; }catch(e){}
  return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark':'light';
}
const state = {
  theme: readSavedTheme(),
  view: new Date(),
  categories: [
    {id:'c1', name:'업무',   color:'#FF8A5B'},
    {id:'c2', name:'약속',   color:'#3B82F6'},
    {id:'c3', name:'개인',   color:'#EF6B7D'},
    {id:'c4', name:'마감',   color:'#F59E0B'},
    {id:'c5', name:'이동',   color:'#7C6BE8'},
    {id:'c0', name:'기타',   color:'#64748B', fixed:true},
  ],
  events: [],
  editingId:null,
  form:{catId:'c1',isPrivate:false},
  newCat:{color:'#10B981'},
  selected:new Date(),        // date focused in the timeline
  armedDate:null,             // month: a day is selected on the 1st tap; a 2nd tap opens its sheet
  tlMode:'week',              // 'day' | 'week' — week is the default view on entry
  tlCollapsed:false,
};

const PALETTE = ['#10B981','#34D399','#3B82F6','#7C6BE8','#EF6B7D','#FF8A5B','#F59E0B','#EAB308','#14B8A6','#EC4899','#64748B','#0EA271'];

/* ---------- backend origin + connectivity ----------
   On the web the app is served from the same origin as its API, so relative paths
   work. Inside the Capacitor shell the UI is bundled with the app (so it opens with
   no network) and its origin is capacitor://localhost — API calls must be absolute,
   and the routes allow that origin explicitly (see middleware.ts). */
const API_ORIGIN='https://shareday-seven.vercel.app';
const isNative=()=>!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
const isIOS=()=>isNative()&&window.Capacitor.getPlatform&&window.Capacitor.getPlatform()==='ios';
const api=p=>(isNative()?API_ORIGIN:'')+p;
const isOnline=()=>navigator.onLine!==false;
const OFFLINE_MSG='오프라인이에요. 연결되면 다시 시도해 주세요';
/* "3시간 전" — how stale a cached friend snapshot is */
function relTime(ts){
  const m=Math.max(0,Math.round((Date.now()-ts)/60000));
  if(m<1) return '방금 전';
  if(m<60) return m+'분 전';
  const h=Math.round(m/60); if(h<24) return h+'시간 전';
  return Math.round(h/24)+'일 전';
}

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const cat=id=>state.categories.find(c=>c.id===id)||state.categories[0];
const pad=n=>String(n).padStart(2,'0');
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
function hexToRgb(h){h=h.replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function readable(hex){const [r,g,b]=hexToRgb(hex);return (0.299*r+0.587*g+0.114*b)>150?'#232321':'#ffffff';}
/* tinted background for chips/tags that adapts to theme */
function tint(hex,dark){const [r,g,b]=hexToRgb(hex);return dark?`rgba(${r},${g},${b},.22)`:`rgba(${r},${g},${b},.14)`;}
function inkOn(hex,dark){const [r,g,b]=hexToRgb(hex);
  if(dark){const f=1.62;return `rgb(${Math.min(255,80+(r*f|0))},${Math.min(255,80+(g*f|0))},${Math.min(255,80+(b*f|0))})`;}
  const f=.6;return `rgb(${r*f|0},${g*f|0},${b*f|0})`;}
const isDark=()=>state.theme==='dark';
const rid=()=>Math.random().toString(36).slice(2,8);

/* ============================================================
   RECURRENCE  —  rule-based, never pre-materialized.
   A repeating event stores ONE rule; the calendar expands it for the
   dates currently on screen and throws the instances away again.

     e.rrule     "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231"
                 iCalendar RRULE. e.date is the DTSTART (a DATE, so UNTIL
                 is the YYYYMMDD date form — no time, no timezone).
     e.exdate    ["2026-07-15"]           occurrences deleted "이번만"
     e.overrides {"2026-07-15":{...}}     occurrences edited "이번만"
                 (keyed by the ORIGINAL occurrence date; a patch may carry
                  its own `date`, which is how a moved instance is stored)

   No rrule → a one-off event, exactly as before. That is the whole
   back-compat story: old data keeps working untouched.
   ============================================================ */
const RR_DAYS=['SU','MO','TU','WE','TH','FR','SA'];
const RR_FREQ=['DAILY','WEEKLY','MONTHLY','YEARLY'];
const MAX_ITER=20000;              // runaway guard; 10y of a daily rule is ~3.6k
function ymd(di){const[y,m,d]=di.split('-').map(Number);return new Date(y,m-1,d);}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x;}
function isoAdd(di,n){return iso(addDays(ymd(di),n));}

function parseRule(s){
  if(!s||typeof s!=='string') return null;
  const o={freq:'',interval:1,byday:null,bymonthday:null,bysetpos:null,until:null,count:null};
  s.split(';').forEach(part=>{
    const i=part.indexOf('='); if(i<0) return;
    const k=part.slice(0,i).trim().toUpperCase(), v=part.slice(i+1).trim();
    if(k==='FREQ') o.freq=v.toUpperCase();
    else if(k==='INTERVAL') o.interval=Math.min(99,Math.max(1,parseInt(v,10)||1));
    else if(k==='BYDAY') o.byday=v.split(',').map(x=>RR_DAYS.indexOf(x.trim().toUpperCase().slice(-2))).filter(n=>n>=0);
    else if(k==='BYMONTHDAY') o.bymonthday=parseInt(v,10)||null;
    else if(k==='BYSETPOS') o.bysetpos=parseInt(v,10)||null;
    else if(k==='UNTIL') o.until=/^\d{8}/.test(v)?`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`:null;
    else if(k==='COUNT') o.count=Math.max(1,parseInt(v,10)||1);
  });
  if(!RR_FREQ.includes(o.freq)) return null;
  if(o.byday&&!o.byday.length) o.byday=null;
  return o;
}
function formatRule(o){
  if(!o||!RR_FREQ.includes(o.freq)) return '';
  const p=['FREQ='+o.freq];
  if(o.interval>1) p.push('INTERVAL='+o.interval);
  if(o.byday&&o.byday.length) p.push('BYDAY='+o.byday.slice().sort((a,b)=>a-b).map(d=>RR_DAYS[d]).join(','));
  if(o.bymonthday) p.push('BYMONTHDAY='+o.bymonthday);
  if(o.bysetpos) p.push('BYSETPOS='+o.bysetpos);
  if(o.count) p.push('COUNT='+o.count);              // COUNT and UNTIL are mutually exclusive
  else if(o.until) p.push('UNTIL='+o.until.replace(/-/g,''));
  return p.join(';');
}
/* the `pos`-th `dow` of a month (pos=-1 → the last one). null when it doesn't exist. */
function nthWeekdayIso(y,m,dow,pos){
  if(pos===-1){
    const last=new Date(y,m+1,0), back=(last.getDay()-dow+7)%7;
    const d=new Date(y,m,last.getDate()-back);
    return d.getMonth()===m?iso(d):null;
  }
  const first=new Date(y,m,1), fwd=(dow-first.getDay()+7)%7;
  const d=new Date(y,m,1+fwd+(pos-1)*7);
  return d.getMonth()===m?iso(d):null;
}
/* Rule dates that land inside [fromIso,toIso]. Generation always walks from
   DTSTART so COUNT counts the whole series (iCal semantics), but only the
   in-window dates are collected — an old daily rule stays cheap. */
function ruleDates(dtstart,r,fromIso,toIso){
  const out=[];
  if(!r) return out;
  const start=ymd(dtstart);
  const hardEnd=(r.until&&r.until<toIso)?r.until:toIso;
  if(hardEnd<dtstart) return out;
  const take=(di,seq)=>{                                // seq = 0-based index in the series
    if(r.count&&seq>=r.count) return false;             // series exhausted
    if(di>=fromIso&&di<=hardEnd&&di>=dtstart) out.push(di);
    return true;
  };
  if(r.freq==='DAILY'){
    // skip straight to the first occurrence at/after fromIso — no walking the gap
    const gap=Math.round((ymd(fromIso>dtstart?fromIso:dtstart)-start)/86400000);
    let k=Math.max(0,Math.ceil(gap/r.interval));
    for(let n=0;n<MAX_ITER;n++,k++){
      const di=iso(addDays(start,k*r.interval));
      if(di>hardEnd) break;
      if(!take(di,k)) break;
    }
  }else if(r.freq==='WEEKLY'){
    const days=(r.byday&&r.byday.length?r.byday:[start.getDay()]).slice().sort((a,b)=>a-b);
    const wk0=addDays(start,-start.getDay());           // Sunday of DTSTART's week
    // Jump to the stepped week holding fromIso: a rule started years ago costs no more
    // than one started last month. A week never skips a day, so the series index of that
    // week is exact — COUNT still counts from DTSTART.
    const firstWeek=days.filter(d=>d>=start.getDay()).length;   // occurrences in DTSTART's own week
    const from=fromIso>dtstart?ymd(fromIso):start;
    const wIdx=Math.round(Math.round((addDays(from,-from.getDay())-wk0)/86400000)/7);
    const w0=Math.max(0,Math.ceil(wIdx/r.interval));
    let seq=w0===0?0:firstWeek+(w0-1)*days.length;
    if(r.count&&seq>=r.count) return out;
    let stop=false;
    for(let w=w0;w<MAX_ITER&&!stop;w++){
      const base=addDays(wk0,w*7*r.interval);
      if(iso(base)>hardEnd) break;
      for(const dw of days){
        const di=iso(addDays(base,dw));
        if(di<dtstart) continue;                        // days before DTSTART in its own week
        if(di>hardEnd){stop=true;break;}
        if(!take(di,seq++)){stop=true;break;}
      }
    }
  }else if(r.freq==='MONTHLY'){
    const y0=start.getFullYear(), m0=start.getMonth();
    let seq=0;
    for(let k=0;k<MAX_ITER;k++){
      const gm=m0+k*r.interval, y=y0+Math.floor(gm/12), m=((gm%12)+12)%12;
      if(iso(new Date(y,m,1))>hardEnd) break;
      let di;
      if(r.bysetpos&&r.byday&&r.byday.length) di=nthWeekdayIso(y,m,r.byday[0],r.bysetpos);
      else{ const last=new Date(y,m+1,0).getDate();     // 그달의 마지막 날
            const dom=Math.min(r.bymonthday||start.getDate(),last); // 없는 날짜(29·30·31)는 마지막 날로 보정 — 달을 건너뛰지 않음
            di=iso(new Date(y,m,dom)); }
      if(di===null) continue;                           // (요일 기준) 존재하지 않는 n번째 요일만 건너뜀
      if(di<dtstart) continue;
      if(!take(di,seq++)) break;
    }
  }else if(r.freq==='YEARLY'){
    const y0=start.getFullYear(), m0=start.getMonth(), dom=start.getDate();
    const endY=+hardEnd.slice(0,4);
    let seq=0;
    for(let k=0;k<MAX_ITER;k++){
      const y=y0+k*r.interval;
      if(y>endY) break;
      const d=new Date(y,m0,dom);
      if(d.getMonth()!==m0) continue;                   // 2월 29일 → 평년은 건너뜀
      const di=iso(d);
      if(di<dtstart) continue;
      if(di>hardEnd) break;
      if(!take(di,seq++)) break;
    }
  }
  return out;
}
/* One materialized occurrence. A plain copy — mutating it never touches state.
   `id` is the instance key `<baseId>@<occurrence date>`; base ids never contain '@'. */
function makeInst(base,occ){
  const ov=(base.overrides&&base.overrides[occ])||null;
  const e={...base,...(ov||{}),id:base.id+'@'+occ,baseId:base.id,occDate:occ,repeat:true};
  e.date=(ov&&ov.date)||occ;                            // "이번만" 편집으로 옮겨진 날짜
  e.isPrivate=!!base.isPrivate;                         // 공개/프라이빗은 시리즈 단위 — 오버라이드가 못 뒤집는다
  delete e.overrides; delete e.exdate;
  return e;
}
/* An "이번만" edit can move an occurrence to another day, so a rule that has one
   is generated a little past the window's edges and filtered on the instance's real
   date. Rules without a moved override — nearly all of them — pay nothing for it. */
const OV_SLACK=62;
const hasMovedOverride=base=>!!(base.overrides&&Object.keys(base.overrides).some(k=>base.overrides[k]&&base.overrides[k].date));
function expandRange(fromIso,toIso){
  const out=[];
  state.events.forEach(base=>{
    const r=base.rrule?parseRule(base.rrule):null;
    if(!r){ if(base.date>=fromIso&&base.date<=toIso) out.push(base); return; }
    const ex=new Set(base.exdate||[]);
    const slack=hasMovedOverride(base)?OV_SLACK:0;
    ruleDates(base.date,r,isoAdd(fromIso,-slack),isoAdd(toIso,slack)).forEach(occ=>{
      if(ex.has(occ)) return;                           // "이번만" 삭제된 인스턴스
      const inst=makeInst(base,occ);
      if(inst.date>=fromIso&&inst.date<=toIso) out.push(inst);
    });
  });
  return out;
}
function expandForDate(di){ return expandRange(di,di); }

/* ---------- instance keys: chips/blocks/rows all carry `<baseId>[@occ]` ---------- */
function splitKey(key){ const i=String(key||'').lastIndexOf('@'); return i<0?{id:key,occ:null}:{id:key.slice(0,i),occ:key.slice(i+1)}; }
function baseOf(key){ return state.events.find(x=>x.id===splitKey(key).id)||null; }
function instOf(key){
  const {occ}=splitKey(key), base=baseOf(key);
  if(!base) return null;
  return occ?makeInst(base,occ):base;
}
const isRepeat=e=>!!(e&&e.rrule);

/* human summary of a rule, e.g. "매주 월·수 · 2026년 12월 31일까지" */
function describeRule(str,dtstart){
  const r=parseRule(str); if(!r) return '';
  const n=r.interval, D=DOW;
  let s='';
  if(r.freq==='DAILY') s=(n===1?'매일':`${n}일마다`);
  else if(r.freq==='WEEKLY'){
    const days=(r.byday&&r.byday.length?r.byday:[ymd(dtstart).getDay()]).slice().sort((a,b)=>a-b).map(d=>D[d]).join('·');
    s=(n===1?'매주':`${n}주마다`)+' '+days;
  }else if(r.freq==='MONTHLY'){
    const head=(n===1?'매달':`${n}개월마다`);
    if(r.bysetpos&&r.byday&&r.byday.length){
      const pos=r.bysetpos===-1?'마지막':['','첫째','둘째','셋째','넷째'][r.bysetpos]||'';
      s=`${head} ${pos} ${D[r.byday[0]]}요일`;
    }else s=`${head} ${r.bymonthday||ymd(dtstart).getDate()}일`;
  }else if(r.freq==='YEARLY'){
    const d=ymd(dtstart);
    s=(n===1?'매년':`${n}년마다`)+` ${d.getMonth()+1}월 ${d.getDate()}일`;
  }
  if(r.count) s+=` · ${r.count}회`;
  else if(r.until){ const u=ymd(r.until); s+=` · ${u.getFullYear()}년 ${u.getMonth()+1}월 ${u.getDate()}일까지`; }
  return s;
}
const REPEAT_SVG='<path d="M17 2l3 3-3 3"/><path d="M4 11.5V11a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 12.5v.5a4 4 0 0 1-4 4H4"/>';
const repeatIcon=cls=>`<svg class="svg rp ${cls||''}" viewBox="0 0 24 24">${REPEAT_SVG}</svg>`;

/* ---------- writing rules back: exceptions and the "앞으로 전체" split ---------- */
/* undo for a rule change is a whole-list restore: the event list is small and a
   split touches two events at once, so per-field undo would be fragile. */
function snapshotEvents(){ return JSON.parse(JSON.stringify(state.events)); }
function restoreEvents(snap){ state.events=snap; }

/* "이번 일정만" 수정 — the occurrence keeps its slot in the rule, plus a patch.
   isPrivate never lands in an override: it is one flag per event, so flipping the
   series in the share sheet must hide every occurrence with no exception left behind. */
function applyOne(base,occ,patch){
  const p={...patch};
  if(p.date===occ) delete p.date;                       // unchanged date → don't store it
  if('isPrivate' in p){ base.isPrivate=!!p.isPrivate; delete p.isPrivate; }
  base.overrides={...(base.overrides||{}),[occ]:{...((base.overrides||{})[occ]||{}),...p}};
}
/* "이번 일정만" 삭제 — EXDATE. */
function deleteOne(base,occ){
  base.exdate=[...new Set([...(base.exdate||[]),occ])].sort();
  if(base.overrides&&base.overrides[occ]){ const o={...base.overrides}; delete o[occ]; base.overrides=o; }
}
const pickDates=(obj,keep)=>{const o={};Object.keys(obj||{}).forEach(k=>{if(keep(k))o[k]=obj[k];});return o;};
/* Move a rule's weekday/monthday anchors onto a new start date, so "앞으로 전체"
   dragging 월요일 반복 to a 화요일 makes it a 화요일 반복 (not a stray Tuesday). */
function reanchorRule(r,d){
  if(r.freq==='WEEKLY'&&r.byday&&r.byday.length===1) r.byday=[d.getDay()];
  else if(r.freq==='MONTHLY'){
    if(r.bysetpos&&r.byday){ r.byday=[d.getDay()]; if(r.bysetpos!==-1) r.bysetpos=Math.ceil(d.getDate()/7); }
    else if(r.bymonthday) r.bymonthday=d.getDate();
  }
}
/* "이번 및 앞으로 전체" — cut the old rule the day before this occurrence and start a
   fresh event here. Past occurrences (and their exceptions) are left exactly as they
   were: there is no retroactive edit anywhere in this app.
   newRuleStr: undefined = keep the rule as-is · '' = stop repeating · a string = replace. */
function splitSeries(base,occ,patch,newRuleStr){
  const oldRule=parseRule(base.rrule);
  const ruleStr=(newRuleStr===undefined)?base.rrule:newRuleStr;
  const rule=parseRule(ruleStr);
  const newDate=patch.date||occ;
  if(rule&&newDate!==occ&&newRuleStr===undefined) reanchorRule(rule,ymd(newDate));
  // COUNT is spent by the occurrences already behind us — the tail gets the remainder
  if(rule&&rule.count&&newRuleStr===undefined){
    const consumed=ruleDates(base.date,oldRule,base.date,isoAdd(occ,-1)).length;
    rule.count=Math.max(1,rule.count-consumed);
  }
  // the day / the rule moved → old occurrence keys no longer name anything; drop them
  const anchorsMoved=(newDate!==occ)||(newRuleStr!==undefined&&newRuleStr!==base.rrule);
  const head={...base,...patch,id:'e'+rid(),date:newDate};
  if(rule){
    head.rrule=formatRule(rule);
    head.exdate=anchorsMoved?[]:(base.exdate||[]).filter(d=>d>=occ);
    head.overrides=anchorsMoved?{}:pickDates(base.overrides,d=>d>=occ);
  }else{ delete head.rrule; delete head.exdate; delete head.overrides; }
  delete head.baseId; delete head.occDate; delete head.repeat;

  if(occ<=base.date){                                   // first occurrence → the whole series is this one
    const keepId=base.id;
    Object.keys(base).forEach(k=>{ if(!(k in head)) delete base[k]; });   // e.g. rrule when 반복 안 함
    Object.assign(base,head,{id:keepId});
    return;
  }
  const cut=parseRule(base.rrule);
  cut.count=null; cut.until=isoAdd(occ,-1);
  base.rrule=formatRule(cut);
  base.exdate=(base.exdate||[]).filter(d=>d<occ);
  base.overrides=pickDates(base.overrides,d=>d<occ);
  state.events.push(head);
}
/* "이번 및 앞으로 전체" 삭제 — same cut, no tail. */
function deleteFuture(base,occ){
  if(occ<=base.date){ state.events=state.events.filter(x=>x.id!==base.id); return; }
  const r=parseRule(base.rrule);
  r.count=null; r.until=isoAdd(occ,-1);
  base.rrule=formatRule(r);
  base.exdate=(base.exdate||[]).filter(d=>d<occ);
  base.overrides=pickDates(base.overrides,d=>d<occ);
}

/* ---------- 수정/삭제 범위 물음 (반복 일정에만) ---------- */
let scopeCb=null;
function ensureScopeSheet(){
  if(document.getElementById('scopeScrim')) return;
  const scrim=document.createElement('div');
  scrim.className='scrim'; scrim.id='scopeScrim';
  scrim.innerHTML=`
    <div class="sheet" role="dialog" aria-modal="true" style="max-width:380px">
      <h2 id="scopeTitle">반복 일정</h2>
      <p class="sub" id="scopeMsg"></p>
      <button class="scope-btn" id="scopeOne">
        <b>이번 일정만</b><span id="scopeOneHint">이 날짜만 바뀌고 나머지는 그대로예요</span></button>
      <button class="scope-btn" id="scopeFuture">
        <b>이번 및 앞으로 전체</b><span id="scopeFutureHint">이 날짜부터 이후 반복이 모두 바뀌어요</span></button>
      <div class="sheet-actions"><button class="btn ghost" id="scopeCancel" style="flex:1">취소</button></div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.onclick=ev=>{ if(ev.target===scrim) resolveScope(null); };
  $('#scopeOne').onclick=()=>resolveScope('one');
  $('#scopeFuture').onclick=()=>resolveScope('future');
  $('#scopeCancel').onclick=()=>resolveScope(null);
}
function resolveScope(v){ closeScrim('#scopeScrim'); if(scopeCb){const cb=scopeCb;scopeCb=null;cb(v);} }
/* kind: '수정' | '삭제'. Resolves 'one' | 'future' | null(취소). */
function askScope(kind,name){
  ensureScopeSheet();
  const del=kind==='삭제';
  $('#scopeTitle').textContent=del?'반복 일정 삭제':'반복 일정 수정';
  $('#scopeMsg').textContent=`'${name||'이 일정'}'은(는) 반복 일정이에요. 어디까지 ${kind}할까요?`;
  $('#scopeOneHint').textContent=del?'이 날짜 하나만 지워요':'이 날짜만 바뀌고 나머지는 그대로예요';
  $('#scopeFutureHint').textContent=del?'이 날짜부터 이후 반복을 모두 지워요':'이 날짜부터 이후 반복이 모두 바뀌어요';
  $('#scopeOne').classList.toggle('danger',del);
  $('#scopeFuture').classList.toggle('danger',del);
  openScrim('#scopeScrim');
  return new Promise(res=>{ scopeCb=res; });
}
/* The one place an edit lands: single events just take the patch; repeating ones ask
   first. `msg` non-empty → commit with an undo toast (drag/drop); empty → silent save. */
async function commitPatch(key,patch,msg){
  const base=baseOf(key); if(!base) return false;
  const occ=splitKey(key).occ||base.date;              // a bare key on a rule → its first occurrence
  const snap=snapshotEvents();
  if(!base.rrule){
    Object.assign(base,patch);
  }else{
    const scope=await askScope('수정',base.title);
    if(!scope){ reRender(true); return false; }         // repaint drops any live drag preview
    if(scope==='one') applyOne(base,occ,patch);
    else splitSeries(base,occ,patch);
  }
  reRender(true);                                       // reRender persists + pushes live links
  if(msg) toastUndo(msg,()=>{ restoreEvents(snap); reRender(true); });
  return true;
}
/* Same, for removal. Single events keep the plain confirm; repeating ones get the scope sheet. */
async function commitDelete(key){
  const base=baseOf(key); if(!base) return;
  const occ=splitKey(key).occ||base.date;
  const inst=instOf(key), nm=(inst&&inst.title)||'이 일정';
  const snap=snapshotEvents();
  if(!base.rrule){
    const ok=await showConfirm({title:'일정 삭제', msg:`'${nm}' 일정을 삭제할까요?`, okLabel:'삭제'});
    if(!ok) return;
    state.events=state.events.filter(x=>x.id!==base.id);
    reRender(true); toast('삭제했어요'); return;
  }
  const scope=await askScope('삭제',nm);
  if(!scope) return;
  if(scope==='one') deleteOne(base,occ); else deleteFuture(base,occ);
  reRender(true);
  toastUndo(scope==='one'?'이 날짜의 일정을 삭제했어요':'이후 반복을 삭제했어요',
    ()=>{ restoreEvents(snap); reRender(true); });
}

/* ---------- theme ---------- */
function applyTheme(){
  document.documentElement.setAttribute('data-theme',state.theme);
  const m=document.querySelector('meta[name="theme-color"]');   // keep the browser chrome bar neutral per theme
  if(m) m.setAttribute('content', isDark()?'#000000':'#EFFBF3');
  syncMenuTheme();                 // header menu row reflects the current mode
  renderMonth(); renderLegend();
}
function toggleTheme(){
  state.theme=isDark()?'light':'dark';
  try{localStorage.setItem('shareday-theme',state.theme);}catch(e){}
  applyTheme();
}

/* ---------- header menu (다크모드 · 카테고리 · 내 공유 링크 · 받은 캘린더) ---------- */
/* Built in JS so the markup export stays clean. The header keeps only [공유][메뉴];
   everything else lives here as an icon+label list. */
const SUN_SVG='<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>';
const MOON_SVG='<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
function ensureMenu(){
  if(document.getElementById('appMenu')) return;
  const menu=document.createElement('div');
  menu.className='menu'; menu.id='appMenu'; menu.setAttribute('role','menu');
  menu.innerHTML=`
    <button class="menu-item" id="miTheme" role="menuitem">
      <svg id="menuThemeIcon" viewBox="0 0 24 24"></svg>
      <span class="mi-label" id="menuThemeLabel">다크모드</span>
      <span class="switch" id="menuThemeSwitch" role="switch"></span>
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item" id="miCats" role="menuitem">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span class="mi-label">카테고리 관리</span>
    </button>
    <button class="menu-item" id="miLinks" role="menuitem">
      <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
      <span class="mi-label">내 공유 링크</span>
    </button>
    <button class="menu-item" id="miRecv" role="menuitem">
      <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <span class="mi-label">친구 캘린더</span>
    </button>
    <button class="menu-item" id="miWidget" role="menuitem">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      <span class="mi-label">홈 위젯</span>
    </button>`;
  document.body.appendChild(menu);
  /* Build marker: only the native shell defines SHAREDAY_BUILD (build-shell.mjs stamps
     the commit in), so on the web this renders nothing. It exists to answer one
     question on a test device — "is this build actually the latest code?" */
  if(window.SHAREDAY_BUILD){
    const b=document.createElement('div');
    b.style.cssText='padding:6px 14px 8px;font-size:10px;opacity:.45;text-align:right;letter-spacing:.02em';
    b.textContent='build '+window.SHAREDAY_BUILD;
    menu.appendChild(b);
  }
  $('#miTheme').onclick=()=>toggleTheme();            // keep menu open so the switch animates
  $('#miCats').onclick=()=>{closeMenu();openSettings();};
  $('#miLinks').onclick=()=>{closeMenu();openShare();};
  $('#miRecv').onclick=()=>{closeMenu();openRecv();};
  $('#miWidget').onclick=()=>{closeMenu();openWidget();};
  syncMenuTheme();
}
function syncMenuTheme(){
  const ic=document.getElementById('menuThemeIcon'); if(ic) ic.innerHTML=isDark()?SUN_SVG:MOON_SVG;
  const lbl=document.getElementById('menuThemeLabel'); if(lbl) lbl.textContent=isDark()?'다크모드':'라이트모드';
  const sw=document.getElementById('menuThemeSwitch');
  if(sw){ sw.classList.toggle('on',isDark()); sw.setAttribute('aria-checked',isDark()); }
}
function openMenu(){
  ensureMenu();
  const menu=$('#appMenu'), btn=$('#menuBtn'); if(!btn) return;
  const r=btn.getBoundingClientRect();
  menu.style.top=(r.bottom+8)+'px';
  menu.style.right=Math.max(8,window.innerWidth-r.right)+'px';
  menu.classList.add('on'); btn.setAttribute('aria-expanded','true');
  syncMenuTheme();
  syncBackOpen();                      // back button closes the menu before leaving
}
function closeMenu(){
  const m=document.getElementById('appMenu'); if(m) m.classList.remove('on');
  const b=$('#menuBtn'); if(b) b.setAttribute('aria-expanded','false');
}
$('#menuBtn').onclick=e=>{
  e.stopPropagation();
  const m=document.getElementById('appMenu');
  (m&&m.classList.contains('on'))?closeMenu():openMenu();
};
document.addEventListener('pointerdown',e=>{
  const m=document.getElementById('appMenu');
  if(m&&m.classList.contains('on') && !e.target.closest('#appMenu') && !e.target.closest('#menuBtn')) closeMenu();
});

/* ---------- calendar ---------- */
const DOW=['일','월','화','수','목','금','토'];
function renderDow(){$('#dowRow').innerHTML=DOW.map((d,i)=>`<div class="dow${i===0?' sun':''}${i===6?' sat':''}">${d}</div>`).join('');}
let monthDragMoved=false, keepScroll=null;
/* Which element actually scrolls the week grid: on mobile the whole .tg scrolls
   (header + body together); on desktop only the inner .tg-scroll scrolls vertically. */
function tgScroller(){
  const tl=$('#tlBody'); return tl ? tl.querySelector('.tg-daysscroll') : null;  // the single scroll pane (both axes)
}
function reRender(preserve){ if(preserve){const s=tgScroller(); keepScroll=s?{left:s.scrollLeft,top:s.scrollTop}:null;} renderMonth(); renderTimeline(); keepScroll=null; afterMutate(); refreshDaySheet(); }
/* keep an open day sheet in sync after an edit/delete/date-move */
function refreshDaySheet(){ const sc=document.getElementById('daySheetScrim'); if(sc&&sc.classList.contains('on')) openDaySheet(state.selected); }
function renderMonth(){
  const v=state.view, y=v.getFullYear(), m=v.getMonth();
  $('#monthLabel').textContent=`${y}년 ${m+1}월`;
  ensureHolidays(y);
  const first=new Date(y,m,1), start=new Date(first); start.setDate(1-first.getDay());
  const todayIso=iso(new Date());
  // one expansion for the whole 6-week grid, bucketed by day — never per cell
  const mineByDay={};
  expandRange(iso(start),iso(addDays(start,41))).forEach(e=>{(mineByDay[e.date]=mineByDay[e.date]||[]).push(e);});
  let html='';
  for(let i=0;i<42;i++){
    const d=new Date(start); d.setDate(start.getDate()+i);
    const di=iso(d), out=d.getMonth()!==m, sun=d.getDay()===0, sat=d.getDay()===6, hol=HOLIDAYS[di];
    const mineList=(mineByDay[di]||[]).map(e=>({e,mine:true}));
    const frList=overlayEventsForDate(di).map(o=>({e:o.e,mine:false,friend:o.friend}));
    const all=[...mineList,...frList].sort((a,b)=>(a.e.time||'').localeCompare(b.e.time||''));
    const shown=all.slice(0,2), extra=all.length-shown.length;
    const selIso=iso(state.selected);
    const chips=shown.map(it=>{const e=it.e;
      if(it.mine){const c=cat(e.catId);
        return `<div class="chip" data-eid="${e.id}" style="--cat:${c.color};background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">
        <span style="overflow:hidden;text-overflow:ellipsis">${esc(e.title)}</span>
        ${isRepeat(e)?repeatIcon():''}
        ${e.isPrivate?'<svg class="svg lk" viewBox="0 0 24 24" style="width:10px;height:10px;stroke-width:2.4"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>':''}</div>`;
      }
      const col=it.friend.color;   // friend event: source-colored, read-only
      return `<div class="chip friend" data-ftoken="${it.friend.token}" data-feid="${e.id}" style="--cat:${col};background:${tint(col,isDark())};color:${inkOn(col,isDark())}">
        <span class="fdot" style="background:${col}"></span>
        <span style="overflow:hidden;text-overflow:ellipsis">${esc(e.title)}</span></div>`;
    }).join('');
    html+=`<div class="cell${out?' out':''}${di===todayIso?' today':''}${sun?' sun':''}${sat?' sat':''}${hol?' holiday':''}${di===selIso?' sel':''}" data-date="${di}" ${hol?`title="${esc(hol)}"`:''}>
      <div class="dn">${d.getDate()}</div>
      ${hol?`<div class="hol-name">${esc(hol)}</div>`:''}
      <div class="chips">${chips}${extra>0?`<div class="more">+${extra}</div>`:''}</div></div>`;
  }
  $('#daysGrid').innerHTML=html;
  $$('#daysGrid .cell').forEach(c=>{
    c.onclick=(ev)=>{
      if(monthDragMoved) return;                          // just finished a drag → ignore the click
      const chip=ev.target.closest('.chip');
      if(chip){ if(chip.dataset.eid) openEventDetail(chip.dataset.eid);            // my event → detail mini-card
                else if(chip.dataset.ftoken) openFriendDetail(chip.dataset.ftoken,chip.dataset.feid); // friend event → read-only
                return; }
      const di=c.dataset.date, d=new Date(di+'T00:00:00');
      const armed=state.armedDate===di;                    // 2nd tap on the same day → open its list
      state.selected=d; state.armedDate=di;                // 1st tap: just select + focus this day
      $$('#daysGrid .cell').forEach(x=>x.classList.remove('sel'));
      c.classList.add('sel');
      renderTimeline();                                    // week view below reflects the picked day
      if(armed) openDaySheet(d);                            // only the 2nd tap raises the bottom sheet
    };
  });
  attachMonthDrag();
  attachMonthSwipe();
}
/* month: LONG-PRESS a chip to pick it up, drag to another day, then confirm.
   A short tap opens the detail card; moving before the press completes is a scroll. */
function attachMonthDrag(){
  $$('#daysGrid .chip[data-eid]').forEach(chip=>{
    chip.addEventListener('pointerdown',ev=>{
      if(ev.button!==undefined && ev.button!==0) return;
      const key=chip.dataset.eid, e=instOf(key); if(!e) return;   // `e` is a copy for a repeating instance
      const startX=ev.clientX, startY=ev.clientY;
      const gr=chip.getBoundingClientRect();
      const offX=ev.clientX-gr.left, offY=ev.clientY-gr.top;   // grab point → clone stays under the finger
      let armed=false, dragging=false, cancelled=false, clone=null, lastCell=null, lpTimer=0;
      try{chip.setPointerCapture(ev.pointerId);}catch(_){}
      lpTimer=setTimeout(()=>{
        if(cancelled) return;
        armed=true; monthDragMoved=true;                       // suppress the trailing click
        clearSel();
        if(navigator.vibrate) try{navigator.vibrate(15);}catch(_){}
        clone=chip.cloneNode(true);                             // floating "lifted" copy
        Object.assign(clone.style,{position:'fixed',left:gr.left+'px',top:gr.top+'px',width:gr.width+'px',
          margin:'0',zIndex:'999',pointerEvents:'none',opacity:'.96',transform:'scale(1.05)',
          boxShadow:'0 10px 24px -4px rgba(35,34,29,.4)'});
        document.body.appendChild(clone); chip.style.opacity='.28';
        toast('끌어서 날짜를 옮겨요');
      },450);
      function mv2(mv){
        const dx=mv.clientX-startX, dy=mv.clientY-startY;
        if(!armed){
          if(Math.abs(dx)>8||Math.abs(dy)>8){ cancelled=true; clearTimeout(lpTimer); }  // scroll/swipe, not a drag
          return;
        }
        dragging=true;
        clone.style.left=(mv.clientX-offX)+'px'; clone.style.top=(mv.clientY-offY)+'px';
        const el=document.elementFromPoint(mv.clientX,mv.clientY);
        const cell=el&&el.closest?el.closest('#daysGrid .cell'):null;
        if(cell!==lastCell){ if(lastCell) lastCell.style.boxShadow=''; lastCell=cell;
          if(cell&&cell.dataset.date!==e.date) cell.style.boxShadow='inset 0 0 0 2px var(--accent)'; }
      }
      function up2(mv){
        clearTimeout(lpTimer);
        document.removeEventListener('pointermove',mv2);
        chip.style.opacity=''; if(lastCell) lastCell.style.boxShadow=''; if(clone) clone.remove();
        if(armed){
          if(dragging){
            const el=document.elementFromPoint(mv.clientX,mv.clientY);
            const cell=el&&el.closest?el.closest('#daysGrid .cell'):null;
            if(cell&&cell.dataset.date&&cell.dataset.date!==e.date){
              // long-press = intent; a repeating instance asks 이번만/앞으로 전체 first, then undo
              commitPatch(key,{date:cell.dataset.date},'날짜를 옮겼어요');
            }
          }
          setTimeout(()=>{monthDragMoved=false;},0);   // always clear the click-guard once armed
        }
      }
      document.addEventListener('pointermove',mv2);
      document.addEventListener('pointerup',up2,{once:true});
      ev.stopPropagation();
    });
  });
}
function renderLegend(){
  let html='<span class="lbl">카테고리</span>'+state.categories.map(c=>
    `<span class="tag" style="--cat:${c.color};background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">
      ${esc(c.name)}</span>`).join('')
    +`<button class="gear" id="legendGear"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" stroke-linecap="round" stroke-linejoin="round"/></svg>편집</button>`;
  // 겹쳐보기 active → show each friend source (color = 이름) + their category names
  if(overlayOn()){
    html+='<span class="legend-friends" id="legendFriends"></span>';
  }
  $('#legend').innerHTML=html;
  $('#legendGear').onclick=openSettings;
  if(overlayOn()) renderFriendLegend();
}
/* per-friend legend row: colored name + that friend's category names (relative labels) */
function renderFriendLegend(){
  const box=document.getElementById('legendFriends'); if(!box) return;
  const rows=activeFriends().map(l=>{
    const c=state.overlayCache[l.token];
    const col=(c&&c.color)||friendColorFor(l.token);
    const name=(c&&c.name)||l.ownerName||'친구';
    let catTags=(c&&c.ok)
      ? Object.values(c.cats).filter(k=>k&&k.name).map(k=>`<span class="fcat">${esc(k.name)}</span>`).join('')
      : '<span class="fcat pending">불러오는 중…</span>';
    // cached snapshot (offline / server unreachable) — say how old it is so it isn't read as current
    if(c&&c.stale) catTags+=`<span class="fcat stale">마지막 업데이트 ${esc(relTime(c.fetchedAt))}</span>`;
    return `<span class="friend-row"><span class="friend-name" style="color:${col}"><span class="fdot" style="background:${col}"></span>${esc(name)}</span>${catTags}</span>`;
  }).join('');
  box.innerHTML=`<span class="legend-off" id="legendOff">겹쳐보기 끄기</span>${rows}`;
  const off=document.getElementById('legendOff');
  if(off) off.onclick=()=>{ state.savedLinks.forEach(l=>l.overlay=false); saveSavedLinks(); state.overlayCache={}; refreshOverlays(); toast('내 일정만 보기로 전환했어요'); };
}
function esc(s){return (s||'').replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));}
/* belt-and-braces: drop any stray text selection when a long-press begins (CSS
   user-select:none already prevents it starting on interactive chrome) */
function clearSel(){ try{const s=window.getSelection&&window.getSelection(); if(s&&s.removeAllRanges) s.removeAllRanges();}catch(_){} }

/* month: swipe left/right to change month. Uses TOUCH events (pointer events get
   cancelled the moment the browser claims a scroll gesture, which is why the old
   pointer version never fired). Once we detect a horizontal drag we preventDefault
   so the browser doesn't scroll/nav-gesture instead. Chips own their own gesture;
   vertical drags fall through to normal page scroll. */
function attachMonthSwipe(){
  const card=$('#daysGrid') && $('#daysGrid').closest('.card');
  if(!card || card.dataset.swipe) return;
  card.dataset.swipe='1';
  card.style.touchAction='pan-y';                    // let the browser own only vertical; horizontal is ours
  let sx=0,sy=0,st=0,active=false,horiz=false;
  card.addEventListener('touchstart',e=>{
    if(e.touches.length!==1 || e.target.closest('.chip')){ active=false; return; }
    const t=e.touches[0]; sx=t.clientX; sy=t.clientY; st=Date.now(); active=true; horiz=false;
  },{passive:true});
  card.addEventListener('touchmove',e=>{
    if(!active) return;
    const t=e.touches[0], dx=t.clientX-sx, dy=t.clientY-sy;
    if(!horiz && Math.abs(dx)>12 && Math.abs(dx)>Math.abs(dy)*1.3) horiz=true;  // commit to horizontal
    if(horiz && e.cancelable) e.preventDefault();     // take over → block scroll / back-gesture
  },{passive:false});
  card.addEventListener('touchend',e=>{
    if(!active) return; active=false;
    if(monthDragMoved) return;                        // a chip long-press drag ran → not a swipe
    const t=e.changedTouches[0], dx=t.clientX-sx, dy=t.clientY-sy;
    if(Date.now()-st>700) return;                     // too slow to be a flick
    if(Math.abs(dx)<45 || Math.abs(dx)<Math.abs(dy)*1.3) return;   // must be clearly horizontal
    state.view.setMonth(state.view.getMonth()+(dx<0?1:-1));
    renderMonth();
  },{passive:false});
}

$('#prevM').onclick=()=>{state.view.setMonth(state.view.getMonth()-1);renderMonth();};
$('#nextM').onclick=()=>{state.view.setMonth(state.view.getMonth()+1);renderMonth();};
$('#todayBtn').onclick=()=>{state.view=new Date();renderMonth();};

/* ---------- year/month quick picker (tap the month title) — jump far in one step ---------- */
$('#monthLabel').style.cursor='pointer';
$('#monthLabel').setAttribute('role','button');
$('#monthLabel').onclick=openMonthPicker;
let pickerYear=null;
function ensureMonthPicker(){
  if(document.getElementById('monthPickerScrim')) return;
  const scrim=document.createElement('div');
  scrim.className='scrim'; scrim.id='monthPickerScrim';
  scrim.innerHTML=`
    <div class="sheet" role="dialog" aria-modal="true" style="max-width:360px">
      <div class="mp-head">
        <button class="btn icn ghost" id="mpPrevY" aria-label="이전 해"><svg class="svg" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="mp-year" id="mpYear">—</div>
        <button class="btn icn ghost" id="mpNextY" aria-label="다음 해"><svg class="svg" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>
      </div>
      <div class="mp-grid" id="mpGrid"></div>
      <div class="sheet-actions">
        <button class="btn ghost" id="mpToday" style="flex:1">오늘로</button>
        <button class="btn" id="mpClose" style="flex:1">닫기</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.onclick=ev=>{ if(ev.target===scrim) closeScrim('#monthPickerScrim'); };
  $('#mpPrevY').onclick=()=>{ pickerYear--; renderMonthPicker(); };
  $('#mpNextY').onclick=()=>{ pickerYear++; renderMonthPicker(); };
  $('#mpToday').onclick=()=>{ state.view=new Date(); closeScrim('#monthPickerScrim'); renderMonth(); };
  $('#mpClose').onclick=()=>closeScrim('#monthPickerScrim');
}
function openMonthPicker(){ ensureMonthPicker(); pickerYear=state.view.getFullYear(); renderMonthPicker(); openScrim('#monthPickerScrim'); }
function renderMonthPicker(){
  $('#mpYear').textContent=pickerYear+'년';
  const curY=state.view.getFullYear(), curM=state.view.getMonth();
  const today=new Date(), tY=today.getFullYear(), tM=today.getMonth();
  $('#mpGrid').innerHTML=Array.from({length:12},(_,m)=>{
    const sel=(pickerYear===curY&&m===curM), isToday=(pickerYear===tY&&m===tM);
    return `<button class="mp-m${sel?' sel':''}${isToday&&!sel?' today':''}" data-m="${m}">${m+1}월</button>`;
  }).join('');
  $$('#mpGrid .mp-m').forEach(b=>b.onclick=()=>{
    state.view=new Date(pickerYear, +b.dataset.m, 1);
    closeScrim('#monthPickerScrim'); renderMonth();
  });
}

/* ---------- event editor modal ---------- */
/* Reached ONLY via the detail mini-card's [수정] button, or for brand-new events
   (FAB / "이 날에 추가" / empty-day double-click). Clicking an existing event
   anywhere opens the read-only detail card first (openEventDetail), never this. */
function openEventEdit(id,presetDate){
  const e=id?instOf(id):null;
  state.editingId=id;                       // instance key
  state.editingOcc=e?(e.occDate||null):null;
  $('#evTitle').textContent=e?'일정 편집':'일정 추가';
  $('#fTitle').value=e?e.title:'';
  $('#fDate').value=e?e.date:(presetDate||iso(new Date()));
  $('#fTime').value=e?e.time:'';
  $('#fEnd').value=e?(e.end||''):'';
  $('#fMemo').value=e?(e.memo||''):'';
  state.form.endTouched=!!(e&&e.end);
  state.form.catId=e?e.catId:state.categories[0].id;
  state.form.isPrivate=e?!!e.isPrivate:false;
  // the rule always belongs to the whole series, so it is read from (and written to) the base
  state.form.ruleOrig=(e&&e.rrule)||'';
  state.form.rule=parseRule(state.form.ruleOrig);
  const sw=$('#privSwitch');
  sw.classList.toggle('on',state.form.isPrivate);
  sw.setAttribute('aria-checked',state.form.isPrivate);
  syncPrivHint();
  $('#evDelete').style.display=e?'block':'none';
  renderCatPick();
  buildQuickTime();
  buildRepeat(); renderRepeat();
  openScrim('#evScrim'); setTimeout(()=>$('#fTitle').focus(),120);
}

/* ---------- 반복 설정 ---------- */
/* Injected once, like 빠른 시간 and the share sheet, so the markup export stays clean.
   Progressive: pick a 주기 first; 간격·요일·종료 only appear once it repeats. */
function buildRepeat(){
  if(document.getElementById('rpFreq')) return;
  const dateField=document.querySelector('#evScrim #fDate');
  if(!dateField) return;
  const wrap=document.createElement('div');
  wrap.className='field'; wrap.id='repField';
  wrap.innerHTML=`
    <label>반복</label>
    <div class="seg rp-freq" id="rpFreq">
      <button type="button" data-f="">반복 안 함</button><button type="button" data-f="WEEKLY">매주</button><button type="button" data-f="MONTHLY">매달</button>
    </div>
    <div class="rp-detail" id="rpDetail" hidden>
      <div class="rp-line">
        <span class="rp-lbl">간격</span>
        <input class="inp rp-num" id="rpInterval" type="number" min="1" max="99" step="1" value="1">
        <span class="rp-unit" id="rpUnit">주마다</span>
      </div>
      <div class="rp-line rp-days" id="rpDays" hidden></div>
      <div class="rp-line" id="rpMonthLine" hidden>
        <span class="rp-lbl">기준</span>
        <div class="seg rp-mode" id="rpMonthMode">
          <button type="button" data-m="day">날짜로</button><button type="button" data-m="pos">요일로</button>
        </div>
      </div>
      <div class="rp-line" id="rpMonthDay" hidden>
        <span class="rp-unit">매달</span><select class="inp rp-sel" id="rpDom"></select><span class="rp-unit">일</span>
      </div>
      <div class="rp-line" id="rpMonthPos" hidden>
        <span class="rp-unit">매달</span><select class="inp rp-sel" id="rpPos"></select><select class="inp rp-sel" id="rpPosDow"></select><span class="rp-unit">요일</span>
      </div>
      <div class="rp-note" id="rpDomNote" hidden></div>
      <div class="rp-line">
        <span class="rp-lbl">종료</span>
        <div class="seg rp-mode" id="rpEnd">
          <button type="button" data-e="never">계속</button><button type="button" data-e="until">날짜까지</button><button type="button" data-e="count">횟수</button>
        </div>
      </div>
      <div class="rp-line" id="rpUntilLine" hidden><input class="inp" id="rpUntil" type="date"></div>
      <div class="rp-line" id="rpCountLine" hidden>
        <input class="inp rp-num" id="rpCount" type="number" min="1" max="999" step="1" value="10"><span class="rp-unit">회 반복 후 종료</span>
      </div>
    </div>
    <div class="rp-sum" id="rpSum"></div>`;
  dateField.closest('.field').after(wrap);

  $$('#rpFreq button').forEach(b=>b.onclick=()=>{ setFreq(b.dataset.f); renderRepeat(); });
  $('#rpInterval').oninput=function(){
    if(!state.form.rule) return;
    state.form.rule.interval=Math.min(99,Math.max(1,parseInt(this.value,10)||1));
    renderRepeatSummary();
  };
  $$('#rpEnd button').forEach(b=>b.onclick=()=>{ setEndMode(b.dataset.e); renderRepeat(); });
  $('#rpUntil').oninput=function(){ if(state.form.rule&&this.value){ state.form.rule.until=this.value; renderRepeatSummary(); } };
  $('#rpCount').oninput=function(){
    if(!state.form.rule) return;
    state.form.rule.count=Math.min(999,Math.max(1,parseInt(this.value,10)||1));
    renderRepeatSummary();
  };
  // 매달: 날짜/요일 기준 토글 + 그 자리에서 값 선택 (일정 날짜와 독립적)
  $('#rpDom').innerHTML=Array.from({length:31},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('');
  $('#rpPos').innerHTML=RP_POS.map(p=>`<option value="${p.v}">${p.t}</option>`).join('');
  $('#rpPosDow').innerHTML=DOW.map((n,i)=>`<option value="${i}">${n}</option>`).join('');
  $$('#rpMonthMode button').forEach(b=>b.onclick=()=>{ setMonthMode(b.dataset.m); renderRepeat(); });
  $('#rpDom').onchange=function(){
    const r=state.form.rule; if(!r) return;
    r.bymonthday=Math.min(31,Math.max(1,parseInt(this.value,10)||1)); r.bysetpos=null; r.byday=null;
    renderRepeat();
  };
  $('#rpPos').onchange=function(){ const r=state.form.rule; if(r){ r.bysetpos=parseInt(this.value,10); renderRepeatSummary(); } };
  $('#rpPosDow').onchange=function(){ const r=state.form.rule; if(r){ r.byday=[parseInt(this.value,10)]; renderRepeatSummary(); } };
  // 날짜를 옮기면 매주는 이 일정의 요일을 따라가지만, 매달 날짜/요일은 직접 고른 값이라 건드리지 않는다
  $('#fDate').addEventListener('change',()=>{
    const r=state.form.rule; if(!r) return;
    const d=ymd($('#fDate').value||iso(new Date()));
    if(r.freq==='WEEKLY'&&r.byday&&r.byday.length===1) r.byday=[d.getDay()];
    renderRepeat();
  });
}
/* 매달 요일 기준의 순서 라벨: 첫째~넷째 + 마지막(-1). 다섯째는 없는 달이 많아 넣지 않는다. */
const RP_POS=[{v:1,t:'첫째'},{v:2,t:'둘째'},{v:3,t:'셋째'},{v:4,t:'넷째'},{v:-1,t:'마지막'}];
function setMonthMode(m){
  const r=state.form.rule; if(!r) return;
  const d=ymd(formDate());
  if(m==='pos'){ r.bymonthday=null; if(!r.byday||!r.byday.length) r.byday=[d.getDay()];
                 if(!r.bysetpos) r.bysetpos=Math.min(4,Math.ceil(d.getDate()/7)); }
  else { r.bysetpos=null; r.byday=null; r.bymonthday=r.bymonthday||d.getDate(); }
}
function formDate(){ return $('#fDate').value||iso(new Date()); }
function setFreq(f){
  if(!f){ state.form.rule=null; return; }
  const d=ymd(formDate());
  const prev=state.form.rule;
  const r={freq:f, interval:(prev&&prev.interval)||1, byday:null, bymonthday:null, bysetpos:null,
           until:(prev&&prev.until)||null, count:(prev&&prev.count)||null};
  if(f==='WEEKLY') r.byday=[d.getDay()];              // 기본값: 이 일정의 요일
  if(f==='MONTHLY') r.bymonthday=d.getDate();         // 기본값: 이 일정의 날짜
  state.form.rule=r;
}
function setEndMode(m){
  const r=state.form.rule; if(!r) return;
  if(m==='never'){ r.until=null; r.count=null; }
  else if(m==='until'){ r.count=null; r.until=r.until||isoAdd(formDate(),90); }
  else { r.until=null; r.count=r.count||10; }         // COUNT and UNTIL are exclusive in iCal
}
function endMode(r){ return r.count?'count':(r.until?'until':'never'); }
const RP_UNIT={DAILY:'일마다',WEEKLY:'주마다',MONTHLY:'개월마다',YEARLY:'년마다'};
function renderRepeat(){
  const r=state.form.rule;
  $$('#rpFreq button').forEach(b=>b.classList.toggle('on', b.dataset.f===(r?r.freq:'')));
  const det=$('#rpDetail');
  if(!r){ det.hidden=true; renderRepeatSummary(); return; }
  det.hidden=false;
  $('#rpInterval').value=r.interval;
  $('#rpUnit').textContent=RP_UNIT[r.freq]||'';

  const days=$('#rpDays');
  days.hidden=r.freq!=='WEEKLY';
  if(r.freq==='WEEKLY'){
    days.innerHTML='<span class="rp-lbl rp-days-lbl">요일</span><div class="rp-dow-grid">'+DOW.map((n,i)=>
      `<button type="button" class="rp-dow${(r.byday||[]).includes(i)?' on':''}${i===0?' sun':''}${i===6?' sat':''}" data-d="${i}">${n}</button>`).join('')+'</div>';
    $$('#rpDays .rp-dow').forEach(b=>b.onclick=()=>{
      const i=+b.dataset.d, cur=new Set(r.byday||[]);
      cur.has(i)?cur.delete(i):cur.add(i);
      if(!cur.size) cur.add(i);                       // never leave a weekly rule with no weekday
      r.byday=[...cur].sort((a,b)=>a-b);
      renderRepeat();
    });
  }

  const ml=$('#rpMonthLine'), mDay=$('#rpMonthDay'), mPos=$('#rpMonthPos'), note=$('#rpDomNote');
  const isMonthly=r.freq==='MONTHLY', byPos=isMonthly&&!!r.bysetpos;
  ml.hidden=!isMonthly; mDay.hidden=!isMonthly||byPos; mPos.hidden=!byPos; note.hidden=true;
  if(isMonthly){
    $$('#rpMonthMode button').forEach(b=>b.classList.toggle('on',(b.dataset.m==='pos')===byPos));
    if(byPos){
      $('#rpPos').value=String(r.bysetpos);
      $('#rpPosDow').value=String(r.byday&&r.byday.length?r.byday[0]:ymd(formDate()).getDay());
    }else{
      const dom=r.bymonthday||ymd(formDate()).getDate();
      $('#rpDom').value=String(dom);
      if(dom>=29){ note.hidden=false;                 // 없는 달은 건너뛰지 않고 마지막 날로 보정된다
        note.textContent=`${dom}일이 없는 달(예: 2월)에는 그달 마지막 날에 표시돼요.`; }
    }
  }

  const em=endMode(r);
  $$('#rpEnd button').forEach(b=>b.classList.toggle('on',b.dataset.e===em));
  $('#rpUntilLine').hidden=em!=='until';
  $('#rpCountLine').hidden=em!=='count';
  if(em==='until'){ $('#rpUntil').value=r.until||''; $('#rpUntil').min=formDate(); }
  if(em==='count') $('#rpCount').value=r.count||10;
  renderRepeatSummary();
}
function renderRepeatSummary(){
  const el=$('#rpSum'); if(!el) return;
  const r=state.form.rule;
  el.textContent=r?describeRule(formatRule(normRule(r)),formDate()):'';
}
/* fill in the defaults the rule leans on DTSTART for, so the stored string is self-describing */
function normRule(r){
  const o={...r}, d=ymd(formDate());
  if(o.freq==='WEEKLY'&&(!o.byday||!o.byday.length)) o.byday=[d.getDay()];
  if(o.freq==='MONTHLY'&&!o.bysetpos&&!o.bymonthday) o.bymonthday=d.getDate();
  if(o.freq!=='WEEKLY'&&!(o.freq==='MONTHLY'&&o.bysetpos)) o.byday=null;
  if(o.until&&o.until<formDate()) o.until=formDate();   // an end before the start would yield nothing
  return o;
}
/* quick time-of-day pills above 시작/종료 — a fast starting point, since the OS
   time picker itself can't be changed. Injected once (keeps the markup export clean). */
function buildQuickTime(){
  const row2=document.querySelector('#evScrim .row2');
  if(!row2 || document.getElementById('timeQuick')) return;
  const wrap=document.createElement('div');
  wrap.className='field'; wrap.style.marginBottom='10px';
  wrap.innerHTML='<label>빠른 시간</label>'+
    '<div class="timeq" id="timeQuick">'+
      '<button type="button" data-s="08:00" data-e="09:00">아침</button>'+
      '<button type="button" data-s="12:00" data-e="13:00">점심</button>'+
      '<button type="button" data-s="18:00" data-e="19:00">저녁</button>'+
    '</div>';
  row2.parentNode.insertBefore(wrap, row2);           // sits just above the 시작 input
  $$('#timeQuick button').forEach(b=>b.onclick=()=>{
    $('#fTime').value=b.dataset.s; $('#fEnd').value=b.dataset.e;
    state.form.endTouched=false;                       // let 종료 follow if 시작 is changed after
  });
}

/* ---------- detail mini-card (read-only) — the single entry to editing ---------- */
function fmtDetailWhen(e){
  const [y,m,d]=e.date.split('-').map(Number);
  const dt=new Date(y,m-1,d), wd=['일','월','화','수','목','금','토'][dt.getDay()];
  const when=`${m}월 ${d}일 (${wd})`;
  return e.time ? `${when} · ${e.time}${e.end?'–'+e.end:''}` : `${when} · 종일`;
}
/* built in JS (like the share sheet) so the markup export stays untouched */
function ensureDetailModal(){
  if(document.getElementById('dtScrim')) return;
  const scrim=document.createElement('div');
  scrim.className='scrim'; scrim.id='dtScrim';
  scrim.innerHTML=`
    <div class="sheet" role="dialog" aria-modal="true" style="max-width:420px">
      <div class="dt-head">
        <span class="dt-dot" id="dtDot"></span><h2 id="dtTitle"></h2>
        <button class="dt-more" id="dtMore" aria-label="더보기" aria-haspopup="true">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg></button>
        <div class="dt-menu" id="dtMenu" role="menu">
          <button id="dtEdit" role="menuitem">수정하기</button>
          <button id="dtDelete" class="danger" role="menuitem">삭제하기</button>
        </div>
      </div>
      <div class="dt-when" id="dtWhen"></div>
      <div class="dt-repeat" id="dtRepeat"></div>
      <div class="dt-cat" id="dtCat"></div>
      <p class="dt-memo" id="dtMemo"></p>
      <div class="dt-vis" id="dtVis"></div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.onclick=ev=>{ if(ev.target===scrim) closeScrim('#dtScrim'); };  // tap outside closes (no 닫기 button)
  const more=$('#dtMore'), menu=$('#dtMenu');
  more.onclick=ev=>{ ev.stopPropagation(); menu.classList.toggle('on'); };
  scrim.querySelector('.sheet').addEventListener('click',ev=>{ if(!ev.target.closest('#dtMore')&&!ev.target.closest('#dtMenu')) menu.classList.remove('on'); });
  $('#dtEdit').onclick=()=>{ const id=state.detailId; menu.classList.remove('on'); closeScrim('#dtScrim'); openEventEdit(id); };
  $('#dtDelete').onclick=async()=>{
    menu.classList.remove('on');
    const key=state.detailId;
    closeScrim('#dtScrim');                 // the scope/confirm sheet takes over from here
    await commitDelete(key);
  };
}
/* `id` is an instance key: `<baseId>` for a one-off, `<baseId>@<occurrence>` when repeating */
function openEventDetail(id){
  const e=instOf(id); if(!e) return;
  ensureDetailModal();
  const mn=document.getElementById('dtMenu'); if(mn) mn.classList.remove('on');   // start closed
  const more=document.getElementById('dtMore'); if(more) more.style.display='';    // editable: show ⋯ (friend view hides it)
  state.detailId=id;
  const c=cat(e.catId);
  $('#dtDot').style.background=c.color;
  $('#dtTitle').textContent=e.title||'제목 없음';
  $('#dtWhen').textContent=fmtDetailWhen(e);
  $('#dtRepeat').innerHTML=isRepeat(e)
    ? `${repeatIcon()}<span>${esc(describeRule(e.rrule,e.occDate||e.date))}</span>` : '';
  $('#dtCat').innerHTML=`<span class="dt-cat-tag" style="background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">${esc(c.name)}</span>`;
  const memo=$('#dtMemo');
  if(e.memo){ memo.textContent=e.memo; memo.style.display='block'; } else memo.style.display='none';
  $('#dtVis').innerHTML = e.isPrivate
    ? '<svg class="svg" viewBox="0 0 24 24" style="width:14px;height:14px"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg> 프라이빗 · 공유 링크에서 숨겨져요'
    : '<svg class="svg" viewBox="0 0 24 24" style="width:14px;height:14px"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg> 공개 · 공유 링크에서 보여요';
  openScrim('#dtScrim');
}

/* ---------- day sheet (tap a date → that day's whole list) ----------
   A layer above the calendar; sits UNDER the detail card so tapping an event
   opens the mini-card over it (see #daySheetScrim z-index in globals.css). */
function ensureDaySheet(){
  if(document.getElementById('daySheetScrim')) return;
  const scrim=document.createElement('div');
  scrim.className='scrim'; scrim.id='daySheetScrim';
  scrim.innerHTML=`
    <div class="sheet" role="dialog" aria-modal="true" style="max-width:440px">
      <div class="ds-head"><h2 id="dsTitle"></h2><span class="ds-count" id="dsCount"></span></div>
      <div class="ds-list" id="dsList"></div>
      <button class="tl-add ds-add" id="dsAdd">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg> 이 날에 추가
      </button>
    </div>`;
  document.body.appendChild(scrim);
  scrim.onclick=ev=>{ if(ev.target===scrim) closeScrim('#daySheetScrim'); };  // backdrop closes
}
function openDaySheet(d){
  ensureDaySheet();
  const di=iso(d), wd=['일','월','화','수','목','금','토'][d.getDay()], hol=HOLIDAYS[di];
  const t=$('#dsTitle');
  t.className='ds-title'+(hol?' holiday':d.getDay()===0?' sun':d.getDay()===6?' sat':'');
  t.innerHTML=`${d.getMonth()+1}월 ${d.getDate()}일 <span class="ds-dow">(${wd})</span>`+(hol?` <span class="ds-hol">· ${esc(hol)}</span>`:'');
  const evs=expandForDate(di).sort((a,b)=>(a.time||'99').localeCompare(b.time||'99'));
  $('#dsCount').textContent=evs.length?`일정 ${evs.length}개`:'';
  const list=$('#dsList');
  if(evs.length){
    list.innerHTML=evs.map(rowHtml).join('');            // same row look as the timeline
    list.querySelectorAll('.tl-row[data-eid]').forEach(r=>r.onclick=()=>openEventDetail(r.dataset.eid));
  }else{
    list.innerHTML=`<div class="tl-empty">이 날은 아직 일정이 없어요. + 로 추가해보세요.</div>`;
  }
  $('#dsAdd').onclick=()=>{ closeScrim('#daySheetScrim'); openEventEdit(null, di); };
  openScrim('#daySheetScrim');
}
function renderCatPick(){
  const sel=state.form.catId;
  $('#catPick').innerHTML=state.categories.map(c=>
    `<button class="catopt${c.id===sel?' sel':''}" data-cid="${c.id}"
      style="background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">
      ${esc(c.name)}</button>`).join('')
    +`<button class="catopt add" id="addCat">＋ 새로</button>`;
  $$('#catPick .catopt[data-cid]').forEach(b=>b.onclick=()=>{state.form.catId=b.dataset.cid;renderCatPick();});
  $('#addCat').onclick=()=>openCatBuilder();
}
/* one-line explanation under the privacy toggle, reflecting the current choice */
function syncPrivHint(){
  const h=document.getElementById('privHint'); if(!h) return;
  const base=state.form.isPrivate ? '나만 볼 수 있어요 · 공유 링크에서 숨겨져요'
                                  : '친구에게 보여요 · 공유 링크에 표시돼요';
  // one flag per event, so on a repeating event it necessarily covers every occurrence
  h.textContent=state.form.ruleOrig ? base+' · 반복 전체에 적용돼요' : base;
}
$('#privSwitch').onclick=function(){
  state.form.isPrivate=!state.form.isPrivate;
  this.classList.toggle('on',state.form.isPrivate);
  this.setAttribute('aria-checked',state.form.isPrivate);
  syncPrivHint();
};
function addMinT(t,min){let[h,m]=t.split(':').map(Number);let tot=h*60+m+min;tot=Math.max(0,Math.min(24*60-1,tot));return String(Math.floor(tot/60)).padStart(2,'0')+':'+String(tot%60).padStart(2,'0');}
$('#fTime').oninput=function(){
  if(this.value && !state.form.endTouched){ $('#fEnd').value=addMinT(this.value,60); }
};
$('#fEnd').oninput=function(){ state.form.endTouched=true; };
$('#evSave').onclick=async()=>{
  const title=$('#fTitle').value.trim()||'제목 없음';
  const date=$('#fDate').value||iso(new Date());
  const time=$('#fTime').value;
  let end=$('#fEnd').value;
  if(time && !end) end=addMinT(time,60);
  if(time && end && end<=time) end=addMinT(time,60);   // guard: end after start
  const patch={title,date,time,end:time?end:'',memo:$('#fMemo').value.trim(),catId:state.form.catId,isPrivate:state.form.isPrivate};
  const ruleStr=state.form.rule?formatRule(normRule(state.form.rule)):'';

  if(!state.editingId){
    const e={id:'e'+rid(),...patch};
    if(ruleStr) e.rrule=ruleStr;
    state.events.push(e);
    closeScrim('#evScrim');reRender(true);toast(ruleStr?'반복 일정을 저장했어요':'저장했어요');
    return;
  }
  const base=baseOf(state.editingId);
  if(!base) return;
  const occ=state.editingOcc||base.date;

  if(!base.rrule){                       // 단발 → 그대로 저장(범위 물음 없음). 반복을 새로 켰다면 규칙만 붙는다.
    Object.assign(base,patch);
    if(ruleStr) base.rrule=ruleStr; else delete base.rrule;
    closeScrim('#evScrim');reRender(true);toast('저장했어요');
    return;
  }
  // repeating: a changed rule is inherently a series-level change, so it can only mean
  // "이번 및 앞으로 전체" — an override can hold fields, not a rule. Otherwise, ask.
  if(ruleStr!==base.rrule){
    const snap=snapshotEvents();
    splitSeries(base,occ,patch,ruleStr);
    closeScrim('#evScrim'); reRender(true);
    toastUndo(ruleStr?'이 날짜부터 반복을 바꿨어요':'이 날짜부터 반복을 해제했어요',()=>{ restoreEvents(snap); reRender(true); });
    return;
  }
  closeScrim('#evScrim');
  const scope=await askScope('수정',base.title);
  if(!scope) return;
  const snap=snapshotEvents();
  if(scope==='one') applyOne(base,occ,patch); else splitSeries(base,occ,patch);
  reRender(true);
  toastUndo(scope==='one'?'이 날짜의 일정만 바꿨어요':'이 날짜부터 바꿨어요',()=>{ restoreEvents(snap); reRender(true); });
};
$('#evDelete').onclick=async()=>{
  const key=state.editingId;
  closeScrim('#evScrim');
  await commitDelete(key);       // 단발이면 바로 확인, 반복이면 이번만/앞으로 전체
};
$('#evCancel').onclick=()=>closeScrim('#evScrim');
$('#fab').onclick=()=>openEventEdit(null, iso(state.selected));

/* ---------- timeline (day / week), collapsible ---------- */
function timeToMin(t){const[h,m]=t.split(':').map(Number);return h*60+m;}
function weekRange(d){
  const s=new Date(d); s.setDate(d.getDate()-d.getDay()); s.setHours(0,0,0,0);
  const e=new Date(s); e.setDate(s.getDate()+6);
  return [s,e];
}
function dayLabel(d,today){
  const wd=['일','월','화','수','목','금','토'][d.getDay()];
  return `${d.getMonth()+1}월 ${d.getDate()}일 (${wd})`+(iso(d)===today?' · 오늘':'');
}
function rowHtml(e){
  const c=cat(e.catId);
  const memo=e.memo?`<div class="tl-memo">${esc(e.memo)}</div>`:'';
  return `<div class="tl-row" data-eid="${e.id}" style="cursor:pointer">
    <span class="tl-time">${e.time?(e.time+(e.end?'–'+e.end:'')):'종일'}</span>
    <span class="tl-dot" style="background:${c.color}"></span>
    <div class="tl-main">
      <div class="tl-nm" style="color:${inkOn(c.color,isDark())}">${esc(e.title)}
        ${isRepeat(e)?repeatIcon():''}
        ${e.isPrivate?'<svg class="svg lk" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>':''}</div>
      <div class="tl-cat">${esc(c.name)}${isRepeat(e)?' · '+esc(describeRule(e.rrule,e.occDate||e.date)):''}</div>
      ${memo}
    </div></div>`;
}
function renderTimeline(){
  const today=iso(new Date());
  const tl=$('#tlCard'); tl.classList.toggle('collapsed',state.tlCollapsed);
  $('#tlToggle').setAttribute('aria-label',state.tlCollapsed?'주간 펼치기':'주간 접기');
  const byT=(a,b)=>(a.time||'99').localeCompare(b.time||'99');

  {
    // Bottom section is the weekly time-grid only. "이 날" is reached by tapping a
    // date on the month calendar → that day's sheet (no more day/week toggle).
    const [s,e0]=weekRange(state.selected);
    const tt=$('#tlTitle'); tt.className='tl-title';
    tt.textContent=`${s.getMonth()+1}.${s.getDate()} – ${e0.getMonth()+1}.${e0.getDate()} 주간`;
    const selIso=iso(state.selected);
    const WD=['일','월','화','수','목','금','토'];
    const days=[]; for(let i=0;i<7;i++){const d=new Date(s);d.setDate(s.getDate()+i);days.push(d);}

    // Visible window centers on the week's actual events but keeps ~3h of slack
    // above and below — enough empty grid to scroll into and to drag events onto
    // nearby hours, without unrolling the whole 24h. No events → a calm 08–19.
    const dayIsos=days.map(iso);
    const weekByDay={};                       // one expansion for the 7 visible days
    expandRange(dayIsos[0],dayIsos[6]).forEach(e=>{(weekByDay[e.date]=weekByDay[e.date]||[]).push(e);});
    const mineOn=di=>weekByDay[di]||[];
    const frTimedAll=dayIsos.flatMap(di=>overlayEventsForDate(di).filter(o=>o.e.time).map(o=>o.e));
    const timed=dayIsos.flatMap(di=>mineOn(di).filter(e=>e.time)).concat(frTimedAll);  // friends widen the window too
    let minH,maxH;
    if(timed.length){
      let lo=24,hi=0;
      timed.forEach(e=>{const sh=+e.time.split(':')[0];
        const eh=e.end?Math.ceil(timeToMin(e.end)/60):sh+1;
        if(sh<lo)lo=sh; if(eh>hi)hi=eh;});
      minH=Math.max(0,lo-2); maxH=Math.min(24,hi+3);
    }else{ minH=8; maxH=19; }
    // keep a comfortable minimum height: empty rows above/below give scroll slack
    // and drop targets, so the grid never feels like a locked, too-short box.
    while(maxH-minH<9){ if(minH>0)minH--; if(maxH-minH<9 && maxH<24)maxH++; if(minH===0&&maxH===24)break; }
    const HOURS=maxH-minH, PXH=40;                 // px per hour

    // weekday header cells (the corner is a separate fixed pane now)
    let headCells='';
    days.forEach(d=>{const di=iso(d),isT=di===today,isS=di===selIso,sun=d.getDay()===0,sat=d.getDay()===6,hol=HOLIDAYS[di];
      headCells+=`<div class="tg-dh${isT?' today':''}${isS?' sel':''}${sun?' sun':''}${sat?' sat':''}${hol?' holiday':''}" data-date="${di}" ${hol?`title="${esc(hol)}"`:''}>
        <span class="tg-dow">${WD[d.getDay()]}</span><span class="tg-dn">${d.getDate()}</span>${hol?`<span class="tg-hol">${esc(hol)}</span>`:''}</div>`;});

    // all-day / untimed strip (mine + friends')
    const untimedByDay=days.map(d=>mineOn(iso(d)).filter(e=>!e.time));
    const frUntimedByDay=days.map(d=>overlayEventsForDate(iso(d)).filter(o=>!o.e.time));
    const hasUntimed=untimedByDay.some(a=>a.length)||frUntimedByDay.some(a=>a.length);
    let alldayCells='';
    if(hasUntimed){
      alldayCells=days.map((d,i)=>{
        const mineC=untimedByDay[i].map(e=>{const c=cat(e.catId);
          return `<div class="tg-chip" data-eid="${e.id}" style="--cat:${c.color};background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">${esc(e.title)}${isRepeat(e)?repeatIcon():''}</div>`;}).join('');
        const frC=frUntimedByDay[i].map(o=>{const col=o.friend.color;
          return `<div class="tg-chip friend" data-ftoken="${o.friend.token}" data-feid="${o.e.id}" style="--cat:${col};background:${tint(col,isDark())};color:${inkOn(col,isDark())}"><span class="fdot" style="background:${col}"></span>${esc(o.e.title)}</div>`;}).join('');
        return `<div class="tg-adcell" data-date="${iso(d)}">${mineC}${frC}</div>`;
      }).join('');
    }

    // hour gutter + grid lines
    let gutter='';
    for(let h=minH;h<maxH;h++) gutter+=`<div class="tg-hr" style="height:${PXH}px"><span>${String(h).padStart(2,'0')}</span></div>`;

    // day columns with positioned blocks (overlap-aware)
    let colsHtml='';
    days.forEach(d=>{
      const di=iso(d);
      const mineItems=mineOn(di).filter(e=>e.time).map(e=>({e,mine:true}));
      const frItems=overlayEventsForDate(di).filter(o=>o.e.time).map(o=>({e:o.e,mine:false,friend:o.friend}));
      const items=[...mineItems,...frItems].sort((a,b)=>byT(a.e,b.e));
      // lane packing by real start/end (mine + friends' share lanes so nothing overlaps)
      const laid=items.map(x=>{const sh=timeToMin(x.e.time); const eh=x.e.end?timeToMin(x.e.end):sh+60; return {e:x.e,mine:x.mine,friend:x.friend,start:sh,end:Math.max(eh,sh+15)};});
      laid.forEach((it,idx)=>{
        it.lane=0;
        for(let l=0;;l++){ if(!laid.some((o,j)=>j<idx&&o.lane===l&&o.end>it.start&&o.start<it.end)){it.lane=l;break;} }
      });
      laid.forEach(it=>{const maxLane=Math.max(...laid.filter(o=>o.end>it.start&&o.start<it.end).map(o=>o.lane))+1; it.lanes=maxLane;});
      const blocks=laid.map(it=>{const e=it.e; const color=it.mine?cat(e.catId).color:it.friend.color;
        const top=(it.start-minH*60)/60*PXH, h=Math.max(20,(it.end-it.start)/60*PXH), w=100/it.lanes, left=it.lane*w;
        const showEnd=h>=34;
        const attr=it.mine?`data-eid="${e.id}"`:`data-ftoken="${it.friend.token}" data-feid="${e.id}"`;
        const fdot=it.mine?'':`<span class="fdot" style="background:${color}"></span>`;
        return `<div class="tg-block${it.mine?'':' friend'}" ${attr} data-date="${di}" tabindex="0"
          style="top:${top}px;height:${h}px;left:${left}%;width:calc(${w}% - 3px);
          --cat:${color};background:${tint(color,isDark())};border-left:3px solid ${color};color:${inkOn(color,isDark())}">
          ${it.mine?'<span class="tg-grip tg-grip-top" data-grip="top"></span>':''}
          <span class="tg-bt">${e.time}${showEnd&&e.end?'–'+e.end:''}</span>
          <span class="tg-bn">${fdot}${esc(e.title)}${(it.mine&&isRepeat(e))?' '+repeatIcon():''}${e.memo?' <svg class="svg" viewBox="0 0 24 24" style="width:9px;height:9px;stroke-width:2.2;display:inline;vertical-align:baseline"><path d="M4 6h16M4 12h16M4 18h10"/></svg>':''}${(it.mine&&e.isPrivate)?' <svg class="svg lk" viewBox="0 0 24 24" style="width:9px;height:9px;stroke-width:2.4"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>':''}</span>
          ${it.mine?'<span class="tg-grip tg-grip-bot" data-grip="bot"></span>':''}
        </div>`;}).join('');
      let lines=''; for(let hh=minH;hh<maxH;hh++) lines+=`<div class="tg-line" style="top:${(hh-minH)*PXH}px"></div>`;
      colsHtml+=`<div class="tg-col${di===selIso?' sel':''}" data-date="${di}" data-minh="${minH}" style="height:${HOURS*PXH}px">${lines}${blocks}</div>`;
    });

    // Frozen panes (auto-placed into a 40px|1fr grid): ONLY .tg-daysscroll scrolls,
    // both axes. The weekday header and hour gutter are overflow-hidden panes we
    // translate to match — no position:sticky (iOS-safe) and no touch-action:none
    // on the scroller (Android vertical scroll works).
    $('#tlBody').innerHTML=`
      <div class="tg${hasUntimed?' has-allday':''}" style="--pxh:${PXH}px">
        <div class="tg-corner"></div>
        <div class="tg-topscroll"><div class="tg-head">${headCells}</div></div>
        ${hasUntimed?`<div class="tg-adlabel">종일</div><div class="tg-adscroll"><div class="tg-allday">${alldayCells}</div></div>`:''}
        <div class="tg-gutcol"><div class="tg-gutter">${gutter}</div></div>
        <div class="tg-daysscroll"><div class="tg-cols">${colsHtml}</div></div>
      </div>`;
    // scroll so the earliest event of the week is near the top
    const firstMin = timed.length ? Math.min(...timed.map(e=>timeToMin(e.time))) : minH*60;
    const sc=tgScroller();
    if(sc){
      if(keepScroll){ sc.scrollLeft=keepScroll.left; sc.scrollTop=keepScroll.top; }
      else {
        sc.scrollTop=Math.max(0,((firstMin-minH*60)/60*PXH)-14);
        const selCol=sc.querySelector('.tg-col.sel');
        if(selCol){ const cr=selCol.getBoundingClientRect(), sr=sc.getBoundingClientRect();
          sc.scrollLeft += (cr.left - sr.left) - (sr.width - cr.width)/2; }
      }
      // keep the header/gutter panes aligned with the day area as it scrolls
      const hEl=$('#tlBody .tg-head'), adEl=$('#tlBody .tg-allday'), gEl=$('#tlBody .tg-gutter');
      const syncPanes=()=>{ const tx='translateX('+(-sc.scrollLeft)+'px)';
        if(hEl) hEl.style.transform=tx; if(adEl) adEl.style.transform=tx;
        if(gEl) gEl.style.transform='translateY('+(-sc.scrollTop)+'px)'; };
      sc.addEventListener('scroll',syncPanes,{passive:true});
      syncPanes();
    }
    // wire drag + resize on blocks
    $$('#tlBody .tg-block[data-eid]').forEach(bl=>attachBlockInteract(bl,PXH,minH));
  }
  $$('#tlBody .tl-row[data-eid], #tlBody .tg-chip[data-eid]').forEach(r=>r.onclick=(ev)=>{ev.stopPropagation();openEventDetail(r.dataset.eid);});
  $$('#tlBody .tg-block[data-ftoken], #tlBody .tg-chip[data-ftoken]').forEach(el=>el.onclick=(ev)=>{ev.stopPropagation();openFriendDetail(el.dataset.ftoken,el.dataset.feid);});
  $$('#tlBody .tg-dh[data-date]').forEach(col=>col.onclick=()=>{
    state.selected=new Date(col.dataset.date+'T00:00:00');
    renderMonth(); renderTimeline();
  });
}

/* ---------- drag to move / resize a week block (pointer-based, 15-min snap) ---------- */
const SNAP=15;
function snap(min){return Math.round(min/SNAP)*SNAP;}
function minToTime(m){m=Math.max(0,Math.min(24*60-1,m));return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');}
function attachBlockInteract(bl,PXH,minH){
  bl.addEventListener('pointerdown',ev=>{
    if(ev.button!==undefined && ev.button!==0) return;
    const grip=ev.target.getAttribute && ev.target.getAttribute('data-grip');
    const mode=grip?('resize-'+grip):'move';
    const key=bl.dataset.eid, inst=instOf(key); if(!inst) return;
    // LONG-PRESS to pick up, then drag; a short tap opens the detail card. Moving
    // before the press completes is a scroll. `e` is a throwaway copy the drag paints
    // from — state is only written on drop (after the 반복 범위 question, if any).
    const e={...inst};
    const cols=[...$$('#tlBody .tg-col')];
    const startX=ev.clientX, startY=ev.clientY;
    const origStart=timeToMin(e.time), origEnd=e.end?timeToMin(e.end):origStart+60;
    let armed=false, moved=false, cancelled=false, lpTimer=0;
    const sc=tgScroller();
    let edgeDir=0, edgeRAF=0, lastEv=ev;
    try{bl.setPointerCapture(ev.pointerId);}catch(_){}
    bl.classList.add('pressing');
    lpTimer=setTimeout(()=>{
      if(cancelled) return;
      armed=true; bl.classList.remove('pressing'); bl.classList.add('dragging','armed');
      clearSel();
      if(navigator.vibrate) try{navigator.vibrate(15);}catch(_){}
      toast(mode==='move'?'끌어서 옮겨요':'끌어서 시간을 바꿔요');
    },450);
    function edgeLoop(){ if(!edgeDir||!sc){edgeRAF=0;return;} sc.scrollLeft+=edgeDir*12; applyMove(lastEv); edgeRAF=requestAnimationFrame(edgeLoop); }
    function move(mv){ lastEv=mv;
      if(!armed){ const dx=mv.clientX-startX, dy=mv.clientY-startY;
        // a clear early swipe = scroll/flick intent → cancel the long-press (no drag, no detail)
        if(Math.abs(dx)>12||Math.abs(dy)>12){ cancelled=true; clearTimeout(lpTimer); bl.classList.remove('pressing'); }
        return; }
      applyMove(mv);
    }
    function applyMove(mv){
      const dx=mv.clientX-startX, dy=mv.clientY-startY;
      if(Math.abs(dx)>4||Math.abs(dy)>4) moved=true;
      const dMin=snap(dy/PXH*60);
      if(mode==='move'){
        let dur=origEnd-origStart;
        let ns=snap(origStart+dMin);
        ns=Math.max(minH*60,Math.min(24*60-dur,ns));
        e.time=minToTime(ns); e.end=minToTime(ns+dur);
        // pick the column under the pointer (works while horizontally scrolled)
        let overCol=cols.find(c=>{const r=c.getBoundingClientRect(); return mv.clientX>=r.left && mv.clientX<r.right;});
        if(overCol){ e.date=overCol.dataset.date;
          if(overCol!==bl.parentElement){ overCol.appendChild(bl); bl.style.left='0%'; bl.style.width='calc(100% - 3px)'; } }
        // live position
        bl.style.top=((ns-minH*60)/60*PXH)+'px';
        bl.style.height=Math.max(20,dur/60*PXH)+'px';
        // near a horizontal edge → auto-scroll to move to adjacent days
        if(sc){ const sr=sc.getBoundingClientRect();
          edgeDir = mv.clientX < sr.left+48 ? -1 : (mv.clientX > sr.right-48 ? 1 : 0);
          if(edgeDir && !edgeRAF) edgeRAF=requestAnimationFrame(edgeLoop);
        }
      }else if(mode==='resize-bot'){
        let ne=snap(origEnd+dMin); ne=Math.max(origStart+SNAP,Math.min(24*60,ne));
        e.end=minToTime(ne);
        bl.style.height=Math.max(20,(ne-origStart)/60*PXH)+'px';
      }else if(mode==='resize-top'){
        let ns=snap(origStart+dMin); ns=Math.max(minH*60,Math.min(origEnd-SNAP,ns));
        e.time=minToTime(ns);
        bl.style.top=((ns-minH*60)/60*PXH)+'px';
        bl.style.height=Math.max(20,(origEnd-ns)/60*PXH)+'px';
      }
      // live time label
      const lbl=bl.querySelector('.tg-bt'); if(lbl) lbl.textContent=e.time+(e.end?'–'+e.end:'');
    }
    /* A block tap opens the detail card from pointerup — but the browser then fires the
       trailing click, and by that time the scrim already covers the block, so the click
       hit-tests to the scrim and its backdrop handler closes the card instantly. Eat that
       one click. (Month chips open from a click handler, so they never had this problem.) */
    function swallowNextClick(){
      const kill=ev=>{ ev.stopPropagation(); ev.preventDefault(); clearTimeout(t); };
      document.addEventListener('click',kill,{capture:true,once:true});
      // no trailing click on some inputs → drop the listener rather than eat a later real one
      const t=setTimeout(()=>document.removeEventListener('click',kill,true),400);
    }
    let finished=false;
    function up(uv){
      if(finished) return; finished=true;                          // idempotent: pointerup OR pointercancel, never both
      clearTimeout(lpTimer);
      document.removeEventListener('pointermove',move);
      document.removeEventListener('pointerup',up);
      document.removeEventListener('pointercancel',up);
      edgeDir=0; if(edgeRAF) cancelAnimationFrame(edgeRAF);
      bl.classList.remove('pressing','dragging','armed');
      if(!armed){ if(!cancelled){ swallowNextClick(); openEventDetail(key); } return; }   // quick tap → detail card
      if(!moved){ return; }                                         // long-pressed but not dragged → just drop, NO detail
      // long-press already confirmed intent → commit the previewed values, then offer
      // undo. A repeating instance is asked 이번만/앞으로 전체 inside commitPatch.
      commitPatch(key,{time:e.time,end:e.end,date:e.date},mode==='move'?'일정을 옮겼어요':'시간을 바꿨어요');
    }
    document.addEventListener('pointermove',move);
    document.addEventListener('pointerup',up);
    // iOS Safari fires pointercancel (not pointerup) when pointerdown's default is
    // prevented — that swallowed the short-tap→detail path. So we DON'T preventDefault
    // (touch-action:none already blocks scroll) and we also catch pointercancel.
    document.addEventListener('pointercancel',up);
    ev.stopPropagation();
  });
}
$('#tlToggle').onclick=()=>{state.tlCollapsed=!state.tlCollapsed;renderTimeline();};
$('#tlTitle').style.cursor='default';

/* ---------- category builder ---------- */
function openCatBuilder(editId, fromSettings){
  const e = editId ? state.categories.find(c=>c.id===editId) : null;
  state.editingCatId = editId||null;
  state.catReturnSettings = !!fromSettings;
  state.newCat = e ? {color:e.color} : {color:'#10B981'};
  $('#catBuilderTitle').textContent = e ? '카테고리 수정' : '새 카테고리';
  $('#cSave').textContent = e ? '적용' : '만들기';
  $('#cName').value = e ? e.name : '';
  $('#palette').innerHTML=PALETTE.map(c=>`<div class="sw${c===state.newCat.color?' sel':''}" data-c="${c}" style="background:${c}"></div>`).join('')
    +`<label class="sw hex" title="직접 지정">#<input type="color" id="hexIn" style="position:absolute;opacity:0;width:28px;height:28px;cursor:pointer"></label>`;
  $$('#palette .sw[data-c]').forEach(x=>x.onclick=()=>{state.newCat.color=x.dataset.c;refreshCatBuilder();});
  $('#hexIn').oninput=ev=>{state.newCat.color=ev.target.value;refreshCatBuilder();};
  ensureCatPreview(); renderCatPreview();
  checkDupe();
  openScrim('#catScrim'); setTimeout(()=>$('#cName').focus(),120);
}
/* live preview so a picked color is obviously reflected before saving */
function ensureCatPreview(){
  if(document.getElementById('catPreview')) return;
  const pal=$('#palette'); if(!pal) return;
  const wrap=document.createElement('div');
  wrap.className='cat-preview'; wrap.id='catPreview';
  pal.parentNode.insertBefore(wrap, pal.nextSibling);   // sits right below the swatches
}
function renderCatPreview(){
  const el=document.getElementById('catPreview'); if(!el) return;
  const color=state.newCat.color;
  const name=($('#cName')&&$('#cName').value.trim())||'미리보기';
  el.innerHTML=`<span class="cat-preview-lbl">미리보기</span>`+
    `<span class="cat-preview-chip" style="--cat:${color};background:${tint(color,isDark())};color:${inkOn(color,isDark())}">`+
      `<span class="cat-preview-dot" style="background:${color}"></span>${esc(name)}</span>`;
}
function refreshCatBuilder(){
  $$('#palette .sw[data-c]').forEach(x=>x.classList.toggle('sel',x.dataset.c===state.newCat.color));
  renderCatPreview();
  checkDupe();
}
$('#cName').oninput=()=>{checkDupe();renderCatPreview();};
function checkDupe(){
  const dup=state.categories.find(c=>c.id!==state.editingCatId && c.color.toLowerCase()===state.newCat.color.toLowerCase());
  const el=$('#dupeMsg');
  if(dup){el.textContent=`'${dup.name}'와 같은 색이에요. 그대로 둬도 되지만 헷갈릴 수 있어요.`;el.classList.add('on');}
  else el.classList.remove('on');
}
$('#cSave').onclick=()=>{
  const name=$('#cName').value.trim()||'새 카테고리';
  if(state.editingCatId){
    Object.assign(state.categories.find(c=>c.id===state.editingCatId),{name,color:state.newCat.color});
    toast('색상이 적용됐어요');
  }else{
    const id='c'+Math.random().toString(36).slice(2,7);
    state.categories.push({id,name,color:state.newCat.color});
    state.form.catId=id;
    toast('카테고리를 만들었어요');
  }
  closeScrim('#catScrim');
  renderCatPick();renderLegend();renderMonth();renderTimeline();afterMutate();
  if(state.catReturnSettings){renderCatList();openScrim('#setScrim');}
};
$('#cCancel').onclick=()=>{ closeScrim('#catScrim'); if(state.catReturnSettings) openScrim('#setScrim'); };

/* ---------- settings: category manager ---------- */
function openSettings(){ renderCatList(); openScrim('#setScrim'); }
function renderCatList(){
  $('#catList').innerHTML = state.categories.map(c=>{
    const used = state.events.filter(e=>e.catId===c.id).length;
    return `<div class="catrow">
      <span class="cat-swatch" style="background:${c.color}"></span>
      <span class="cat-name">${esc(c.name)}${c.fixed?'<span class="cat-fixed">기본 · 삭제 불가</span>':(used?`<span class="cat-fixed">일정 ${used}개</span>`:'')}</span>
      <button class="cat-btn edit" data-edit="${c.id}" aria-label="수정"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button class="cat-btn del" data-del="${c.id}" aria-label="삭제" ${c.fixed?'disabled':''}><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg></button>
    </div>`;
  }).join('');
  $$('#catList [data-edit]').forEach(b=>b.onclick=()=>{closeScrim('#setScrim');openCatBuilder(b.dataset.edit,true);});
  $$('#catList [data-del]').forEach(b=>b.onclick=()=>{ if(!b.disabled) askDeleteCategory(b.dataset.del); });
}
let confirmCb=null;
function showConfirm(o){
  o=o||{};
  $('#confirmTitle').textContent=o.title||'삭제할까요?';
  $('#confirmMsg').textContent=o.msg||'';
  $('#confirmOk').textContent=o.okLabel||'삭제';
  openScrim('#confirmScrim');
  return new Promise(res=>{ confirmCb=res; });
}
function resolveConfirm(v){ closeScrim('#confirmScrim'); if(confirmCb){const cb=confirmCb; confirmCb=null; cb(v);} }
$('#confirmOk').onclick=()=>resolveConfirm(true);
$('#confirmCancel').onclick=()=>resolveConfirm(false);
$('#confirmScrim').addEventListener('click',e=>{ if(e.target===$('#confirmScrim')) resolveConfirm(false); });
async function askDeleteCategory(id){
  const c=state.categories.find(x=>x.id===id); if(!c||c.fixed) return;
  const used=state.events.filter(e=>e.catId===id).length;
  const ok=await showConfirm({title:`'${c.name}' 삭제`, msg: used?`이 카테고리의 일정 ${used}개는 '기타'로 옮겨져요. 정말 삭제할까요?`:`'${c.name}' 카테고리를 삭제할까요?`, okLabel:'삭제'});
  if(ok) deleteCategory(id);
}
function deleteCategory(id){
  const c=state.categories.find(x=>x.id===id); if(!c||c.fixed) return;
  const used=state.events.filter(e=>e.catId===id).length;
  const other=state.categories.find(x=>x.fixed);   // '기타'
  state.events.forEach(e=>{
    if(e.catId===id) e.catId=other.id;
    // "이번만" 수정본도 카테고리를 들고 있으므로 함께 옮긴다 (안 그러면 죽은 id가 남는다)
    if(e.overrides) Object.keys(e.overrides).forEach(k=>{ if(e.overrides[k].catId===id) e.overrides[k].catId=other.id; });
  });
  state.categories=state.categories.filter(x=>x.id!==id);
  if(state.form.catId===id) state.form.catId=other.id;
  renderCatList();renderLegend();renderCatPick();renderMonth();renderTimeline();afterMutate();
  toast(used?`'${c.name}' 삭제 · 일정 ${used}개는 '기타'로 옮겼어요`:`'${c.name}'를 삭제했어요`);
}
$('#setAddCat').onclick=()=>{closeScrim('#setScrim');openCatBuilder(null,true);};
$('#setDone').onclick=()=>closeScrim('#setScrim');

/* ---------- share sheet: create multiple links + manage the list ---------- */
/* No accounts: "ownership" = holding the token. state.shareLinks (in IndexedDB)
   is the creator's private list of links they made, so they can revisit each
   link's status and the comments it received. Public/private is one global flag
   per event, so every live link necessarily shows the same public set — and each
   toggle is pushed to ALL live links, so a private event can't linger anywhere. */
let createExp=30, createCmt=true;   // settings for the NEXT link to be created
function autoLinkName(){const d=new Date();return `${d.getMonth()+1}월 ${d.getDate()}일 공유`;}
function openShare(){
  buildShareSheet();                 // (re)build sheet body so ids + handlers are fresh
  renderZones(); renderWarn();
  $('#shName').value=''; $('#shName').placeholder=autoLinkName();
  $('#newLinkWrap').innerHTML='';
  openScrim('#shScrim');
  renderLinks();
}
function renderWarn(){
  $('#warnBox').innerHTML = state.shareLinks.some(isLinkLive)
    ? `<div class="warn"><svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/></svg>
        프라이빗으로 내리면 지금 살아있는 모든 링크에서도 함께 숨겨져요.</div>` : '';
}
function fmtWhen(e){
  const [y,m,d]=e.date.split('-').map(Number);
  const dt=new Date(y,m-1,d);
  const wd=['일','월','화','수','목','금','토'][dt.getDay()];
  // a rule shows itself, not just its first date — the link carries every occurrence
  if(isRepeat(e)) return `${describeRule(e.rrule,e.date)}${e.time?' · '+e.time:' · 종일'}`;
  return `${m}월 ${d}일 (${wd})${e.time?' · '+e.time:' · 종일'}`;
}
function evRowHtml(e){
  const c=cat(e.catId);
  const dir=e.isPrivate
    ? '<svg class="svg dir" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'
    : '<svg class="svg dir" viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  const bg=e.isPrivate?'':`background:${tint(c.color,isDark())}`;
  const col=e.isPrivate?'':`color:${inkOn(c.color,isDark())}`;
  return `<div class="evrow${e.isPrivate?' priv':''}" data-id="${e.id}" style="${bg}">
    <span class="nm" style="${col}"><span class="evrow-t">${esc(e.title)}${isRepeat(e)?repeatIcon():''}</span><span class="when" style="color:${e.isPrivate?'var(--ink-faint)':inkOn(c.color,isDark())};opacity:.72">${fmtWhen(e)}</span></span>${dir}</div>`;
}
function byDate(a,b){return (a.date+ (a.time||'')).localeCompare(b.date+(b.time||''));}
function renderZones(){
  const pub=state.events.filter(e=>!e.isPrivate).sort(byDate),
        priv=state.events.filter(e=>e.isPrivate).sort(byDate);
  $('#pubCnt').textContent='· '+pub.length;
  $('#privCnt').textContent='· '+priv.length;
  $('#pubZone').innerHTML=pub.map(evRowHtml).join('')||'<p style="font-size:12.5px;color:var(--ink-faint);padding:2px 4px 10px">공개할 일정이 없어요.</p>';
  $('#privZone').innerHTML=priv.map(evRowHtml).join('')||'<p style="font-size:12.5px;color:var(--ink-faint);padding:2px 4px">숨긴 일정이 없어요.</p>';
  $$('#shScrim .evrow').forEach(r=>r.onclick=()=>toggleVis(r));
}
function toggleVis(row){
  const e=state.events.find(x=>x.id===row.dataset.id);
  row.classList.add('moving');
  setTimeout(()=>{
    e.isPrivate=!e.isPrivate;              // single source of truth flips → syncs everywhere
    renderZones(); renderMonth();          // calendar reflects it immediately
    afterMutate();                         // persist + push updated public snapshot to the live link
    toast(e.isPrivate?'프라이빗으로 내렸어요':'공개로 올렸어요');
  },300);
}
$('#shareBtn').onclick=openShare;   // the sheet body + its controls are wired in buildShareSheet()

/* ---------- scrim util ---------- */
function openScrim(s){$(s).classList.add('on'); syncBackOpen();}
function closeScrim(s){$(s).classList.remove('on');}

/* ---------- freeze the page behind an open sheet ----------
   The scrim is already position:fixed, but the page under it kept scrolling, so the
   blurred backdrop drifted while a card was open. iOS Safari ignores overflow:hidden
   on the scroller, so we pin the body with position:fixed at -scrollY and restore the
   exact offset on close. Layers stack (confirm over sheet) → lock on "any scrim open". */
let lockedY=0, scrollLocked=false;
function setScrollLock(on){
  if(on===scrollLocked) return;
  const b=document.body;
  if(on){
    lockedY=window.scrollY||document.documentElement.scrollTop||0;
    const gutter=window.innerWidth-document.documentElement.clientWidth;   // desktop scrollbar width
    b.style.top=(-lockedY)+'px';
    if(gutter>0) b.style.paddingRight=gutter+'px';                         // no content shift on desktop
    b.classList.add('scroll-locked');
  }else{
    b.classList.remove('scroll-locked');
    b.style.top=''; b.style.paddingRight='';
    window.scrollTo(0,lockedY);
  }
  scrollLocked=on;
}
let lockRaf=0;
function syncScrollLock(){
  if(lockRaf) return;
  lockRaf=requestAnimationFrame(()=>{ lockRaf=0; setScrollLock(!!document.querySelector('.scrim.on')); });
}
/* a dozen paths toggle .on (and some scrims are injected on first use), so watch the
   DOM rather than patch every call site — back button and Escape are covered too. */
new MutationObserver(syncScrollLock).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});

/* ---------- Android/browser back: close the top open layer first; exit only at home ----------
   While any overlay (sheet/modal/detail/picker/menu) is open we keep ONE history
   sentinel. A back press pops it → popstate closes the topmost layer (re-arming a
   sentinel if more remain). With nothing open, back does its normal thing (leave). */
let sdSentinel=false;
function overlayCount(){
  let n=document.querySelectorAll('.scrim.on').length;
  const menu=document.getElementById('appMenu');
  if(menu && menu.classList.contains('on')) n++;
  return n;
}
function closeTopOverlay(){
  const menu=document.getElementById('appMenu');
  const scrims=[...document.querySelectorAll('.scrim.on')];
  const menuOpen=menu && menu.classList.contains('on');
  // pick the visually topmost: compare menu(z=60) against the highest-z open scrim
  scrims.sort((a,b)=>(parseInt(getComputedStyle(b).zIndex)||0)-(parseInt(getComputedStyle(a).zIndex)||0));
  const topScrim=scrims[0];
  const topScrimZ=topScrim?(parseInt(getComputedStyle(topScrim).zIndex)||0):-1;
  if(menuOpen && topScrimZ<60){ closeMenu(); return; }
  if(!topScrim) { if(menuOpen) closeMenu(); return; }
  if(topScrim.id==='confirmScrim'){ resolveConfirm(false); return; }   // also settles the pending promise
  if(topScrim.id==='scopeScrim'){ resolveScope(null); return; }
  topScrim.classList.remove('on');
}
function syncBackOpen(){   // called right after any overlay is shown
  if(!sdSentinel && overlayCount()>0){ sdSentinel=true; try{ history.pushState({sd:1},''); }catch(e){} }
}
window.addEventListener('popstate',()=>{
  if(overlayCount()>0){
    closeTopOverlay();
    sdSentinel=false;
    if(overlayCount()>0){ sdSentinel=true; try{ history.pushState({sd:1},''); }catch(e){} }  // re-arm for the next layer
  }else{
    sdSentinel=false;   // stale sentinel consumed → next back leaves the app
  }
});
$$('.scrim').forEach(sc=>sc.onclick=e=>{if(e.target===sc)sc.classList.remove('on');});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){
  const cs=$('#confirmScrim'); if(cs&&cs.classList.contains('on')) resolveConfirm(false);  // don't leave a pending confirm hanging
  const ss=document.getElementById('scopeScrim'); if(ss&&ss.classList.contains('on')) resolveScope(null);
  $$('.scrim.on').forEach(s=>s.classList.remove('on'));closeMenu();}});

/* ---------- toast ---------- */
let tT;
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('on');clearTimeout(tT);tT=setTimeout(()=>t.classList.remove('on'),1900);}
/* toast with a right-side "실행취소" action; auto-confirms after ~5s if untouched */
function toastUndo(msg,onUndo){
  const t=$('#toast');
  t.innerHTML='<span class="toast-msg"></span><button class="toast-act" type="button">실행취소</button>';
  t.querySelector('.toast-msg').textContent=msg;
  let used=false;
  t.querySelector('.toast-act').onclick=()=>{ if(used) return; used=true; clearTimeout(tT); t.classList.remove('on'); if(onUndo) onUndo(); };
  t.classList.add('on'); clearTimeout(tT); tT=setTimeout(()=>t.classList.remove('on'),5000);
}

/* ============================================================
   BACKEND INTEGRATION  (added for the deployable app)
   - personal events/categories → IndexedDB (device only, never uploaded)
   - share link → POST/PUT/DELETE /api/share (public events only)
   - holidays  → GET /api/holidays (server-cached, key hidden)
   ============================================================ */

/* ---------- IndexedDB (device-only persistence) ---------- */
const IDB_NAME='shareday', IDB_STORE='kv';
function idbOpen(){return new Promise((res,rej)=>{
  const r=indexedDB.open(IDB_NAME,1);
  r.onupgradeneeded=()=>r.result.createObjectStore(IDB_STORE);
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
});}
async function idbGet(key){try{const db=await idbOpen();return await new Promise((res,rej)=>{
  const rq=db.transaction(IDB_STORE,'readonly').objectStore(IDB_STORE).get(key);
  rq.onsuccess=()=>res(rq.result); rq.onerror=()=>rej(rq.error);});}catch(e){return undefined;}}
async function idbSet(key,val){try{const db=await idbOpen();return await new Promise((res,rej)=>{
  const tx=db.transaction(IDB_STORE,'readwrite');
  tx.objectStore(IDB_STORE).put(val,key);
  tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);});}catch(e){}}

let persistT;
function persist(){clearTimeout(persistT);persistT=setTimeout(()=>{
  idbSet('events',state.events); idbSet('categories',state.categories);
},250);}
/* called after every change: save locally + push the public snapshot to every live link
   (+ rewrite the iOS widget snapshot; no-op everywhere else) */
function afterMutate(){ persist(); syncAllLive(); scheduleWidgetSnapshot(); }

/* ---------- share links: one server row per link, all owned by this device ---------- */
state.shareLinks=[];   // [{token,url,name,createdAt,expiresAt,allowComments,revoked,count}], newest last
state.cmtSeenAt=0;     // last time the owner viewed comments → drives the "새 N" badge
function saveShareLinks(){ idbSet('shareLinks', state.shareLinks); }
/* The recipient gets real dates, never rules: a repeating event is expanded across the
   share window before it is uploaded, so their page needs no RRULE code at all.
   Privacy is per instance — a base marked private contributes nothing, and an
   "이번만" override that flips isPrivate hides just that one date.
   The window is anchored on the current month so a re-push keeps the same instance ids
   (`<baseId>@<date>`), which is what comments hang off. */
const SHARE_MONTHS=12;
const SHARE_CAP=2000;                    // matches the server's sanitizeEvents() cap
function shareWindow(){
  const t=new Date();
  return [iso(new Date(t.getFullYear(),t.getMonth()-1,1)),
          iso(new Date(t.getFullYear(),t.getMonth()+1+SHARE_MONTHS,0))];
}
function publicSnapshot(){
  const [from,to]=shareWindow();
  return expandRange(from,to)
    .filter(e=>!e.isPrivate)
    .sort(byDate)
    .slice(0,SHARE_CAP)
    .map(e=>({id:e.id,date:e.date,time:e.time||'',end:e.end||'',
              title:e.title,catId:e.catId,memo:e.memo||'',isPrivate:false}));
}
/* payload for ONE link — carries that link's own expiry + comment pref so a sync
   never clobbers them. expiresAt is fixed at creation, so it doesn't slide forward. */
function linkPayload(l){
  return {
    events: publicSnapshot(),
    categories: state.categories,
    allowComments: l.allowComments!==false,
    expiresAt: l.expiresAt||null,
  };
}
function isLinkLive(l){
  if(l.revoked) return false;
  if(l.expiresAt && new Date(l.expiresAt).getTime()<=Date.now()) return false;
  return true;
}
function linkStatus(l){
  if(l.revoked) return {kind:'revoked',label:'폐기됨'};
  if(l.expiresAt && new Date(l.expiresAt).getTime()<=Date.now()) return {kind:'expired',label:'만료됨'};
  if(!l.expiresAt) return {kind:'live',label:'무기한'};
  const days=Math.ceil((new Date(l.expiresAt).getTime()-Date.now())/86400000);
  return {kind:'live',label:'D-'+Math.max(0,days)};
}
async function createShareLink(){
  const name=$('#shName').value.trim()||autoLinkName();
  const btn=$('#createLinkBtn'); if(btn.disabled) return;
  if(!isOnline()){ toast(OFFLINE_MSG); return; }        // creating a link needs the server
  btn.disabled=true; const prev=btn.innerHTML; btn.textContent='만드는 중…';
  try{
    const res=await fetch(api('/api/share'),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({events:publicSnapshot(),categories:state.categories,allowComments:createCmt,expiresDays:createExp})});
    const data=await res.json();
    if(res.ok){
      const link={token:data.token,url:data.url,name,createdAt:Date.now(),
        expiresAt:createExp>0?new Date(Date.now()+createExp*86400000).toISOString():null,
        allowComments:createCmt,revoked:false,count:data.count};
      state.shareLinks.push(link); saveShareLinks();
      $('#shName').value=''; showNewLink(link); renderLinks(); renderWarn();
      toast('공유 링크를 만들었어요');
    }else toast('링크를 만들지 못했어요');
  }catch(e){ toast('네트워크 오류예요'); }
  finally{ btn.disabled=false; btn.innerHTML=prev; }
}
/* push the current public snapshot to one existing link (PUT keeps its token). */
async function pushLink(l){
  try{
    const res=await fetch(api('/api/share/'+encodeURIComponent(l.token)),
      {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(linkPayload(l))});
    if(res.ok){ const d=await res.json(); l.url=d.url; l.count=d.count; }
  }catch(e){}
}
/* after any change: push to every live link so private events vanish everywhere.
   Offline the push is skipped; the 'online' listener re-runs it with the latest
   snapshot, so a link is never left showing a private event. */
let shareChain=Promise.resolve();
function syncAllLive(){
  if(!isOnline()) return Promise.resolve();
  const live=state.shareLinks.filter(isLinkLive);
  if(!live.length) return Promise.resolve();
  shareChain=shareChain.then(async()=>{ await Promise.all(live.map(pushLink)); saveShareLinks(); });
  return shareChain;
}
/* remove a link from MY list. A LIVE link is revoked on the server first so it
   can't linger as a ghost (in the server but not my list); an already-dead
   (revoked/expired) link is just spliced out locally. Only live removal confirms. */
async function deleteLink(token){
  const l=state.shareLinks.find(x=>x.token===token); if(!l) return;
  if(isLinkLive(l)){
    if(!isOnline()){ toast(OFFLINE_MSG); return; }   // revoking must reach the server, or we'd leave a ghost
    const ok=await showConfirm({title:'링크 삭제', msg:'이 링크를 삭제하면 받은 사람도 더는 못 봐요. 삭제할까요?', okLabel:'삭제'});
    if(!ok) return;
    let done=false;
    try{ const res=await fetch(api('/api/share/'+encodeURIComponent(token)),{method:'DELETE'}); done=res.ok; }
    catch(e){ done=false; }
    if(!done){ toast('삭제하지 못했어요. 잠시 후 다시 시도해 주세요'); return; }   // no ghost state
  }
  state.shareLinks=state.shareLinks.filter(x=>x.token!==token);   // dead → local only; live → server already revoked
  saveShareLinks(); renderLinks(); renderWarn();
  toast('목록에서 삭제했어요');
}

/* ---------- share sheet body (built in JS so we never touch the markup export) ---------- */
function buildShareSheet(){
  const sheet=document.querySelector('#shScrim .sheet'); if(!sheet) return;
  sheet.innerHTML=`
    <h2>내 캘린더 공유하기</h2>
    <p class="sub">내 공개 일정만 친구에게 보여요. 프라이빗 일정은 어떤 링크에서도 보이지 않아요.
      반복 일정(↻)은 앞으로 1년치가 펼쳐져 담겨요.</p>
    <div id="warnBox"></div>
    <div class="zone-h pub"><svg class="svg" viewBox="0 0 24 24" style="width:15px;height:15px"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg> 공개됨 <span class="cnt" id="pubCnt"></span></div>
    <div id="pubZone"></div>
    <hr class="divider">
    <div class="zone-h priv"><svg class="svg" viewBox="0 0 24 24" style="width:15px;height:15px"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg> 프라이빗 <span class="cnt" id="privCnt"></span></div>
    <div id="privZone"></div>
    <div class="field" style="margin-top:12px;margin-bottom:14px">
      <label for="shName">링크 이름</label>
      <input class="inp" id="shName" placeholder="예: 가족용" autocomplete="off">
    </div>
    <label style="display:block;font-size:12.5px;color:var(--ink-soft);font-weight:600;margin-bottom:8px">만료</label>
    <div class="seg" id="expSeg">
      <button data-d="7">7일</button><button data-d="30" class="on">30일</button>
      <button data-d="90">90일</button><button data-d="0">무기한</button>
    </div>
    <div class="togline">
      <span><svg class="svg" viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> 코멘트 허용</span>
      <div class="switch on" id="cmtSwitch" role="switch" aria-checked="true"></div>
    </div>
    <button class="btn solid" id="createLinkBtn" style="width:100%;height:46px;justify-content:center;margin-top:14px">
      <svg class="svg" viewBox="0 0 24 24" style="width:16px;height:16px"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg> 내 캘린더 공유하기
    </button>
    <div id="newLinkWrap"></div>
    <div class="links-sec">
      <div class="inbox-h">내 공유 링크 <span class="inbox-cnt" id="linksCnt"></span></div>
      <div id="linksList"></div>
    </div>
    <div class="sheet-actions"><button class="btn solid" id="shDone" style="flex:1">완료</button></div>`;
  wireShareSheet();
}
function wireShareSheet(){
  $('#createLinkBtn').onclick=createShareLink;
  $('#shDone').onclick=()=>closeScrim('#shScrim');
  $$('#expSeg button').forEach(b=>{ b.classList.toggle('on', +b.dataset.d===createExp);
    b.onclick=()=>{$$('#expSeg button').forEach(x=>x.classList.remove('on'));b.classList.add('on');createExp=+b.dataset.d;}; });
  const cs=$('#cmtSwitch'); cs.classList.toggle('on',createCmt); cs.setAttribute('aria-checked',createCmt);
  cs.onclick=function(){createCmt=!createCmt;this.classList.toggle('on',createCmt);this.setAttribute('aria-checked',createCmt);};
}
function copyText(t){ if(navigator.clipboard) navigator.clipboard.writeText(t); toast('링크를 복사했어요'); }
function showNewLink(link){
  const w=$('#newLinkWrap'); if(!w) return;
  w.innerHTML=`<div class="newlink"><span class="newlink-lbl">방금 만든 링크</span>
    <div class="linkbar" style="margin:8px 0 0"><code>${esc(link.url)}</code>
      <button class="btn ghost icn" id="newLinkCopy" aria-label="링크 복사"><svg class="svg" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div></div>`;
  $('#newLinkCopy').onclick=()=>copyText(link.url);
}

/* ---------- "내 공유 링크" list: status · copy · expiry · revoke · received comments ---------- */
function fmtCmtTime(iso){
  const d=new Date(iso); if(isNaN(d.getTime())) return '';
  const p=n=>String(n).padStart(2,'0');
  return `${d.getMonth()+1}.${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const CMT_SVG='<svg class="svg" viewBox="0 0 24 24" style="width:13px;height:13px;display:inline;vertical-align:-2px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
function cardShell(l){
  const st=linkStatus(l), live=st.kind==='live', revoked=!!l.revoked, dead=!live;
  const name=esc(l.name||autoLinkName());
  const pencil='<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  return `<div class="lcard${dead?' dead':''}" data-token="${l.token}">
    <div class="lcard-name-row"><span class="lcard-name">${name}</span>
      ${revoked?'':`<button class="lcard-rename" data-rename aria-label="이름 수정">${pencil}</button>`}</div>
    <div class="lcard-meta">
      <span class="lbadge ${st.kind}">${st.label}</span>
      <span class="lmeta-sep">·</span>공개 <span data-count>${l.count!=null?l.count:'—'}</span>
      <span class="lmeta-sep">·</span><span class="lmeta-cmt" data-cmtcount>${dead?CMT_SVG+' 0':CMT_SVG+' …'}</span>
    </div>
    <div class="lcard-actions">
      <button data-act="copy"${live?'':' disabled'}>링크 복사</button>
      <button data-act="open"${live?'':' disabled'}>열기</button>
      ${revoked?'':'<button data-act="expiry">만료 수정</button>'}
      <button data-act="toggle">코멘트 보기</button>
      <button data-act="delete" class="danger">${live?'삭제':'목록에서 삭제'}</button>
    </div>
    <div class="lcard-cmts" hidden><p class="lc-note">불러오는 중…</p></div>
  </div>`;
}
function wireLinkCards(){
  $$('#linksList .lcard').forEach(card=>{
    const token=card.dataset.token;
    const l=state.shareLinks.find(x=>x.token===token); if(!l) return;
    card.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{
      const act=b.dataset.act;
      if(act==='copy') copyText(l.url);
      else if(act==='open'){ if(l.url) window.open(l.url,'_blank','noopener'); }
      else if(act==='expiry') editExpiry(token,card);
      else if(act==='delete') deleteLink(token);
      else if(act==='toggle'){
        const body=card.querySelector('.lcard-cmts'), closed=body.hasAttribute('hidden');
        if(closed){ body.removeAttribute('hidden'); b.textContent='코멘트 접기'; }
        else { body.setAttribute('hidden',''); b.textContent='코멘트 보기'; }
      }
    });
    const rn=card.querySelector('[data-rename]'); if(rn) rn.onclick=()=>startRename(token,card);
  });
}
/* rename in place — no accounts, so the name is just a local label for the owner */
function startRename(token,card){
  const l=state.shareLinks.find(x=>x.token===token); if(!l) return;
  const nameEl=card.querySelector('.lcard-name'); if(!nameEl) return;
  const input=document.createElement('input');
  input.className='inp lcard-name-input'; input.value=l.name||autoLinkName();
  nameEl.replaceWith(input); input.focus(); input.select();
  let done=false;
  const commit=()=>{ if(done) return; done=true; const v=input.value.trim(); l.name=v||l.name||autoLinkName(); saveShareLinks(); renderLinks(); };
  input.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();commit();} else if(e.key==='Escape'){done=true;renderLinks();} });
  input.addEventListener('blur',commit);
}
/* re-date a link inline; PUT (where revoked=false) also revives an only-expired link */
function editExpiry(token,card){
  const l=state.shareLinks.find(x=>x.token===token); if(!l) return;
  const existing=card.querySelector('.lcard-expiry');
  if(existing){ existing.remove(); return; }
  const box=document.createElement('div'); box.className='lcard-expiry';
  box.innerHTML='<span class="lexp-lbl">만료 다시 정하기</span><div class="seg">'+
    [['7','7일'],['30','30일'],['90','90일'],['0','무기한']].map(([d,t])=>`<button data-d="${d}">${t}</button>`).join('')+'</div>';
  card.querySelector('.lcard-actions').after(box);
  box.querySelectorAll('.seg button').forEach(b=>b.onclick=async()=>{
    const days=+b.dataset.d;
    l.expiresAt = days>0 ? new Date(Date.now()+days*86400000).toISOString() : null;
    saveShareLinks();
    await pushLink(l);
    renderLinks(); renderWarn();
    toast('만료를 바꿨어요');
  });
}
async function renderLinks(){
  const list=$('#linksList'); if(!list) return;
  const links=[...state.shareLinks].reverse();   // newest first
  $('#linksCnt').textContent = links.length ? ('· '+links.length) : '';
  if(!links.length){ list.innerHTML='<p class="links-empty">아직 만든 공유 링크가 없어요. 위에서 새로 만들어 보세요.</p>'; return; }
  list.innerHTML=links.map(cardShell).join('');
  wireLinkCards();
  const seenAt=state.cmtSeenAt||0;               // capture BEFORE we reset it below
  await Promise.all(links.map(l=>fillLinkCard(l,seenAt)));
  state.cmtSeenAt=Date.now(); idbSet('cmtSeenAt',state.cmtSeenAt);   // opening the list = read
}
/* live links: fetch the snapshot (public count + titles) and comments; dead links can't be read */
async function fillLinkCard(l,seenAt){
  const card=document.querySelector('#linksList .lcard[data-token="'+l.token+'"]'); if(!card) return;
  const badge=card.querySelector('[data-cmtcount]'), body=card.querySelector('.lcard-cmts');
  if(!isLinkLive(l)){
    if(badge) badge.innerHTML=CMT_SVG+' 0';
    if(body) body.innerHTML='<p class="lc-note">폐기·만료된 링크라 코멘트를 볼 수 없어요.</p>';
    return;
  }
  if(!isOnline()){   // comments live only on the server
    if(badge) badge.innerHTML=CMT_SVG+' –';
    if(body) body.innerHTML='<p class="lc-note">오프라인이에요. 연결되면 코멘트를 불러와요.</p>';
    return;
  }
  try{
    const [snapRes,cmtRes]=await Promise.all([
      fetch(api('/api/share/'+encodeURIComponent(l.token))),
      fetch(api('/api/share/'+encodeURIComponent(l.token)+'/comments')),
    ]);
    let titles={};
    if(snapRes.ok){ const snap=await snapRes.json(); l.count=(snap.events||[]).length;
      const cntEl=card.querySelector('[data-count]'); if(cntEl) cntEl.textContent=l.count;
      (snap.events||[]).forEach(e=>titles[e.id]=e.title); }
    let comments=[];
    if(cmtRes.ok){ const c=await cmtRes.json(); comments=c.comments||[]; }
    comments.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));  // newest first
    const fresh=comments.filter(c=>new Date(c.created_at).getTime()>seenAt).length;
    if(badge) badge.innerHTML=CMT_SVG+' '+comments.length+(fresh?` <span class="inbox-new">새 ${fresh}</span>`:'');
    if(body){
      body.innerHTML = comments.length
        ? comments.map(c=>`<div class="lc-row">
            <div class="lc-top"><span class="lc-title">${esc(titles[c.event_id]||'(삭제된 일정)')}</span><span class="lc-time">${fmtCmtTime(c.created_at)}</span></div>
            <div class="lc-cmt"><b>${esc(c.author_name)}</b> ${esc(c.body)}</div></div>`).join('')
        : '<p class="lc-note">아직 받은 코멘트가 없어요.</p>';
    }
    saveShareLinks();   // persist the refreshed count
  }catch(e){}
}

/* ---------- received-links storehouse (links OTHERS shared with me) ---------- */
/* Kept separate from state.shareLinks (links I created): different purpose —
   this list is read-only re-access. No accounts, so holding the token = access;
   we re-fetch GET /api/share/[token] whenever we're online, so expiry/revocation is
   always reflected. The last response is cached (state.friendSnaps) purely as an
   OFFLINE fallback — online never reads it, and a 404/410 wipes it on the spot. */
state.savedLinks=[];   // [{token, ownerName, savedAt, lastOpenedAt, overlay}], newest last
function saveSavedLinks(){ idbSet('savedLinks', state.savedLinks); }

/* token -> {events, cats, fetchedAt}. Public snapshots only — the same data the
   server would hand any link holder, so caching it leaks nothing. My own private
   events are never in here (they never leave IndexedDB). */
state.friendSnaps={};
function saveFriendSnaps(){ idbSet('friendSnaps', state.friendSnaps); }
function dropFriendSnap(token){ if(state.friendSnaps[token]){ delete state.friendSnaps[token]; saveFriendSnaps(); } }

/* ---------- 겹쳐보기: overlay friends' public calendars onto mine ----------
   A "friend" is a saved link someone shared with me. Turning overlay on fetches
   that friend's LATEST public snapshot (never copied to disk) and merges it into
   my month + week views, tinted by a per-friend source color. Read-only; private
   events never appear (the snapshot only ever contains public ones). */
state.overlayCache={};                 // token -> {ok, events, cats, name, color, token}
const FRIEND_PALETTE=['#3B82F6','#7C6BE8','#EC4899','#14B8A6','#F59E0B','#EF6B7D','#0EA271','#22C55E'];
function friendColorFor(token){
  const i=state.savedLinks.findIndex(l=>l.token===token);
  return FRIEND_PALETTE[(i<0?0:i)%FRIEND_PALETTE.length];
}
function activeFriends(){ return state.savedLinks.filter(l=>l.overlay); }
function overlayOn(){ return activeFriends().length>0; }
/* Latest-first: online we always take the server's answer and refresh the cache.
   The cache is read only when the network can't answer — and it's labelled stale so
   an old snapshot is never mistaken for the current one. */
async function fetchFriendSnapshot(l){
  const token=l.token;
  const base={ok:false, token, name:l.ownerName||'친구', color:friendColorFor(token)};
  const stale=()=>{
    const c=state.friendSnaps[token];
    return c ? {...base, ok:true, events:c.events, cats:c.cats, stale:true, fetchedAt:c.fetchedAt} : base;
  };
  if(!isOnline()) return stale();
  try{
    const res=await fetch(api('/api/share/'+encodeURIComponent(token)));
    if(res.status===404||res.status===410){    // expired/revoked → the cache is dead too
      dropFriendSnap(token);
      return {...base, gone:true};
    }
    if(!res.ok) return stale();                // 5xx / hiccup → last known is better than blank
    const d=await res.json();
    const cats={}; (d.categories||[]).forEach(c=>cats[c.id]=c);
    const events=d.events||[];
    state.friendSnaps[token]={events, cats, fetchedAt:Date.now()};
    saveFriendSnaps();
    return {...base, ok:true, events, cats};
  }catch(e){ return stale(); }
}
let overlayReqSeq=0;
/* refresh selected friends' snapshots, then repaint. Paints once up-front too so a
   toggle feels instant even before the network returns. */
async function refreshOverlays(){
  const friends=activeFriends();
  Object.keys(state.overlayCache).forEach(t=>{ if(!friends.some(f=>f.token===t)) delete state.overlayCache[t]; });
  renderMonth(); renderTimeline(); renderLegend();
  const seq=++overlayReqSeq;
  const snaps=await Promise.all(friends.map(fetchFriendSnapshot));
  if(seq!==overlayReqSeq) return;                 // a newer refresh superseded this one
  const gone=snaps.filter(s=>s.gone);
  if(gone.length){                                // back online with dead links → stop overlaying them
    gone.forEach(s=>{ const l=state.savedLinks.find(x=>x.token===s.token); if(l) l.overlay=false; });
    saveSavedLinks();
    toast(gone.length===1?`${gone[0].name}님의 링크가 만료·폐기됐어요`:'만료·폐기된 친구 링크를 정리했어요');
  }
  snaps.forEach(s=>{ if(!s.gone) state.overlayCache[s.token]=s; });
  gone.forEach(s=>{ delete state.overlayCache[s.token]; });
  renderMonth(); renderTimeline(); renderLegend();
}
function overlayEventsForDate(di){
  const out=[];
  activeFriends().forEach(l=>{
    const c=state.overlayCache[l.token]; if(!c||!c.ok) return;
    c.events.forEach(e=>{ if(e.date===di) out.push({e, friend:c}); });
  });
  return out;
}
/* read-only detail for a friend's event (reuses the mini-card, hides 수정/삭제) */
function openFriendDetail(token,eid){
  const c=state.overlayCache[token]; if(!c||!c.ok) return;
  const e=c.events.find(x=>x.id===eid); if(!e) return;
  ensureDetailModal();
  const mn=document.getElementById('dtMenu'); if(mn) mn.classList.remove('on');
  const more=document.getElementById('dtMore'); if(more) more.style.display='none';
  state.detailId=null;
  $('#dtDot').style.background=c.color;
  $('#dtTitle').textContent=e.title||'제목 없음';
  $('#dtWhen').textContent=fmtDetailWhen(e);
  $('#dtRepeat').innerHTML='';        // friends' snapshots arrive already expanded — no rule to show
  const fc=e.catId?c.cats[e.catId]:null;
  const fcol=(fc&&fc.color)||c.color;
  $('#dtCat').innerHTML=(fc&&fc.name)
    ? `<span class="dt-cat-tag" style="background:${tint(fcol,isDark())};color:${inkOn(fcol,isDark())}">${esc(fc.name)}</span>` : '';
  const memo=$('#dtMemo');
  if(e.memo){ memo.textContent=e.memo; memo.style.display='block'; } else memo.style.display='none';
  $('#dtVis').innerHTML=`<span class="dt-friend" style="color:${c.color}">●</span> ${esc(c.name)}님의 공개 일정`;
  openScrim('#dtScrim');
}
function fmtSavedDate(ms){
  const d=new Date(ms); if(isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${d.getMonth()+1}.${d.getDate()}`;
}
function buildRecvSheet(){
  if(document.getElementById('recvScrim')) return;
  const scrim=document.createElement('div');
  scrim.className='scrim'; scrim.id='recvScrim';
  scrim.innerHTML=`
    <div class="sheet" role="dialog" aria-modal="true" style="max-width:460px">
      <h2>친구 캘린더</h2>
      <p class="sub">친구가 준 공유 링크를 이름으로 모아둬요. <b>겹쳐보기</b>를 켜면 그 친구의 공개 일정이 내 달력 위에 함께 보여요. 프라이빗은 보이지 않아요.</p>
      <div id="recvList"></div>
      <div class="sheet-actions"><button class="btn solid" id="recvDone" style="flex:1">완료</button></div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.onclick=ev=>{ if(ev.target===scrim) closeScrim('#recvScrim'); };
  $('#recvDone').onclick=()=>closeScrim('#recvScrim');
}
function openRecv(){ buildRecvSheet(); openScrim('#recvScrim'); renderRecv(); }
/* rename a friend calendar in place — my private alias (no accounts). Keeps the
   overlay legend/detail in sync by updating the fetched snapshot's name too. */
function startRecvRename(token,card){
  const l=state.savedLinks.find(x=>x.token===token); if(!l) return;
  const nameEl=card.querySelector('.rcard-name'); if(!nameEl) return;
  const input=document.createElement('input');
  input.className='inp lcard-name-input'; input.value=recvOwnerName(l);
  nameEl.replaceWith(input); input.focus(); input.select();
  let done=false;
  const commit=()=>{ if(done) return; done=true;
    const v=input.value.trim();
    if(v){ l.ownerName=v; if(state.overlayCache[token]) state.overlayCache[token].name=v; }
    saveSavedLinks(); renderRecv(); if(overlayOn()) renderLegend();
  };
  input.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();commit();} else if(e.key==='Escape'){done=true;renderRecv();} });
  input.addEventListener('blur',commit);
}
/* my own alias for this friend (editable); falls back to the sharer's name, then a number */
function recvOwnerName(l){
  if(l.ownerName) return l.ownerName;
  const i=state.savedLinks.findIndex(x=>x.token===l.token);
  return '친구 캘린더 '+(i>=0?i+1:1);
}
function recvCardShell(l){
  const on=!!l.overlay, col=friendColorFor(l.token);
  const pencil='<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  return `<div class="rcard" data-token="${l.token}">
    <div class="rcard-top">
      <div class="rcard-main" data-open>
        <div class="rcard-name"><span class="fdot" style="background:${col}"></span>${esc(recvOwnerName(l))}</div>
        <div class="rcard-meta"><span class="rcard-badge" data-status>확인 중…</span>
          <span class="lmeta-sep">·</span>저장 ${fmtSavedDate(l.savedAt)}</div>
      </div>
      <button class="rcard-rename" data-rename aria-label="이름 수정">${pencil}</button>
      <button class="rcard-del" data-del aria-label="목록에서 지우기"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg></button>
    </div>
    <div class="rcard-overlay">
      <span class="rcard-ov-lbl"><span class="fdot" style="background:${col}"></span> 겹쳐보기</span>
      <div class="switch${on?' on':''}" data-overlay role="switch" aria-checked="${on}"></div>
    </div>
  </div>`;
}
async function renderRecv(){
  const list=$('#recvList'); if(!list) return;
  const links=[...state.savedLinks].reverse();   // newest first
  if(!links.length){
    list.innerHTML='<p class="links-empty">아직 저장한 캘린더가 없어요. 받은 링크를 열고 “이 캘린더 저장”을 눌러보세요.</p>';
    return;
  }
  list.innerHTML=links.map(recvCardShell).join('');
  list.querySelectorAll('.rcard').forEach(card=>{
    const token=card.dataset.token;
    const l=state.savedLinks.find(x=>x.token===token);
    card.querySelector('[data-del]').onclick=async(ev)=>{
      ev.stopPropagation();
      const ok=await showConfirm({title:'목록에서 지우기', msg:`'${recvOwnerName(l)}'을(를) 받은 캘린더에서 지울까요?`, okLabel:'지우기'});
      if(!ok) return;
      state.savedLinks=state.savedLinks.filter(x=>x.token!==token); saveSavedLinks(); dropFriendSnap(token); renderRecv();
      toast('목록에서 지웠어요');
    };
    card.querySelector('[data-open]').onclick=()=>{
      if(card.classList.contains('dead')) return;                 // gone → not openable
      if(!isOnline()){ toast('오프라인이에요. 겹쳐보기로 마지막 일정을 볼 수 있어요'); return; }
      l.lastOpenedAt=Date.now(); saveSavedLinks();
      window.open(api('/s/'+encodeURIComponent(token)),'_blank','noopener');
    };
    const rn=card.querySelector('[data-rename]');
    if(rn) rn.onclick=(ev)=>{ ev.stopPropagation(); startRecvRename(token,card); };
    const sw=card.querySelector('[data-overlay]');
    if(sw) sw.onclick=()=>{
      l.overlay=!l.overlay;
      sw.classList.toggle('on',l.overlay); sw.setAttribute('aria-checked',l.overlay);
      saveSavedLinks();
      refreshOverlays();                                          // fetch + merge (or drop) immediately
      toast(l.overlay?`${recvOwnerName(l)}님 일정을 겹쳐봐요`:`${recvOwnerName(l)}님 일정을 숨겼어요`);
    };
  });
  // fetch live status per link (expiry/revocation reflected each open)
  await Promise.all(links.map(async l=>{
    const card=list.querySelector('.rcard[data-token="'+l.token+'"]'); if(!card) return;
    const badge=card.querySelector('[data-status]');
    if(!isOnline()){   // can't confirm expiry offline — say so instead of guessing
      const c=state.friendSnaps[l.token];
      badge.textContent = c ? '오프라인 · '+relTime(c.fetchedAt) : '오프라인';
      return;
    }
    try{
      const res=await fetch(api('/api/share/'+encodeURIComponent(l.token)));
      if(res.ok){
        const d=await res.json();
        if(!d.expiresAt){ badge.textContent='무기한'; }
        else{ const days=Math.ceil((new Date(d.expiresAt).getTime()-Date.now())/86400000);
          badge.textContent = days>0 ? 'D-'+days : '만료됨'; if(days<=0){ card.classList.add('dead'); badge.classList.add('gone'); } }
      }else{ card.classList.add('dead'); badge.textContent='만료됨'; badge.classList.add('gone'); dropFriendSnap(l.token); }  // 410/404 → 만료·폐기 (캐시도 정리)
    }catch(e){ badge.textContent='확인 실패'; }
  }));
}

/* ---------- home-screen widget bridge ----------
   The widget shows PUBLIC snapshots only (share-link tokens) — never private
   events (those live only in IndexedDB and never reach the server). Here the app
   lets the user pick which public calendars the widget shows, and writes the
   selection to the native shared store (iOS App Group / Android SharedPreferences)
   via the WidgetBridge Capacitor plugin. On plain web the plugin is absent, so we
   just persist the choice locally and show a hint. */
const WIDGET_APP_GROUP='group.com.mygenie.shareday';
const WIDGET_KEY='shareday_widget';
state.widgetConfig=null;   // {tokens:[{token,name,kind}], selectedIndex}
function saveWidgetConfigLocal(){ idbSet('widgetConfig', state.widgetConfig); }
function widgetBridge(){ return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WidgetBridge; }
function widgetNative(){ return !!widgetBridge(); }
/* the public calendars the widget can show: my live share links + saved friend links */
function widgetOptions(){
  const opts=[];
  state.shareLinks.filter(isLinkLive).forEach(l=>opts.push({token:l.token, name:l.name||autoLinkName(), kind:'mine'}));
  state.savedLinks.forEach(l=>opts.push({token:l.token, name:recvOwnerName(l), kind:'friend'}));
  return opts;
}
async function pushWidget(){
  const cfg=state.widgetConfig||{tokens:[],selectedIndex:0};
  // base MUST be the deployed API origin, never location.origin: the shell is bundled
  // with the app, so in native that reads capacitor://localhost (iOS) / https://localhost
  // (Android) and the widget's fetch would silently fail into a blank widget.
  const payload={ tokens:cfg.tokens, selectedIndex:cfg.selectedIndex, base:API_ORIGIN, savedAt:Date.now() };
  const br=widgetBridge();
  if(br){
    try{
      await br.setItem({ group:WIDGET_APP_GROUP, key:WIDGET_KEY, value:JSON.stringify(payload) });
      if(br.reloadAllTimelines) await br.reloadAllTimelines();     // iOS WidgetKit
      if(br.updateWidget) await br.updateWidget();                 // Android
    }catch(e){}
  }
}
function ensureWidgetSheet(){
  if(document.getElementById('widgetScrim')) return;
  const scrim=document.createElement('div');
  scrim.className='scrim'; scrim.id='widgetScrim';
  scrim.innerHTML=`
    <div class="sheet" role="dialog" aria-modal="true" style="max-width:460px">
      <h2>홈 위젯</h2>
      <p class="sub">홈 화면 위젯에 보여줄 <b>공개 캘린더</b>를 고르세요. 공개된 일정만 표시돼요 · 프라이빗은 위젯에 나오지 않아요.</p>
      <div id="widgetHint"></div>
      <div id="widgetList"></div>
      <div class="sheet-actions">
        <button class="btn ghost" id="widgetCancel">닫기</button>
        <button class="btn solid" id="widgetSave" style="flex:1">위젯에 적용</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.onclick=ev=>{ if(ev.target===scrim) closeScrim('#widgetScrim'); };
  $('#widgetCancel').onclick=()=>closeScrim('#widgetScrim');
  $('#widgetSave').onclick=saveWidgetChoice;
}
/* iOS gets the App Group widgets (my events); web + Android keep the share-token sheet */
function openWidget(){
  if(isIOS()){ openWidgetIOS(); return; }
  ensureWidgetSheet(); renderWidgetSheet(); openScrim('#widgetScrim');
}
function renderWidgetSheet(){
  const hint=$('#widgetHint');
  hint.innerHTML = widgetNative()
    ? ''
    : `<div class="warn" style="color:var(--ink-soft);background:var(--accent-soft)"><svg viewBox="0 0 24 24" fill="none" style="stroke:var(--accent)"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M14 4h7v7M3 20h7"/></svg>
        홈 화면 위젯은 셰어데이 앱(위젯 지원 버전)에서 보여요. 선택은 저장돼 두었다가 앱에서 그대로 적용돼요.</div>`;
  const opts=widgetOptions();
  const list=$('#widgetList');
  if(!opts.length){
    list.innerHTML='<p class="links-empty">위젯에 넣을 공개 캘린더가 없어요. 먼저 내 캘린더를 공유하거나 친구 캘린더를 저장해 보세요.</p>';
    return;
  }
  const cfg=state.widgetConfig||{tokens:[],selectedIndex:0};
  const chosen=new Set((cfg.tokens||[]).map(t=>t.token));
  const selToken=(cfg.tokens&&cfg.tokens[cfg.selectedIndex])?cfg.tokens[cfg.selectedIndex].token:null;
  list.innerHTML=opts.map(o=>{
    const on=chosen.has(o.token), isSel=o.token===selToken;
    const badge=o.kind==='mine'?'내 캘린더':'친구';
    return `<div class="wrow" data-token="${o.token}">
      <div class="switch${on?' on':''}" data-inc role="switch" aria-checked="${on}"></div>
      <div class="wrow-main"><span class="wrow-name">${esc(o.name)}</span><span class="wrow-kind">${badge}</span></div>
      <button class="wrow-def${isSel?' on':''}" data-def ${on?'':'disabled'}>${isSel?'기본 ✓':'기본으로'}</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.wrow').forEach(row=>{
    const token=row.dataset.token;
    row.querySelector('[data-inc]').onclick=function(){
      const nowOn=!this.classList.contains('on');
      this.classList.toggle('on',nowOn); this.setAttribute('aria-checked',nowOn);
      const def=row.querySelector('[data-def]'); if(def) def.disabled=!nowOn;
    };
    const def=row.querySelector('[data-def]');
    if(def) def.onclick=()=>{
      list.querySelectorAll('.wrow-def').forEach(b=>{ b.classList.remove('on'); b.textContent='기본으로'; });
      def.classList.add('on'); def.textContent='기본 ✓';
    };
  });
}
async function saveWidgetChoice(){
  const rows=[...document.querySelectorAll('#widgetList .wrow')];
  const opts=widgetOptions();
  const tokens=[]; let selectedIndex=0;
  rows.forEach(row=>{
    const on=row.querySelector('[data-inc]').classList.contains('on');
    if(!on) return;
    const token=row.dataset.token, o=opts.find(x=>x.token===token);
    if(o){ if(row.querySelector('[data-def]').classList.contains('on')) selectedIndex=tokens.length; tokens.push({token:o.token, name:o.name, kind:o.kind}); }
  });
  state.widgetConfig={tokens, selectedIndex};
  saveWidgetConfigLocal();
  await pushWidget();
  closeScrim('#widgetScrim');
  toast(tokens.length?(widgetNative()?'위젯에 적용했어요':'위젯 캘린더를 저장했어요'):'위젯에서 캘린더를 비웠어요');
}

/* ============================================================
   iOS home-screen widgets (App Group snapshot — no network)
   ------------------------------------------------------------
   The iOS widgets render from a snapshot this app writes into the App Group; they
   never call the server. So the snapshot carries the events themselves, not share
   tokens: MY events (straight from IndexedDB, private ones included only when the
   user opts in) plus each saved friend's cached public snapshot.

   Everything here is iOS-only. Android keeps reading the legacy `shareday_widget`
   key written by pushWidget() above (its widget fetches public snapshots from the
   server), so this writes a SEPARATE key and leaves that path alone.
   ============================================================ */
const WIDGET_KEY_IOS='shareday_widget_v2';
const WIDGET_WEEK_START=0;              // Sunday — matches weekRange()/renderMonth() on the web
state.widgetIOS={selectedIndex:0, includePrivate:false};
function saveWidgetIOS(){ idbSet('widgetIOS', state.widgetIOS); }

/* [0] is always my calendar; saved friends follow, so a friend's index is stable
   for as long as the saved list is. */
function widgetTargets(){
  return [{kind:'mine', name:'내 일정'}]
    .concat(state.savedLinks.map(l=>({kind:'friend', name:recvOwnerName(l), token:l.token})));
}
/* Enough range to fill both widgets: the month grid (this month) and the week list
   (this week), with slack so neither runs dry near a month boundary. */
function widgetRange(){
  const t=new Date();
  const mStart=new Date(t.getFullYear(),t.getMonth(),1);
  const mEnd=new Date(t.getFullYear(),t.getMonth()+1,0);
  const wStart=addDays(t,-t.getDay());                 // this week's Sunday
  const wEnd=addDays(wStart,20);                       // this week + 2 spare weeks
  return [iso(mStart<wStart?mStart:wStart), iso(mEnd>wEnd?mEnd:wEnd)];
}
/* The widget can't join categories, so the colour is resolved here. Private events
   are dropped at the SOURCE when the toggle is off — they are never handed to the
   widget at all, rather than filtered on the other side. */
function buildWidgetPayload(){
  const cfg=state.widgetIOS;
  const targets=widgetTargets();
  const [from,to]=widgetRange();
  const events=[];
  const mine=expandRange(from,to);
  (cfg.includePrivate?mine:mine.filter(e=>!e.isPrivate)).forEach(e=>events.push({
    targetIndex:0, date:e.date, time:e.time||'', end:e.end||'',
    title:e.title||'', color:cat(e.catId).color, isPrivate:!!e.isPrivate,
  }));
  targets.forEach((t,i)=>{
    if(t.kind!=='friend') return;
    const snap=state.friendSnaps[t.token];             // public snapshot, already on-device
    if(!snap) return;
    (snap.events||[]).forEach(e=>{
      if(e.date<from||e.date>to) return;
      const c=(snap.cats||{})[e.catId];
      events.push({targetIndex:i, date:e.date, time:e.time||'', end:e.end||'',
        title:e.title||'', color:(c&&c.color)||'#64748B', isPrivate:false});
    });
  });
  events.sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:(a.time||'99')<(b.time||'99')?-1:1);
  return {
    version:2, savedAt:Date.now(), weekStart:WIDGET_WEEK_START,
    includePrivate:!!cfg.includePrivate,
    selectedIndex:Math.max(0,Math.min(cfg.selectedIndex||0,targets.length-1)),
    targets, events,
  };
}
async function pushWidgetIOS(){
  const br=widgetBridge(); if(!br||!isIOS()) return null;
  const payload=buildWidgetPayload();
  try{
    await br.setItem({group:WIDGET_APP_GROUP, key:WIDGET_KEY_IOS, value:JSON.stringify(payload)});
    if(br.reloadAllTimelines) await br.reloadAllTimelines();
  }catch(e){}
  return payload;
}
/* every edit rewrites the snapshot; debounced so a drag doesn't write 30 times */
let widgetSnapT;
function scheduleWidgetSnapshot(){
  if(!isIOS()) return;
  clearTimeout(widgetSnapT);
  widgetSnapT=setTimeout(pushWidgetIOS,400);
}
/* coming back to the foreground: the day may have rolled over, so rewrite */
if(isIOS()){
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) pushWidgetIOS(); });
  window.addEventListener('pageshow',()=>pushWidgetIOS());
}

/* ---------- iOS widget sheet: pick the target + opt private events in ---------- */
function ensureWidgetIOSSheet(){
  if(document.getElementById('widgetIosScrim')) return;
  const scrim=document.createElement('div');
  scrim.className='scrim'; scrim.id='widgetIosScrim';
  scrim.innerHTML=`
    <div class="sheet" role="dialog" aria-modal="true" style="max-width:460px">
      <h2>홈 위젯</h2>
      <p class="sub">홈 화면 위젯(이번 달 · 이번 주)에 보여줄 캘린더를 고르세요. 위젯은 <b>이 기기 안에서만</b> 읽어요 — 서버로 보내지 않아요.</p>
      <div id="widgetIosList"></div>
      <div class="wrow" style="margin-top:10px">
        <div class="switch" id="widgetPrivSwitch" role="switch" aria-checked="false"></div>
        <div class="wrow-main"><span class="wrow-name">비공개 일정 포함</span></div>
      </div>
      <p class="sub" id="widgetPrivWarn" style="display:none">위젯·잠금화면에 비공개 일정의 <b>제목이 그대로 표시</b>돼요.</p>
      <div class="sheet-actions">
        <button class="btn ghost" id="widgetIosCancel">닫기</button>
        <button class="btn solid" id="widgetIosSave" style="flex:1">위젯에 적용</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.onclick=ev=>{ if(ev.target===scrim) closeScrim('#widgetIosScrim'); };
  $('#widgetIosCancel').onclick=()=>closeScrim('#widgetIosScrim');
  $('#widgetIosSave').onclick=saveWidgetIOSChoice;
}
function renderWidgetIOSSheet(){
  const targets=widgetTargets();
  const cfg=state.widgetIOS;
  const sel=Math.max(0,Math.min(cfg.selectedIndex||0,targets.length-1));
  $('#widgetIosList').innerHTML=targets.map((t,i)=>`
    <div class="wrow" data-i="${i}">
      <div class="switch${i===sel?' on':''}" data-pick role="radio" aria-checked="${i===sel}"></div>
      <div class="wrow-main"><span class="wrow-name">${esc(t.name)}</span><span class="wrow-kind">${t.kind==='mine'?'내 캘린더':'친구'}</span></div>
    </div>`).join('');
  $('#widgetIosList').querySelectorAll('.wrow').forEach(row=>{
    row.querySelector('[data-pick]').onclick=()=>{        // radio: exactly one target
      $('#widgetIosList').querySelectorAll('[data-pick]').forEach(s=>{ s.classList.remove('on'); s.setAttribute('aria-checked','false'); });
      const s=row.querySelector('[data-pick]'); s.classList.add('on'); s.setAttribute('aria-checked','true');
    };
  });
  const priv=$('#widgetPrivSwitch');
  priv.classList.toggle('on',!!cfg.includePrivate);
  priv.setAttribute('aria-checked',String(!!cfg.includePrivate));
  $('#widgetPrivWarn').style.display=cfg.includePrivate?'':'none';
  priv.onclick=function(){
    const on=!this.classList.contains('on');
    this.classList.toggle('on',on); this.setAttribute('aria-checked',String(on));
    $('#widgetPrivWarn').style.display=on?'':'none';
  };
}
function openWidgetIOS(){ ensureWidgetIOSSheet(); renderWidgetIOSSheet(); openScrim('#widgetIosScrim'); }
async function saveWidgetIOSChoice(){
  const rows=[...document.querySelectorAll('#widgetIosList .wrow')];
  const picked=rows.findIndex(r=>r.querySelector('[data-pick]').classList.contains('on'));
  state.widgetIOS={
    selectedIndex:picked<0?0:picked,
    includePrivate:$('#widgetPrivSwitch').classList.contains('on'),
  };
  saveWidgetIOS();
  await pushWidgetIOS();
  closeScrim('#widgetIosScrim');
  toast('위젯에 적용했어요');
}

/* ---------- holidays (server-cached, then cached on-device so they show offline) ---------- */
const HOLIDAYS={};
const holidayYears=new Set();        // attempted (cache read and, when online, a fetch)
const holidayConfirmed=new Set();    // the server answered → no need to ask again
function applyHolidays(list){
  let added=false;
  list.forEach(h=>{ if(h.isHoliday!==false && HOLIDAYS[h.date]!==h.name){ HOLIDAYS[h.date]=h.name; added=true; } });
  if(added) renderMonth();     // only repaints when something is new → renderMonth can't recurse
}
async function ensureHolidays(year){
  if(holidayYears.has(year)) return;
  holidayYears.add(year);      // set before any await → concurrent renders don't double-fetch
  const cached=await idbGet('holidays:'+year);
  if(Array.isArray(cached)) applyHolidays(cached);
  if(!isOnline()) return;      // offline → the cached year (if any) is all we can show
  try{
    const res=await fetch(api('/api/holidays?year='+year));
    if(!res.ok) return;
    const data=await res.json();
    if(!data||!Array.isArray(data.holidays)) return;
    idbSet('holidays:'+year, data.holidays);
    holidayConfirmed.add(year);
    applyHolidays(data.holidays);
  }catch(e){}
}
/* back online: re-arm the years we only ever answered from cache (or not at all) */
function retryHolidays(){
  [...holidayYears].forEach(y=>{ if(!holidayConfirmed.has(y)) holidayYears.delete(y); });
  ensureHolidays(state.view.getFullYear());
}

/* ---------- boot ---------- */
async function loadState(){
  const [ev,cats,links,seen,saved,widget,snaps,widgetIOS]=await Promise.all([
    idbGet('events'),idbGet('categories'),idbGet('shareLinks'),idbGet('cmtSeenAt'),idbGet('savedLinks'),idbGet('widgetConfig'),idbGet('friendSnaps'),idbGet('widgetIOS')
  ]);
  if(widgetIOS&&typeof widgetIOS==='object') state.widgetIOS={selectedIndex:widgetIOS.selectedIndex|0, includePrivate:!!widgetIOS.includePrivate};
  if(Array.isArray(cats)&&cats.length) state.categories=cats;
  if(Array.isArray(ev)) state.events=ev;          // stored (even empty) → respect it
                                                  // first run → start with an empty calendar
  if(Array.isArray(links)) state.shareLinks=links;
  if(typeof seen==='number') state.cmtSeenAt=seen;
  if(Array.isArray(saved)) state.savedLinks=saved;
  if(widget&&Array.isArray(widget.tokens)) state.widgetConfig=widget;
  if(snaps&&typeof snaps==='object') state.friendSnaps=snaps;
}
/* Everything above renders from IndexedDB, so the calendar is complete with no
   network. Coming back online we re-sync the server-owned parts: push my public
   snapshot to live links, re-fetch friends (latest wins), retry holidays. */
window.addEventListener('online',()=>{
  toast('다시 연결됐어요');
  syncAllLive();
  retryHolidays();
  if(overlayOn()) refreshOverlays();
});
window.addEventListener('offline',()=>toast('오프라인이에요. 내 일정은 그대로 볼 수 있어요'));
function hideBootLoading(){
  const bl=document.getElementById('bootLoading'); if(!bl) return;
  bl.classList.add('off'); setTimeout(()=>{ if(bl.parentNode) bl.remove(); },320);
}
async function initApp(){
  try{ await loadState(); }catch(e){ console.warn('[shareday] load failed',e); }
  ensureMenu();                                   // header menu (다크모드·카테고리·공유 링크·친구 캘린더)
  renderDow(); applyTheme(); renderTimeline();    // first full render is done here
  hideBootLoading();                              // reveal only once the calendar is painted
  if(overlayOn()) refreshOverlays();              // restore any friends' overlays from last time
  pushWidgetIOS();                                // cold start: refresh the widget snapshot (iOS only)
}
initApp();
