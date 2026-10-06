if(typeof pdfjsLib!=='undefined')pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CONTENT_CHARS=100000;           // matches the CHECK constraint in supabase-setup.sql
const MAX_ATTACH_BYTES=3*1024*1024;       // matches api/summarize.js (Vercel request limit is 4.5 MB)
const POLL_MS=20000;

let S={view:'home',submissions:[],synthesis:null,selectedPillars:new Set(),isOwner:false,
  synthesizing:false,submitting:false,anonymous:true,attachedFiles:[],attachedText:'',displayName:'',
  isTest:false,showTests:false,showMine:false,synthIncludeTests:false,myId:null,openPillars:new Set(),openRaw:new Set(),
  loaded:false};
let sb=null,adminKey='';

// ---------- anonymous identity + admin key (browser storage, always wrapped) ----------
function loadMyId(){
  const KEY='prometheus-lab-uid';
  try{const v=localStorage.getItem(KEY);if(v&&v.length>=8)return v;}catch(e){}
  const id=(window.crypto&&crypto.randomUUID)?crypto.randomUUID():Array.from({length:32},()=>Math.floor(Math.random()*16).toString(16)).join('');
  try{localStorage.setItem(KEY,id);}catch(e){}
  return id;
}
function loadAdminKey(){try{return sessionStorage.getItem('prometheus-lab-admin')||'';}catch(e){return '';}}
function saveAdminKey(k){try{k?sessionStorage.setItem('prometheus-lab-admin',k):sessionStorage.removeItem('prometheus-lab-admin');}catch(e){}}

// ---------- data layer (Supabase) ----------
async function api(path,body,headers){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  let data={};try{data=await r.json();}catch(e){}
  if(r.status===401&&data.code==='crew_login'){location.reload();throw new Error('Session expired — please log in again.');}
  if(!r.ok){const err=new Error(data.error||('Request failed ('+r.status+')'));err.status=r.status;throw err;}
  return data;
}
function mapSubmission(r){return{id:r.id,pillars:r.pillars||[],summary:r.summary,autoTagged:r.auto_tagged,isTest:r.is_test,
  displayName:r.display_name,timestamp:r.timestamp,mine:r.mine,content:r.content};}
function mapSynthesis(r){return r?{commons:r.commons||[],contested:r.contested||[],gaps:r.gaps||[],
  timestamp:Date.parse(r.created_at),count:r.count,includedTests:r.included_tests}:null;}

async function refresh(){
  if(!sb)return;
  try{
    const [subs,syn]=await Promise.all([
      sb.rpc('list_submissions',{p_uid:S.myId}),
      sb.from('synthesis').select('*').eq('id',1).maybeSingle()]);
    if(subs.error)throw subs.error;if(syn.error)throw syn.error;
    const next=(subs.data||[]).map(mapSubmission),nextSyn=mapSynthesis(syn.data);
    const changed=!S.loaded||JSON.stringify(next)!==JSON.stringify(S.submissions)||JSON.stringify(nextSyn)!==JSON.stringify(S.synthesis);
    S.submissions=next;S.synthesis=nextSyn;
    const first=!S.loaded;S.loaded=true;
    // Don't re-render the form while someone is typing in it.
    if(changed&&(first||(S.view!=='submit'&&S.view!=='pillars')))render();
  }catch(e){console.error(e);if(!S.loaded){S.loaded=true;showToast('Could not load voices — check your Supabase setup');render();}}
}

