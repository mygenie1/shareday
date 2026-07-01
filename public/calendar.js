/* ============================================================
   STATE  —  in prototype this lives in memory.
   In production: categories + events → IndexedDB (device only).
   Only events with isPrivate=false are ever uploaded, as a
   "public snapshot", to the server keyed by a share token.
   ============================================================ */
const state = {
  theme: (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark':'light',
  view: new Date(),
  categories: [
    {id:'c1', name:'업무',   emoji:'💼', color:'#FF8A5B'},
    {id:'c2', name:'약속',   emoji:'👥', color:'#3B82F6'},
    {id:'c3', name:'개인',   emoji:'❤️', color:'#EF6B7D'},
    {id:'c4', name:'마감',   emoji:'🚩', color:'#F59E0B'},
    {id:'c5', name:'이동',   emoji:'✈️', color:'#7C6BE8'},
    {id:'c0', name:'기타',   emoji:'📌', color:'#64748B', fixed:true},
  ],
  events: [],
  shareLinks: 1,              // number of active links (drives the warning)
  editingId:null,
  form:{catId:'c1',isPrivate:false},
  newCat:{emoji:'🏃', color:'#10B981'},
  selected:new Date(),        // date focused in the timeline
  tlMode:'day',               // 'day' | 'week'
  tlCollapsed:false,
};

const PALETTE = ['#10B981','#34D399','#3B82F6','#7C6BE8','#EF6B7D','#FF8A5B','#F59E0B','#EAB308','#14B8A6','#EC4899','#64748B','#0EA271'];
const EMOJIS = ['💼','👥','❤️','🚩','✈️','🏃','📚','🍽️','☕','🎬','🎧','🩺','💊','🛒','🎂','🐶','🌱','💰','🧘','🎨','⚽','🎓','🛠️','🔔','📞','🧳','🎉','🌙','☀️','🍷'];

/* seed a few events around today — only used on very first run (empty store) */
function seed(){
  const d=new Date(), y=d.getFullYear(), m=d.getMonth();
  const addMin=(t,min)=>{let[h,mm]=t.split(':').map(Number);mm+=min;h+=Math.floor(mm/60);mm%=60;h=Math.min(23,h);return String(h).padStart(2,'0')+':'+String(mm).padStart(2,'0');};
  const mk=(day,h,t,cat,priv,dur,memo)=>({id:'e'+Math.random().toString(36).slice(2,8),
    date:`${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`,time:h,end:addMin(h,dur||60),title:t,catId:cat,isPrivate:!!priv,memo:memo||''});
  const dim=new Date(y,m+1,0).getDate();       // days in this month
  const clamp=n=>Math.max(1,Math.min(dim,n));
  const dd=d.getDate();
  state.events.push(
    mk(dd,'14:00','팀 회의','c1',false,90,'2층 회의실 B. 지난주 회고 자료 챙기기.'),
    mk(dd,'19:00','스터디','c4',false,120,'3장 예제 풀어오기'),
    mk(clamp(dd+2),'07:00','러닝','c1',false,45),
    mk(clamp(dd+4),'12:30','점심 약속','c2',false,60,'서연이랑 을지로 냉면'),
    mk(clamp(dd+5),'15:00','병원 예약','c3',true,30,'보험 카드 지참'),
    mk(clamp(dd+9),'20:00','영화','c5',false,150),
  );
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

/* ---------- theme ---------- */
function applyTheme(){
  document.documentElement.setAttribute('data-theme',state.theme);
  $('#themeBtn').innerHTML = isDark()
    ? '<svg class="svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>'
    : '<svg class="svg" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  renderMonth(); renderLegend();
}
$('#themeBtn').onclick=()=>{state.theme=isDark()?'light':'dark';applyTheme();};

/* ---------- calendar ---------- */
const DOW=['일','월','화','수','목','금','토'];
function renderDow(){$('#dowRow').innerHTML=DOW.map((d,i)=>`<div class="dow${i===0?' sun':''}${i===6?' sat':''}">${d}</div>`).join('');}
let monthDragMoved=false, keepScroll=null;
function reRender(preserve){ if(preserve){const s=document.querySelector('#tlBody .tg-scroll'); keepScroll=s?{left:s.scrollLeft,top:s.scrollTop}:null;} renderMonth(); renderTimeline(); keepScroll=null; afterMutate(); }
function renderMonth(){
  const v=state.view, y=v.getFullYear(), m=v.getMonth();
  $('#monthLabel').textContent=`${y}년 ${m+1}월`;
  ensureHolidays(y);
  const first=new Date(y,m,1), start=new Date(first); start.setDate(1-first.getDay());
  const todayIso=iso(new Date());
  let html='';
  for(let i=0;i<42;i++){
    const d=new Date(start); d.setDate(start.getDate()+i);
    const di=iso(d), out=d.getMonth()!==m, sun=d.getDay()===0, sat=d.getDay()===6, hol=HOLIDAYS[di];
    const evs=state.events.filter(e=>e.date===di).sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    const shown=evs.slice(0,2), extra=evs.length-shown.length;
    const selIso=iso(state.selected);
    const chips=shown.map(e=>{const c=cat(e.catId);
      return `<div class="chip" data-eid="${e.id}" style="background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">
        <span class="em">${c.emoji}</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(e.title)}</span>
        ${e.isPrivate?'<svg class="svg lk" viewBox="0 0 24 24" style="width:10px;height:10px;stroke-width:2.4"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>':''}</div>`;
    }).join('');
    html+=`<div class="cell${out?' out':''}${di===todayIso?' today':''}${sun?' sun':''}${sat?' sat':''}${hol?' holiday':''}${di===selIso?' sel':''}" data-date="${di}" ${hol?`title="${esc(hol)}"`:''}>
      <div class="dn">${d.getDate()}</div>
      ${hol?`<div class="hol-name">${esc(hol)}</div>`:''}
      <div class="chips">${chips}${extra>0?`<div class="more">+${extra}</div>`:''}</div></div>`;
  }
  $('#daysGrid').innerHTML=html;
  $$('#daysGrid .cell').forEach(c=>c.onclick=(ev)=>{
    if(monthDragMoved) return;                          // just finished a drag → ignore the click
    const chip=ev.target.closest('.chip');
    if(chip){openEvent(chip.dataset.eid);return;}      // tap an event → edit it
    state.selected=new Date(c.dataset.date+'T00:00:00');// tap a day → focus timeline
    $$('#daysGrid .cell').forEach(x=>x.classList.remove('sel'));
    c.classList.add('sel');
    renderTimeline();
  });
  attachMonthDrag();
}
/* month: drag a chip to another day → change its date (time unchanged) */
function attachMonthDrag(){
  $$('#daysGrid .chip[data-eid]').forEach(chip=>{
    chip.addEventListener('pointerdown',ev=>{
      if(ev.button!==undefined && ev.button!==0) return;
      const e=state.events.find(x=>x.id===chip.dataset.eid); if(!e) return;
      const startX=ev.clientX, startY=ev.clientY;
      let dragging=false, clone=null, lastCell=null;
      try{chip.setPointerCapture(ev.pointerId);}catch(_){}
      function mv2(mv){
        const dx=mv.clientX-startX, dy=mv.clientY-startY;
        if(!dragging && (Math.abs(dx)>5||Math.abs(dy)>5)){
          dragging=true; monthDragMoved=true;
          const r=chip.getBoundingClientRect();
          clone=chip.cloneNode(true);
          Object.assign(clone.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:Math.max(r.width,72)+'px',margin:'0',zIndex:'999',pointerEvents:'none',opacity:'.95',boxShadow:'0 10px 22px rgba(0,0,0,.28)',transform:'scale(1.06)'});
          document.body.appendChild(clone); chip.style.opacity='.3';
        }
        if(dragging){
          clone.style.left=(mv.clientX-22)+'px'; clone.style.top=(mv.clientY-12)+'px';
          const el=document.elementFromPoint(mv.clientX,mv.clientY);
          const cell=el&&el.closest?el.closest('#daysGrid .cell'):null;
          if(cell!==lastCell){ if(lastCell) lastCell.style.boxShadow=''; lastCell=cell;
            if(cell&&cell.dataset.date!==e.date) cell.style.boxShadow='inset 0 0 0 2px var(--accent)'; }
        }
      }
      function up2(mv){
        document.removeEventListener('pointermove',mv2);
        chip.style.opacity=''; if(lastCell) lastCell.style.boxShadow=''; if(clone) clone.remove();
        if(dragging){
          const el=document.elementFromPoint(mv.clientX,mv.clientY);
          const cell=el&&el.closest?el.closest('#daysGrid .cell'):null;
          if(cell&&cell.dataset.date&&cell.dataset.date!==e.date){ e.date=cell.dataset.date; renderMonth(); renderTimeline(); afterMutate(); toast('날짜를 옮겼어요'); }
          setTimeout(()=>{monthDragMoved=false;},0);
        }
      }
      document.addEventListener('pointermove',mv2);
      document.addEventListener('pointerup',up2,{once:true});
      ev.stopPropagation();
    });
  });
}
function renderLegend(){
  $('#legend').innerHTML='<span class="lbl">카테고리</span>'+state.categories.map(c=>
    `<span class="tag" style="background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">
      <span class="em">${c.emoji}</span>${esc(c.name)}</span>`).join('')
    +`<button class="gear" id="legendGear"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" stroke-linecap="round" stroke-linejoin="round"/></svg>편집</button>`;
  $('#legendGear').onclick=openSettings;
}
function esc(s){return (s||'').replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));}