function init(){
  S.myId=loadMyId();adminKey=loadAdminKey();S.isOwner=!!adminKey;
  const cfg=window.PROMETHEUS_LAB_CONFIG||{};
  if(cfg.SUPABASE_URL&&cfg.SUPABASE_ANON_KEY&&window.supabase){
    sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY,
      {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    refresh();
    setInterval(()=>{if(!document.hidden&&!S.submitting&&!S.synthesizing)refresh();},POLL_MS);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  }
  render();
}
function nav(v){S.view=v;render();window.scrollTo(0,0)}
function filteredSubs(){let s=S.submissions;if(!S.showTests)s=s.filter(x=>!x.isTest);if(S.showMine)s=s.filter(x=>x.mine);return s;}
function setupNeeded(m){m.innerHTML=`<div class="card"><h3>Setup needed</h3><p style="font-size:14px;color:var(--muted)">This app isn't connected to a database yet. Add your Supabase URL and anon key to <strong>public/config.js</strong>, then reload.</p></div>`;}

function render(){
  // Keep whatever is typed in the form across re-renders.
  const t=document.getElementById('voice-text');if(t)S.attachedText=t.value;
  const n=document.getElementById('display-name');if(n)S.displayName=n.value;
  document.getElementById('nav').innerHTML=[
    {id:'home',label:'Home',icon:'🔥'},{id:'pillars',label:'Pillars',icon:'📋'},
    {id:'submit',label:'Submit',icon:'✍️'},{id:'voices',label:'Voices',icon:'👁'},
    {id:'synthesis',label:'Synthesis',icon:'⚡'}
  ].map(t=>`<button class="${S.view===t.id?'active':''}" onclick="nav('${t.id}')">${t.icon} ${t.label}</button>`).join('');
  const m=document.getElementById('main');
  ({home:renderHome,submit:renderSubmit,pillars:renderPillars,voices:renderVoices,synthesis:renderSynthesis})[S.view]?.(m);
  if(S.view==='submit')setupDropZone();
}

function renderHome(m){
  const real=S.submissions.filter(s=>!s.isTest),c=real.length,p=new Set(real.flatMap(s=>s.pillars||[])).size;
  const my=real.filter(s=>s.mine).length;
  m.innerHTML=`<div style="text-align:center;padding-top:20px"><span class="hero-flame">🔥</span><h1>Prometheus Lab</h1><p class="subtitle">Burning Man AI Constitution — Collective Voice</p></div>
  <div class="card"><p style="font-size:15px;margin-bottom:12px">We're building a constitution that guides how humans and AI behave together — on playa and beyond.</p><p style="font-size:14px;color:var(--muted)">Write what you believe. Upload a doc. AI figures out which pillars your thoughts touch.</p></div>
  <div class="stat-row"><div class="stat"><div class="stat-num">${c}</div><div class="stat-label">voices heard</div></div><div class="stat"><div class="stat-num">${p}</div><div class="stat-label">of 12 pillars</div></div><div class="stat"><div class="stat-num">${my}</div><div class="stat-label">yours</div></div></div>
  <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><button class="btn btn-primary" onclick="nav('submit')">Add your voice</button><button class="btn btn-secondary" onclick="nav('pillars')">View pillars</button></div>`;
}

function renderPillars(m){
  const items=PILLARS.map(p=>{const open=S.openPillars.has(p.id);
    return`<div class="pillar-ref"><div class="pillar-ref-header" onclick="togglePillarRef(${p.id})">
      <span class="num">${p.id}</span><span class="emoji-lg">${p.emoji}</span><span class="title">${p.name}</span><span class="arrow ${open?'open':''}">▶</span></div>
      <div class="pillar-ref-body ${open?'open':''}"><ul>${p.bullets.map(b=>`<li>${b}</li>`).join('')}</ul>
      ${p.principle?`<div class="principle">Connects to: ${p.principle}</div>`:''}</div></div>`;}).join('');
  m.innerHTML=`<h2>The 12 Pillars</h2><p class="subtitle">Every topic the constitution could address. Tap to expand. Pick 1–3 when you submit.</p>
  <div style="margin-bottom:16px"><button class="btn-secondary btn" style="font-size:12px;padding:6px 14px" onclick="toggleAllPillars()">${S.openPillars.size===PILLARS.length?'Collapse all':'Expand all'}</button></div>${items}`;
}

function renderSubmit(m){
  if(!sb){setupNeeded(m);return;}
  const chips=PILLARS.map(p=>`<button class="pillar-chip ${S.selectedPillars.has(p.id)?'selected':''}" onclick="togglePillar(${p.id})"><span class="emoji">${p.emoji}</span>${p.name}</button>`).join('');
  const fc=S.attachedFiles.map((f,i)=>`<div class="file-preview"><span>${f.type==='image'?'🖼️':'📄'}</span><span class="name">${esc(f.name)}</span><span style="color:var(--muted);font-size:11px">${f.type==='image'?'image':((f.text.length/1000).toFixed(0)+'k chars')}</span><button class="remove" onclick="removeFile(${i})">✕</button></div>`).join('');
  m.innerHTML=`<h2>Share your voice</h2><p class="subtitle">Write, paste, or drop a file. Pick pillars if you know them — or skip and AI auto-detects.</p>
  <div class="drop-zone" id="drop-zone"><input type="file" accept=".txt,.docx,.md,.rtf,.pdf,.png,.jpg,.jpeg,image/*,application/pdf" multiple onchange="handleFiles(this.files);this.value=''"><span class="icon">📂</span><span class="label">Drop files here or <strong>browse</strong><br><span style="font-size:12px;color:var(--muted)">.txt, .docx, .pdf, .png, .jpg</span></span></div>${fc}
  <div class="or-divider">or write / paste below</div>
  <textarea id="voice-text" placeholder="What do you believe? What behaviors should the constitution enshrine? Paste from a doc, brain-dump, or write a sentence.">${esc(S.attachedText)}</textarea>
  <h3 style="margin-top:20px">Pillars <span style="font-weight:400;color:var(--muted);font-size:13px">(optional — AI auto-detects if you skip)</span></h3>
  <div class="pillar-grid">${chips}</div>
  <div class="form-row"><div class="toggle-row" onclick="toggleAnon()"><div class="toggle ${S.anonymous?'on':''}"></div><span>Anonymous</span></div>
  ${!S.anonymous?`<input type="text" id="display-name" maxlength="80" placeholder="Name or handle" value="${esc(S.displayName)}">`:''}</div>
  <div class="form-row"><div class="toggle-row" onclick="S.isTest=!S.isTest;render()"><div class="toggle toggle-sm ${S.isTest?'on':''}" style="${S.isTest?'background:var(--muted)':''}"></div><span>Test submission</span></div>
  ${S.isTest?'<span style="font-size:11px;color:var(--muted)">Excluded from synthesis by default</span>':''}</div>
  ${S.submitting?'<div class="loading"><div class="spinner"></div>Processing your voice...</div>'
  :`<button class="btn btn-primary" onclick="submitVoice()">Submit</button>`}`;
}

function renderVoices(m){
  if(!sb){setupNeeded(m);return;}
  const allReal=S.submissions.filter(s=>!s.isTest),allTest=S.submissions.filter(s=>s.isTest);
  const subs=filteredSubs(),myCount=allReal.filter(s=>s.mine).length;
  if(!S.submissions.length){m.innerHTML=`<h2>Voices</h2>
    <div class="preview-block"><div class="preview-title">📊 Pillar coverage chart</div><p>A bar chart showing how many submissions touch each pillar — where the energy flows and which areas need more voices.</p></div>
    <div class="preview-block"><div class="preview-title">📝 Summaries</div><p>Each voice appears as a card with its tagged pillars and an AI-generated summary of the contributor's position — not the raw text. Your own submissions show the full text to you only.</p></div>
    <div style="text-align:center;margin-top:20px"><button class="btn btn-primary" onclick="nav('submit')">Add the first voice</button></div>`;return;}
  const counts={};PILLARS.forEach(p=>counts[p.id]=0);
  subs.forEach(s=>(s.pillars||[]).forEach(pid=>counts[pid]=(counts[pid]||0)+1));
  const mx=Math.max(1,...Object.values(counts));
  const bars=PILLARS.map(p=>`<div class="bar-row"><div class="bar-label">${p.emoji} ${p.name}</div><div class="bar-track"><div class="bar-fill" style="width:${((counts[p.id]||0)/mx*100).toFixed(0)}%"></div></div><div class="bar-count">${counts[p.id]||0}</div></div>`).join('');
  const cards=subs.map(s=>{
    const pills=(s.pillars||[]).map(pid=>{const p=PILLARS.find(x=>x.id===pid);return p?`<span class="pill ${s.autoTagged?'auto':''}">${p.emoji} ${p.name}</span>`:''}).join('');
    const who=s.displayName||'Anonymous',when=s.timestamp?new Date(s.timestamp).toLocaleDateString():'';
    const isMine=s.mine;
    const displayText=s.summary||'Summary pending...';
    const rawId='raw-'+s.id;
    let rawBlock='';
    if(isMine){
      const c=s.content||'';
      const rawPreview=c.length>800?(c.slice(0,800)+'…'):c;
      rawBlock=`<button class="raw-toggle" onclick="toggleRaw('${rawId}')">Show your full submission</button><button class="raw-toggle" style="margin-left:16px;color:var(--muted)" onclick="setTestFlag('${s.id}',${!s.isTest})">${s.isTest?'Unmark test':'Mark as test'}</button><button class="raw-toggle" style="margin-left:16px;color:var(--muted)" onclick="deleteMine('${s.id}')">Delete</button><div class="raw-content${S.openRaw.has(rawId)?' show':''}" id="${rawId}">${esc(rawPreview)}</div>`;
    }
    return`<div class="submission-card${isMine?' mine':''}${s.isTest?' test-card':''}">
      <div class="submission-meta">${esc(who)} · ${when}${s.autoTagged?' · <span style="color:var(--commons)">auto-tagged</span>':''}${isMine?' · <span class="mine-badge">yours</span>':''}${s.isTest?' · <span class="test-badge">test</span>':''}</div>
      <div class="submission-pills">${pills}</div>
      <div class="submission-text"><span class="summary-text">${esc(displayText)}</span></div>${rawBlock}</div>`;
  }).join('');
  m.innerHTML=`<h2>All Voices <span style="color:var(--accent)">(${allReal.length}${allTest.length?' + '+allTest.length+' test':''})</span></h2>
  <div class="filter-bar">
    <div class="toggle-row" onclick="S.showTests=!S.showTests;render()"><div class="toggle toggle-sm ${S.showTests?'on':''}" style="${S.showTests?'background:var(--muted)':''}"></div><span>Show tests</span></div>
    <div class="toggle-row" onclick="S.showMine=!S.showMine;render()"><div class="toggle toggle-sm ${S.showMine?'on':''}"></div><span>Mine only (${myCount})</span></div>
  </div><div class="card">${bars}</div><h3 style="margin-bottom:16px">Submissions (${subs.length})</h3>${cards}`;
}

function renderSynthesis(m){
  if(!sb){setupNeeded(m);return;}
  const real=S.synthIncludeTests?S.submissions:S.submissions.filter(s=>!s.isTest);
  if(!S.submissions.length){m.innerHTML=`<h2>Synthesis</h2><p class="subtitle">Once voices come in, AI sorts everything into three categories.</p>
    <div class="preview-block" style="border-color:var(--commons)"><div class="preview-title"><span class="section-tag tag-commons" style="margin:0">The Commons</span></div><p>Topics where voices broadly agree. Easy wins — ratify quickly. Each shows the pillar, consensus summary, and strength.</p></div>
    <div class="preview-block" style="border-color:var(--contested)"><div class="preview-title"><span class="section-tag tag-contested" style="margin:0">Contested Ground</span></div><p>Topics where voices diverge. Your discussion agenda — the real debates. Each shows competing positions and the core tension.</p></div>
    <div class="preview-block" style="border-color:var(--gaps)"><div class="preview-title"><span class="section-tag tag-gaps" style="margin:0">The Gaps</span></div><p>Pillars nobody addressed. Blind spots to assign or discuss.</p></div>
    <div style="text-align:center;margin-top:16px"><button class="btn btn-primary" onclick="nav('submit')">Add the first voice</button></div>`;return;}
  let sb_='';
  if(S.synthesizing){
    sb_=`<div class="card"><div class="loading"><div class="spinner"></div>Reading all voices and finding patterns...</div></div>`;
  }else if(S.synthesis){
    const syn=S.synthesis,ts=syn.timestamp?new Date(syn.timestamp).toLocaleString():'';
    sb_=`<p style="font-size:12px;color:var(--muted);margin-bottom:16px">Last run: ${ts} · ${syn.count||'?'} voices · ${syn.includedTests?'tests included':'tests excluded'}</p>`;
    if(syn.commons?.length){sb_+=`<div class="card"><span class="section-tag tag-commons">The Commons — Where we agree</span>`;syn.commons.forEach(c=>{sb_+=`<div class="synthesis-item"><strong>${esc(c.pillar)}</strong> <span style="font-size:11px;color:var(--commons)">[${esc(c.strength||'')}]</span><br>${esc(c.summary)}</div>`;});sb_+=`</div>`;}
    if(syn.contested?.length){sb_+=`<div class="card"><span class="section-tag tag-contested">Contested Ground — Where we diverge</span>`;syn.contested.forEach(c=>{sb_+=`<div class="synthesis-item"><strong>${esc(c.pillar)}</strong><br>${(c.positions||[]).map((p,i)=>`<span style="color:var(--contested)">Position ${i+1}:</span> ${esc(p)}`).join('<br>')}<div class="tension">${esc(c.tension||'')}</div></div>`;});sb_+=`</div>`;}
    if(syn.gaps?.length){sb_+=`<div class="card"><span class="section-tag tag-gaps">The Gaps — What's missing</span>`;syn.gaps.forEach(g=>{sb_+=`<div class="synthesis-item"><strong>${esc(g.pillar)}</strong><br><span style="color:var(--gaps)">${esc(g.note)}</span></div>`;});sb_+=`</div>`;}
  }else{sb_=`<div class="preview-block"><span class="section-tag tag-commons" style="margin:0">The Commons</span><p style="margin-top:8px">Consensus positions appear here once synthesis runs.</p></div>
    <div class="preview-block"><span class="section-tag tag-contested" style="margin:0">Contested Ground</span><p style="margin-top:8px">Competing positions and tensions appear here.</p></div>
    <div class="preview-block"><span class="section-tag tag-gaps" style="margin:0">The Gaps</span><p style="margin-top:8px">Uncovered pillars appear here.</p></div>`;}
  const hasAny=S.submissions.length>0;
  const testCount=S.submissions.filter(s=>s.isTest).length;
  const showControls=S.isOwner&&!S.synthesizing&&hasAny;
  m.innerHTML=`<h2>Synthesis</h2><p class="subtitle">AI analysis of all voices.</p>${sb_}
  ${showControls?`<div style="margin-top:20px;text-align:center">
    ${testCount?`<div class="form-row" style="justify-content:center;margin-bottom:12px">
      <div class="toggle-row" onclick="S.synthIncludeTests=!S.synthIncludeTests;render()"><div class="toggle toggle-sm ${S.synthIncludeTests?'on':''}" style="${S.synthIncludeTests?'background:var(--muted)':''}"></div><span>Include test submissions (${testCount})</span></div>
    </div>`:''}
    ${real.length>0
      ?`<button class="btn btn-primary" onclick="runSynthesis()">Run synthesis on ${real.length} voices</button>
         <p style="font-size:12px;color:var(--muted);margin-top:6px">${S.synthIncludeTests?'Including test submissions':'Test submissions excluded'}</p>`
      :`<p style="font-size:13px;color:var(--muted)">All ${testCount} submissions are tests. Toggle "Include test submissions" above to analyze them.</p>`}
  </div>`:''}
  ${!S.isOwner&&!S.synthesis?'<p style="font-size:13px;color:var(--muted);text-align:center;margin-top:16px">Only the project lead can trigger synthesis.</p>':''}
  ${S.synthesizing?'':`<div style="text-align:center;margin-top:16px"><button class="raw-toggle" onclick="${S.isOwner?'lockAdmin()':'unlockAdmin()'}">${S.isOwner?'Lock project-lead controls':'Project lead? Unlock'}</button></div>`}`;
}

// ---------- project-lead unlock (the key is checked by the server on every synthesis run) ----------
function unlockAdmin(){const k=prompt('Project-lead key:');if(!k)return;adminKey=k.trim();saveAdminKey(adminKey);S.isOwner=true;render();}
function lockAdmin(){adminKey='';saveAdminKey('');S.isOwner=false;render();}

// ---------- files ----------
function setupDropZone(){const dz=document.getElementById('drop-zone');if(!dz)return;
  dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('dragover')});
  dz.addEventListener('dragleave',()=>dz.classList.remove('dragover'));
  dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('dragover');handleFiles(e.dataTransfer.files)});}

function blobToBase64(blob){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=rej;r.readAsDataURL(blob);});}
// Shrink photos before upload (phone photos are often 5+ MB; the API request limit is 4.5 MB).
async function imageToJpegBase64(file,maxDim=1600){
  const bmp=await createImageBitmap(file);
  const k=Math.min(1,maxDim/Math.max(bmp.width,bmp.height));
  const c=document.createElement('canvas');c.width=Math.round(bmp.width*k);c.height=Math.round(bmp.height*k);
  const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(bmp,0,0,c.width,c.height);
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.85));
  return blobToBase64(blob);
}
const b64Bytes=s=>s.length*3/4;
function attachedBytes(){return S.attachedFiles.reduce((n,f)=>n+(f.data?b64Bytes(f.data):0),0);}

async function handleFiles(files){for(const file of files){try{
  const isImg=file.type.startsWith('image/')||/\.(png|jpe?g|gif|webp)$/i.test(file.name);
  const isPdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name);
  if(isImg){
    let data;try{data=await imageToJpegBase64(file);}catch(e){showToast('Could not read '+file.name+' as an image');continue;}
    if(attachedBytes()+b64Bytes(data)>MAX_ATTACH_BYTES){showToast(file.name+' is too large to add. Try a smaller image.');continue;}
    S.attachedFiles.push({name:file.name,text:'[Image: '+file.name+']',type:'image',mediaType:'image/jpeg',data});
  }else if(isPdf){
    let text='';const buf=await file.arrayBuffer();
    try{const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0))}).promise;
      for(let i=1;i<=pdf.numPages;i++){const pg=await pdf.getPage(i);const tc=await pg.getTextContent();text+=tc.items.map(x=>x.str).join(' ')+'\n';}}catch(pe){console.error('PDF parse:',pe);}
    if(text.trim()){S.attachedFiles.push({name:file.name,text:text.trim(),type:'text'});}
    else{ // scanned PDF: let Claude read it directly
      const data=await blobToBase64(file);
      if(attachedBytes()+b64Bytes(data)>MAX_ATTACH_BYTES){showToast(file.name+' has no selectable text and is too large to analyze. Try pasting instead.');continue;}
      S.attachedFiles.push({name:file.name,text:'[PDF: '+file.name+' — will be analyzed as image]',type:'image',mediaType:'application/pdf',data});}
  }else if(file.name.endsWith('.docx')){
    const buf=await file.arrayBuffer();const r=await mammoth.extractRawText({arrayBuffer:buf});
    if(r.value.trim())S.attachedFiles.push({name:file.name,text:r.value.trim(),type:'text'});
  }else{const text=await file.text();
    if(text.trim())S.attachedFiles.push({name:file.name,text:text.trim(),type:'text'});
  }}catch(e){console.error(e);alert('Could not read '+file.name+'. Try pasting instead.');}}render();}