$('#prevM').onclick=()=>{state.view.setMonth(state.view.getMonth()-1);renderMonth();};
$('#nextM').onclick=()=>{state.view.setMonth(state.view.getMonth()+1);renderMonth();};
$('#todayBtn').onclick=()=>{state.view=new Date();renderMonth();};

/* ---------- event modal ---------- */
function openEvent(id,presetDate){
  state.editingId=id;
  const e=id?state.events.find(x=>x.id===id):null;
  $('#evTitle').textContent=e?'일정 편집':'일정 추가';
  $('#fTitle').value=e?e.title:'';
  $('#fDate').value=e?e.date:(presetDate||iso(new Date()));
  $('#fTime').value=e?e.time:'';
  $('#fEnd').value=e?(e.end||''):'';
  $('#fMemo').value=e?(e.memo||''):'';
  state.form.endTouched=!!(e&&e.end);
  state.form.catId=e?e.catId:state.categories[0].id;
  state.form.isPrivate=e?!!e.isPrivate:false;
  const sw=$('#privSwitch');
  sw.classList.toggle('on',state.form.isPrivate);
  sw.setAttribute('aria-checked',state.form.isPrivate);
  $('#evDelete').style.display=e?'block':'none';
  renderCatPick();
  openScrim('#evScrim'); setTimeout(()=>$('#fTitle').focus(),120);
}
function renderCatPick(){
  const sel=state.form.catId;
  $('#catPick').innerHTML=state.categories.map(c=>
    `<button class="catopt${c.id===sel?' sel':''}" data-cid="${c.id}"
      style="background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">
      <span>${c.emoji}</span>${esc(c.name)}</button>`).join('')
    +`<button class="catopt add" id="addCat">＋ 새로</button>`;
  $$('#catPick .catopt[data-cid]').forEach(b=>b.onclick=()=>{state.form.catId=b.dataset.cid;renderCatPick();});
  $('#addCat').onclick=()=>openCatBuilder();
}
$('#privSwitch').onclick=function(){
  state.form.isPrivate=!state.form.isPrivate;
  this.classList.toggle('on',state.form.isPrivate);
  this.setAttribute('aria-checked',state.form.isPrivate);
};
function addMinT(t,min){let[h,m]=t.split(':').map(Number);let tot=h*60+m+min;tot=Math.max(0,Math.min(24*60-1,tot));return String(Math.floor(tot/60)).padStart(2,'0')+':'+String(tot%60).padStart(2,'0');}
$('#fTime').oninput=function(){
  if(this.value && !state.form.endTouched){ $('#fEnd').value=addMinT(this.value,60); }
};
$('#fEnd').oninput=function(){ state.form.endTouched=true; };
$('#evSave').onclick=()=>{
  const title=$('#fTitle').value.trim()||'제목 없음';
  const date=$('#fDate').value||iso(new Date());
  const time=$('#fTime').value;
  let end=$('#fEnd').value;
  if(time && !end) end=addMinT(time,60);
  if(time && end && end<=time) end=addMinT(time,60);   // guard: end after start
  const patch={title,date,time,end:time?end:'',memo:$('#fMemo').value.trim(),catId:state.form.catId,isPrivate:state.form.isPrivate};
  if(state.editingId){
    Object.assign(state.events.find(x=>x.id===state.editingId),patch);
  }else{
    state.events.push({id:'e'+Math.random().toString(36).slice(2,8),...patch});
  }
  closeScrim('#evScrim');reRender(true);toast('저장했어요');
};
$('#evDelete').onclick=async()=>{
  const e=state.events.find(x=>x.id===state.editingId);
  const nm=e?e.title:'이 일정';
  const ok=await showConfirm({title:'일정 삭제', msg:`'${nm}' 일정을 삭제할까요?`, okLabel:'삭제'});
  if(!ok) return;
  state.events=state.events.filter(x=>x.id!==state.editingId);
  closeScrim('#evScrim');reRender(true);toast('삭제했어요');
};
$('#evCancel').onclick=()=>closeScrim('#evScrim');
$('#fab').onclick=()=>openEvent(null, iso(state.selected));

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
      <div class="tl-nm" style="color:${inkOn(c.color,isDark())}"><span class="em">${c.emoji}</span>${esc(e.title)}
        ${e.isPrivate?'<svg class="svg lk" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>':''}</div>
      <div class="tl-cat">${esc(c.name)}</div>
      ${memo}
    </div></div>`;
}
function renderTimeline(){
  const today=iso(new Date());
  const tl=$('#tlCard'); tl.classList.toggle('collapsed',state.tlCollapsed);
  $('#tlToggle').setAttribute('aria-label',state.tlCollapsed?'타임라인 펼치기':'타임라인 접기');
  $$('#tlSeg button').forEach(b=>b.classList.toggle('on',b.dataset.m===state.tlMode));
  const byT=(a,b)=>(a.time||'99').localeCompare(b.time||'99');

  if(state.tlMode==='day'){
    const di=iso(state.selected);
    $('#tlTitle').textContent=dayLabel(state.selected,today);
    const evs=state.events.filter(e=>e.date===di).sort(byT);
    $('#tlBody').innerHTML=evs.length
      ? evs.map(rowHtml).join('')
      : `<div class="tl-empty">이 날은 일정이 없어요. ＋로 추가할 수 있어요.</div>`;
  }else{
    const [s,e0]=weekRange(state.selected);
    $('#tlTitle').textContent=`${s.getMonth()+1}.${s.getDate()} – ${e0.getMonth()+1}.${e0.getDate()} 주간`;
    const selIso=iso(state.selected);
    const WD=['일','월','화','수','목','금','토'];
    const days=[]; for(let i=0;i<7;i++){const d=new Date(s);d.setDate(s.getDate()+i);days.push(d);}

    // decide the visible hour window from actual events (fallback 8–20)
    const timed=state.events.filter(e=>{const di=e.date;return e.time && days.some(d=>iso(d)===di);});
    let minH=8,maxH=20;
    timed.forEach(e=>{const sh=+e.time.split(':')[0];
      const eh=e.end?Math.ceil(timeToMin(e.end)/60):sh+1;
      if(sh<minH)minH=sh; if(eh>maxH)maxH=eh;});
    minH=Math.max(0,minH-1); maxH=Math.min(24,maxH+1);
    const HOURS=maxH-minH, PXH=40;                 // px per hour

    // header row: weekday + date
    let head=`<div class="tg-corner"></div>`;
    days.forEach(d=>{const di=iso(d),isT=di===today,isS=di===selIso,sun=d.getDay()===0,sat=d.getDay()===6;
      head+=`<div class="tg-dh${isT?' today':''}${isS?' sel':''}${sun?' sun':''}${sat?' sat':''}" data-date="${di}">
        <span class="tg-dow">${WD[d.getDay()]}</span><span class="tg-dn">${d.getDate()}</span></div>`;});

    // all-day / untimed strip
    const untimedByDay=days.map(d=>state.events.filter(e=>e.date===iso(d)&&!e.time).sort((a,b)=>0));
    const hasUntimed=untimedByDay.some(a=>a.length);
    let allday='';
    if(hasUntimed){
      allday=`<div class="tg-adlabel">종일</div>`+days.map((d,i)=>{
        const evs=untimedByDay[i];
        return `<div class="tg-adcell" data-date="${iso(d)}">${evs.map(e=>{const c=cat(e.catId);
          return `<div class="tg-chip" data-eid="${e.id}" style="background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">${c.emoji} ${esc(e.title)}</div>`;}).join('')}</div>`;
      }).join('');
    }

    // hour gutter + grid lines
    let gutter='';
    for(let h=minH;h<maxH;h++) gutter+=`<div class="tg-hr" style="height:${PXH}px"><span>${String(h).padStart(2,'0')}</span></div>`;

    // day columns with positioned blocks (overlap-aware)
    let colsHtml='';
    days.forEach(d=>{
      const di=iso(d);
      const evs=state.events.filter(e=>e.date===di&&e.time).sort(byT);
      // lane packing by real start/end
      const laid=evs.map(e=>{const sh=timeToMin(e.time); const eh=e.end?timeToMin(e.end):sh+60; return {e,start:sh,end:Math.max(eh,sh+15)};});
      laid.forEach((it,idx)=>{
        it.lane=0;
        for(let l=0;;l++){ if(!laid.some((o,j)=>j<idx&&o.lane===l&&o.end>it.start&&o.start<it.end)){it.lane=l;break;} }
      });
      laid.forEach(it=>{const maxLane=Math.max(...laid.filter(o=>o.end>it.start&&o.start<it.end).map(o=>o.lane))+1; it.lanes=maxLane;});
      const blocks=laid.map(it=>{const e=it.e,c=cat(e.catId);
        const top=(it.start-minH*60)/60*PXH, h=Math.max(20,(it.end-it.start)/60*PXH), w=100/it.lanes, left=it.lane*w;
        const showEnd=h>=34;
        return `<div class="tg-block" data-eid="${e.id}" data-date="${di}" tabindex="0"
          style="top:${top}px;height:${h}px;left:${left}%;width:calc(${w}% - 3px);
          background:${tint(c.color,isDark())};border-left:3px solid ${c.color};color:${inkOn(c.color,isDark())}">
          <span class="tg-grip tg-grip-top" data-grip="top"></span>
          <span class="tg-bt">${e.time}${showEnd&&e.end?'–'+e.end:''}</span>
          <span class="tg-bn">${c.emoji} ${esc(e.title)}${e.memo?' <svg class="svg" viewBox="0 0 24 24" style="width:9px;height:9px;stroke-width:2.2;display:inline;vertical-align:baseline"><path d="M4 6h16M4 12h16M4 18h10"/></svg>':''}${e.isPrivate?' <svg class="svg lk" viewBox="0 0 24 24" style="width:9px;height:9px;stroke-width:2.4"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>':''}</span>
          <span class="tg-grip tg-grip-bot" data-grip="bot"></span>
        </div>`;}).join('');
      let lines=''; for(let hh=minH;hh<maxH;hh++) lines+=`<div class="tg-line" style="top:${(hh-minH)*PXH}px"></div>`;
      colsHtml+=`<div class="tg-col${di===selIso?' sel':''}" data-date="${di}" data-minh="${minH}" style="height:${HOURS*PXH}px">${lines}${blocks}</div>`;
    });

    $('#tlBody').innerHTML=`
      <div class="tg" style="--pxh:${PXH}px">
        <div class="tg-head">${head}</div>
        ${hasUntimed?`<div class="tg-allday">${allday}</div>`:''}
        <div class="tg-scroll"><div class="tg-body">
          <div class="tg-gutter">${gutter}</div>
          <div class="tg-cols">${colsHtml}</div>
        </div></div>
      </div>`;
    // scroll so the earliest event of the week is near the top
    const firstMin = timed.length ? Math.min(...timed.map(e=>timeToMin(e.time))) : minH*60;
    const sc=$('#tlBody').querySelector('.tg-scroll');
    if(sc){
      if(keepScroll){ sc.scrollLeft=keepScroll.left; sc.scrollTop=keepScroll.top; }
      else {
        sc.scrollTop=Math.max(0,((firstMin-minH*60)/60*PXH)-14);
        const selCol=sc.querySelector('.tg-col.sel');
        if(selCol){ const cr=selCol.getBoundingClientRect(), sr=sc.getBoundingClientRect();
          sc.scrollLeft += (cr.left - sr.left) - (sr.width - cr.width)/2; }
      }
    }
    // wire drag + resize on blocks
    $$('#tlBody .tg-block[data-eid]').forEach(bl=>attachBlockInteract(bl,PXH,minH));
  }
  $$('#tlBody .tl-row[data-eid], #tlBody .tg-chip[data-eid]').forEach(r=>r.onclick=(ev)=>{ev.stopPropagation();openEvent(r.dataset.eid);});
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
    const e=state.events.find(x=>x.id===bl.dataset.eid); if(!e) return;
    const cols=[...$$('#tlBody .tg-col')];
    const colW=cols[0].getBoundingClientRect().width;
    const startX=ev.clientX, startY=ev.clientY;
    const origStart=timeToMin(e.time), origEnd=e.end?timeToMin(e.end):origStart+60;
    let moved=false, curDate=e.date;
    try{bl.setPointerCapture(ev.pointerId);}catch(_){}
    bl.classList.add('dragging');
    const sc=document.querySelector('#tlBody .tg-scroll');
    let edgeDir=0, edgeRAF=0, lastEv=ev;
    function edgeLoop(){ if(!edgeDir||!sc){edgeRAF=0;return;} sc.scrollLeft+=edgeDir*12; applyMove(lastEv); edgeRAF=requestAnimationFrame(edgeLoop); }

    function move(mv){ lastEv=mv; applyMove(mv); }
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
    function up(uv){
      document.removeEventListener('pointermove',move);
      edgeDir=0; if(edgeRAF) cancelAnimationFrame(edgeRAF);
      bl.classList.remove('dragging');
      if(!moved){ openEvent(e.id); }        // treat as click → edit
      else { reRender(true); toast(mode==='move'?'일정을 옮겼어요':'시간을 바꿨어요'); }
    }
    document.addEventListener('pointermove',move);
    document.addEventListener('pointerup',up,{once:true});
    ev.preventDefault();
  });
}
$$('#tlSeg button').forEach(b=>b.onclick=()=>{state.tlMode=b.dataset.m;renderTimeline();});
$('#tlToggle').onclick=()=>{state.tlCollapsed=!state.tlCollapsed;renderTimeline();};
$('#tlTitle').style.cursor='default';

/* ---------- category builder ---------- */
function openCatBuilder(editId, fromSettings){
  const e = editId ? state.categories.find(c=>c.id===editId) : null;
  state.editingCatId = editId||null;
  state.catReturnSettings = !!fromSettings;
  state.newCat = e ? {emoji:e.emoji,color:e.color} : {emoji:'🏃',color:'#10B981'};
  $('#catBuilderTitle').textContent = e ? '카테고리 수정' : '새 카테고리';
  $('#cSave').textContent = e ? '저장' : '만들기';
  $('#cName').value = e ? e.name : '';
  $('#emGrid').innerHTML=EMOJIS.map(em=>`<div class="emo${em===state.newCat.emoji?' sel':''}" data-e="${em}">${em}</div>`).join('');
  $('#palette').innerHTML=PALETTE.map(c=>`<div class="sw${c===state.newCat.color?' sel':''}" data-c="${c}" style="background:${c}"></div>`).join('')
    +`<label class="sw hex" title="직접 지정">#<input type="color" id="hexIn" style="position:absolute;opacity:0;width:28px;height:28px;cursor:pointer"></label>`;
  $$('#emGrid .emo').forEach(x=>x.onclick=()=>{state.newCat.emoji=x.dataset.e;refreshCatBuilder();});
  $$('#palette .sw[data-c]').forEach(x=>x.onclick=()=>{state.newCat.color=x.dataset.c;refreshCatBuilder();});
  $('#hexIn').oninput=ev=>{state.newCat.color=ev.target.value;refreshCatBuilder();};
  checkDupe();
  openScrim('#catScrim'); setTimeout(()=>$('#cName').focus(),120);
}
function refreshCatBuilder(){
  $$('#emGrid .emo').forEach(x=>x.classList.toggle('sel',x.dataset.e===state.newCat.emoji));
  $$('#palette .sw[data-c]').forEach(x=>x.classList.toggle('sel',x.dataset.c===state.newCat.color));
  checkDupe();
}
$('#cName').oninput=checkDupe;
function checkDupe(){
  const dup=state.categories.find(c=>c.id!==state.editingCatId && c.emoji===state.newCat.emoji && c.color.toLowerCase()===state.newCat.color.toLowerCase());
  const el=$('#dupeMsg');
  if(dup){el.textContent=`'${dup.name}'와 같은 색·이모지예요. 그대로 둬도 되지만 헷갈릴 수 있어요.`;el.classList.add('on');}
  else el.classList.remove('on');
}
$('#cSave').onclick=()=>{
  const name=$('#cName').value.trim()||'새 카테고리';
  if(state.editingCatId){
    Object.assign(state.categories.find(c=>c.id===state.editingCatId),{name,emoji:state.newCat.emoji,color:state.newCat.color});
    toast('카테고리를 수정했어요');
  }else{
    const id='c'+Math.random().toString(36).slice(2,7);
    state.categories.push({id,name,emoji:state.newCat.emoji,color:state.newCat.color});
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
      <span class="cat-swatch" style="background:${tint(c.color,isDark())};color:${inkOn(c.color,isDark())}">${c.emoji}</span>
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
  state.events.forEach(e=>{ if(e.catId===id) e.catId=other.id; });
  state.categories=state.categories.filter(x=>x.id!==id);
  if(state.form.catId===id) state.form.catId=other.id;
  renderCatList();renderLegend();renderCatPick();renderMonth();renderTimeline();afterMutate();
  toast(used?`'${c.name}' 삭제 · 일정 ${used}개는 '기타'로 옮겼어요`:`'${c.name}'를 삭제했어요`);
}
$('#settingsBtn').onclick=openSettings;
$('#setAddCat').onclick=()=>{closeScrim('#setScrim');openCatBuilder(null,true);};
$('#setDone').onclick=()=>closeScrim('#setScrim');

/* ---------- share sheet with two zones + global sync ---------- */
let shareExp=30, shareCmt=true;
function openShare(){renderZones();renderWarn();openScrim('#shScrim');ensureShareLink();}
function renderWarn(){
  $('#warnBox').innerHTML = state.share.token
    ? `<div class="warn"><svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/></svg>
        프라이빗으로 내리면 공유 중인 이 링크에서도 함께 숨겨져요.</div>` : '';
}
function fmtWhen(e){
  const [y,m,d]=e.date.split('-').map(Number);
  const dt=new Date(y,m-1,d);
  const wd=['일','월','화','수','목','금','토'][dt.getDay()];
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
    <span class="em">${c.emoji}</span>
    <span class="nm" style="${col}">${esc(e.title)}<span class="when" style="color:${e.isPrivate?'var(--ink-faint)':inkOn(c.color,isDark())};opacity:.72">${fmtWhen(e)}</span></span>${dir}</div>`;
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
$('#shareBtn').onclick=openShare;
$('#shDone').onclick=()=>closeScrim('#shScrim');
$('#copyBtn').onclick=()=>{const url=state.share.url||$('#linkText').textContent;navigator.clipboard&&navigator.clipboard.writeText(url);toast('링크를 복사했어요');};
$('#revokeBtn').onclick=async()=>{ const ok=await showConfirm({title:'링크 폐기', msg:'폐기하면 받은 사람이 더 이상 이 링크를 열 수 없어요. 폐기할까요?', okLabel:'폐기'}); if(!ok) return; await revokeShareLink(); closeScrim('#shScrim');toast('링크를 폐기했어요');};
$('#previewBtn').onclick=async()=>{ await ensureShareLink(); if(state.share.url) window.open(state.share.url,'_blank','noopener'); else toast('먼저 공유 링크를 만들어 주세요'); };
$$('#expSeg button').forEach(b=>b.onclick=()=>{$$('#expSeg button').forEach(x=>x.classList.remove('on'));b.classList.add('on');shareExp=+b.dataset.d;syncShareIfLive();});
$('#cmtSwitch').onclick=function(){shareCmt=!shareCmt;this.classList.toggle('on',shareCmt);this.setAttribute('aria-checked',shareCmt);syncShareIfLive();};

/* ---------- scrim util ---------- */
function openScrim(s){$(s).classList.add('on');}
function closeScrim(s){$(s).classList.remove('on');}
$$('.scrim').forEach(sc=>sc.onclick=e=>{if(e.target===sc)sc.classList.remove('on');});
document.addEventListener('keydown',e=>{if(e.key==='Escape')$$('.scrim.on').forEach(s=>s.classList.remove('on'));});

/* ---------- toast ---------- */
let tT;
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('on');clearTimeout(tT);tT=setTimeout(()=>t.classList.remove('on'),1900);}

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
/* called after every change: save locally + push the public snapshot to a live link */
function afterMutate(){ persist(); syncShareIfLive(); }

/* ---------- share link (public snapshot only) ---------- */
state.share={token:null,url:null,syncing:false};
function publicPayload(){
  return {
    events: state.events.filter(e=>!e.isPrivate),   // client-side pre-filter; server re-filters too
    categories: state.categories,
    allowComments: shareCmt,
    expiresDays: shareExp,
  };
}
async function ensureShareLink(){
  if(state.share.token) return syncShareIfLive();
  if(state.share.syncing) return;
  state.share.syncing=true;
  $('#linkText').textContent='링크 만드는 중…';
  try{
    const res=await fetch('/api/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(publicPayload())});
    const data=await res.json();
    if(res.ok){ state.share.token=data.token; state.share.url=data.url; $('#linkText').textContent=data.url; }
    else { $('#linkText').textContent='링크 생성 실패'; toast('링크를 만들지 못했어요'); }
  }catch(e){ $('#linkText').textContent='링크 생성 실패'; toast('네트워크 오류예요'); }
  finally{ state.share.syncing=false; renderWarn(); }
}
/* serialize updates so rapid changes can't lose the latest snapshot */
let shareChain=Promise.resolve();
function syncShareIfLive(){
  if(!state.share.token) return Promise.resolve();
  shareChain=shareChain.then(async()=>{
    if(!state.share.token) return;
    try{
      const res=await fetch('/api/share/'+encodeURIComponent(state.share.token),
        {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(publicPayload())});
      if(res.ok){ const data=await res.json(); state.share.url=data.url; $('#linkText').textContent=data.url; }
    }catch(e){}
  });
  return shareChain;
}
async function revokeShareLink(){
  const tok=state.share.token; if(!tok) return;
  state.share.token=null; state.share.url=null;
  $('#linkText').textContent='shareday.app/s/…'; renderWarn();
  try{ await fetch('/api/share/'+encodeURIComponent(tok),{method:'DELETE'}); }catch(e){}
}

/* ---------- holidays (server-cached) ---------- */
const HOLIDAYS={};
const holidayYears=new Set();
function ensureHolidays(year){
  if(holidayYears.has(year)) return;
  holidayYears.add(year);
  fetch('/api/holidays?year='+year).then(r=>r.ok?r.json():null).then(data=>{
    if(!data||!Array.isArray(data.holidays)) return;
    let added=false;
    data.holidays.forEach(h=>{ if(h.isHoliday!==false){ HOLIDAYS[h.date]=h.name; added=true; } });
    if(added) renderMonth();   // guarded: year is already in the set so this won't recurse
  }).catch(()=>{});
}

/* ---------- boot ---------- */
async function loadState(){
  const [ev,cats]=await Promise.all([idbGet('events'),idbGet('categories')]);
  if(Array.isArray(cats)&&cats.length) state.categories=cats;
  if(Array.isArray(ev)) state.events=ev;          // stored (even empty) → respect it
  else { seed(); persist(); }                     // undefined → very first run, seed once
}
async function initApp(){
  try{ await loadState(); }catch(e){ console.warn('[shareday] load failed',e); }
  renderDow(); applyTheme(); renderTimeline();
}
initApp();