function removeFile(i){S.attachedFiles.splice(i,1);render()}
function togglePillar(id){S.selectedPillars.has(id)?S.selectedPillars.delete(id):S.selectedPillars.add(id);render()}
function toggleAnon(){S.anonymous=!S.anonymous;render()}
function togglePillarRef(id){S.openPillars.has(id)?S.openPillars.delete(id):S.openPillars.add(id);render()}
function toggleAllPillars(){if(S.openPillars.size===PILLARS.length)S.openPillars.clear();else PILLARS.forEach(p=>S.openPillars.add(p.id));render();}
async function setTestFlag(id,flag){
  try{
    const {data,error}=await sb.rpc('set_my_submission_test',{p_id:id,p_uid:S.myId,p_is_test:flag});
    if(error)throw error;
    if(!data){alert('Could not update — this submission is not yours, or it is gone.');await refresh();return;}
    await refresh();render();
    showToast(flag?('Marked as test — left out of synthesis'+(S.showTests?'':' (turn on "Show tests" to see it)')):'Unmarked — included in synthesis');
  }catch(e){alert('Error: '+(e.message||'could not update'));}}
async function deleteMine(id){
  if(!confirm('Delete this submission? This cannot be undone.'))return;
  try{
    const {data,error}=await sb.rpc('delete_my_submission',{p_id:id,p_uid:S.myId});
    if(error)throw error;
    if(!data){alert('Could not delete — this submission is not yours, or it is already gone.');await refresh();return;}
    S.openRaw.delete('raw-'+id);
    await refresh();render();showToast('Your submission was deleted');
  }catch(e){alert('Error: '+(e.message||'could not delete'));}}
function toggleRaw(id){S.openRaw.has(id)?S.openRaw.delete(id):S.openRaw.add(id);document.getElementById(id)?.classList.toggle('show');}

// ---------- submit ----------
async function submitVoice(){
  if(S.submitting)return;
  const textEl=document.getElementById('voice-text');const typed=textEl?.value?.trim()||'';
  const nameEl=document.getElementById('display-name');const name=S.anonymous?'':(nameEl?.value?.trim()||S.displayName.trim());
  const textFiles=S.attachedFiles.filter(f=>f.type!=='image');
  const imageFiles=S.attachedFiles.filter(f=>f.type==='image');
  const fileTexts=textFiles.map(f=>`[From: ${f.name}]\n${f.text}`).join('\n\n');
  const imageLabels=imageFiles.map(f=>`[Attached image: ${f.name}]`).join('\n');
  const fullText=[typed,fileTexts,imageLabels].filter(Boolean).join('\n\n');
  if(!fullText)return alert('Please write something or attach a file.');
  if(fullText.length>MAX_CONTENT_CHARS)return alert('That is too long ('+fullText.length.toLocaleString()+' characters). The limit is '+MAX_CONTENT_CHARS.toLocaleString()+'. Try trimming it.');
  S.attachedText=typed;S.submitting=true;render();
  let pillars=[...S.selectedPillars].sort((a,b)=>a-b),autoTagged=false,summary='';
  // One server call: summarize + (if no pillars were picked) auto-tag. The Anthropic key stays on the server.
  try{
    const r=await api('/api/summarize',{text:fullText,selectedPillars:pillars,
      attachments:imageFiles.map(f=>({name:f.name,mediaType:f.mediaType,data:f.data}))});
    if(r.attachmentsSkipped)showToast('Image analysis unavailable — analyzed text only');
    if(Array.isArray(r.pillars)&&r.pillars.length){pillars=r.pillars;autoTagged=!!r.autoTagged;}
    if(r.summary)summary=r.summary;
  }catch(e){console.error('AI processing:',e);showToast('AI analysis: '+(e.message||'error'));}
  if(!summary)summary=fullText.slice(0,200)+(fullText.length>200?'…':'');
  try{
    const {error}=await sb.from('submissions').insert({pillars,content:fullText,summary,auto_tagged:autoTagged,is_test:S.isTest,
      uid:S.myId,display_name:name});
    if(error)throw error;
    S.selectedPillars=new Set();S.attachedFiles=[];S.attachedText='';S.displayName='';S.submitting=false;
    const wasTest=S.isTest;S.isTest=false;
    await refresh();
    showToast(wasTest?'Test submission saved':'Your voice has been added to the fire');nav('voices');
  }catch(e){S.submitting=false;render();alert('Error: '+(e.message||e.code||'could not save'));}}

// ---------- synthesis (project lead) ----------
async function runSynthesis(){
  if(S.synthesizing||!S.isOwner)return;
  const real=S.synthIncludeTests?S.submissions:S.submissions.filter(s=>!s.isTest);
  if(!real.length)return alert('No submissions to analyze.');
  S.synthesizing=true;render();
  try{
    await api('/api/synthesize',{includeTests:S.synthIncludeTests},{'x-admin-key':adminKey});
    S.synthesizing=false;await refresh();render();
  }catch(e){
    S.synthesizing=false;
    if(e.status===401){lockAdmin();alert('That key was not accepted.');}
    else{render();alert('Error: '+(e.message||'synthesis failed'));}
  }}

function showToast(msg){const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
init();
