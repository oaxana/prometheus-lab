if(typeof pdfjsLib!=='undefined')pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CONTENT_CHARS=100000;           // matches the CHECK constraint in supabase-setup.sql
const MAX_ATTACH_BYTES=3*1024*1024;       // matches api/summarize.js (Vercel request limit is 4.5 MB)
const POLL_MS=20000;

let S={view:'home',submissions:[],synthesis:null,isOwner:false,
  synthesizing:false,displayName:'',
  showTests:false,showMine:false,synthIncludeTests:false,openPillars:new Set(),openRaw:new Set(),
  loaded:false,persona:0,authReady:false,session:null,participantName:'',
  authEmail:'',otpSent:false,authBusy:false,authError:''};   // the Submit tab's wizard state lives in W (wizard.js)
let sb=null,adminKey='';

// ---------- Supabase participant session + admin key ----------
// Test personas are deliberately test-only identities and never use the signed-in participant id.
const PERSONAS={1:{label:'Me',uid:'test-persona-me'},2:{label:'Persona 2',uid:'test-persona-2'},3:{label:'Persona 3',uid:'test-persona-3'}};
function loadAdminKey(){try{return sessionStorage.getItem('prometheus-lab-admin')||'';}catch(e){return '';}}
function loadPersona(){try{return Number(sessionStorage.getItem('prometheus-lab-persona'))||0;}catch(e){return 0;}}
function savePersona(n){try{n?sessionStorage.setItem('prometheus-lab-persona',String(n)):sessionStorage.removeItem('prometheus-lab-persona');}catch(e){}}
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
  displayName:r.display_name,timestamp:r.timestamp,mine:r.mine,content:r.content,
  // owner-only (null for everyone else): wizard metadata and private storage paths
  contributionType:r.contribution_type,inputMode:r.input_mode,pillarChoice:r.pillar_choice,
  audioUrl:r.audio_url,fileUrl:r.file_url,fileName:r.file_name,discoveryAudioUrl:r.discovery_audio_url};}
function mapSynthesis(r){return r?{commons:r.commons||[],contested:r.contested||[],gaps:r.gaps||[],
  timestamp:Date.parse(r.created_at),count:r.count,submissionCount:r.submission_count,includedTests:r.included_tests}:null;}

async function refresh(){
  if(!sb)return;
  try{
    const [subs,syn]=await Promise.all([
      sb.rpc('list_submissions',S.persona?{p_test_uid:PERSONAS[S.persona].uid}:{}),
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

async function loadParticipant(){
  if(!S.session){S.participantName='';S.displayName='';return;}
  const {data,error}=await sb.from('participants').select('display_name').eq('id',S.session.user.id).maybeSingle();
  if(error){console.error(error);S.participantName='';return;}
  S.participantName=data?.display_name||'';
  S.displayName=S.participantName;
}
async function syncSession(session){
  S.session=session||null;S.authReady=true;S.authError='';
  await loadParticipant();
  await refresh();render();
}
async function init(){
  adminKey=loadAdminKey();S.isOwner=!!adminKey;
  S.persona=S.isOwner&&PERSONAS[loadPersona()]?loadPersona():0;
  const cfg=window.PROMETHEUS_LAB_CONFIG||{};
  if(cfg.SUPABASE_URL&&cfg.SUPABASE_ANON_KEY&&window.supabase){
    sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY,
      {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const {data,error}=await sb.auth.getSession();
    if(error)console.error(error);
    await syncSession(data?.session||null);
    sb.auth.onAuthStateChange((_event,session)=>setTimeout(()=>syncSession(session),0));
    setInterval(()=>{if(!document.hidden&&!W.submitting&&!S.synthesizing)refresh();},POLL_MS);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  }else S.authReady=true;
  render();
}

async function sendVerificationCode(){
  const email=(document.getElementById('auth-email')?.value||S.authEmail).trim();
  if(!/^\S+@\S+\.\S+$/.test(email)){S.authError='Enter a valid email address.';render();return;}
  S.authEmail=email;S.authBusy=true;S.authError='';render();
  const {error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:true}});
  S.authBusy=false;
  if(error)S.authError=error.message||'Could not send the verification code.';
  else S.otpSent=true;
  render();
}
async function verifyParticipantCode(){
  const token=(document.getElementById('auth-code')?.value||'').replace(/\s/g,'');
  if(!token){S.authError='Enter the code from your email.';render();return;}
  S.authBusy=true;S.authError='';render();
  const {data,error}=await sb.auth.verifyOtp({email:S.authEmail,token,type:'email'});
  S.authBusy=false;
  if(error){S.authError=error.message||'That code was not accepted.';render();return;}
  S.otpSent=false;await syncSession(data.session);showToast('Verified — your voice is ready');
}
function resetVerification(){S.otpSent=false;S.authError='';render();}
async function signOutParticipant(){
  if(!confirm('Sign out on this device?'))return;
  const {error}=await sb.auth.signOut();
  if(error)return alert('Error: '+error.message);
  S.session=null;S.participantName='';S.displayName='';S.otpSent=false;S.authEmail='';wzReset();
  await refresh();render();
}
async function saveParticipantName(name){
  const clean=String(name||'').trim();
  if(!clean||clean.length>80)throw new Error('Display name must be 1 to 80 characters.');
  const {data,error}=await sb.rpc('set_my_display_name',{p_display_name:clean});
  if(error)throw error;
  S.participantName=data||clean;S.displayName=S.participantName;
}
async function editDisplayName(){
  const name=prompt('Your display name or handle:',S.participantName||'');
  if(name===null)return;
  try{await saveParticipantName(name);await refresh();render();showToast('Display name saved');}
  catch(e){alert('Error: '+(e.message||'could not save name'));}
}
function nav(v){
  if(v!=='submit')wzStopAllRec();                 // a recording never keeps running behind another tab
  if(v==='submit'&&W.step===8)wzReset();          // coming back after a submission starts a fresh one
  S.view=v;render();window.scrollTo(0,0)}
function filteredSubs(){let s=S.submissions;if(!S.showTests)s=s.filter(x=>!x.isTest);if(S.showMine)s=s.filter(x=>x.mine);return s;}
function setupNeeded(m){m.innerHTML=`<div class="card"><h3>Setup needed</h3><p style="font-size:14px;color:var(--muted)">This app isn't connected to a database yet. Add your Supabase URL and anon key to <strong>public/config.js</strong>, then reload.</p></div>`;}

function render(){
  // Keep whatever is typed in the form across re-renders.
  const n=document.getElementById('display-name');if(n)S.displayName=n.value;
  wzSyncFields();
  const fk=document.activeElement?.dataset?.fk;   // keyboard users keep their place after a redraw
  document.getElementById('nav').innerHTML=[
    {id:'home',label:'Home',icon:'🔥'},{id:'pillars',label:'Pillars',icon:'📋'},
    {id:'submit',label:'Submit',icon:'✍️'},{id:'voices',label:'Voices',icon:'👁'},
    {id:'synthesis',label:'Synthesis',icon:'⚡'}
  ].map(t=>`<button class="${S.view===t.id?'active':''}" onclick="nav('${t.id}')">${t.icon} ${t.label}</button>`).join('');
  const m=document.getElementById('main');
  ({home:renderHome,submit:renderSubmit,pillars:renderPillars,voices:renderVoices,synthesis:renderSynthesis})[S.view]?.(m);
  if(S.view==='submit')wzAfterRender();
  if(fk)document.querySelector(`#main [data-fk="${fk}"]`)?.focus({preventScroll:true});
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
  if(!S.authReady&&!S.persona){m.innerHTML='<div class="loading"><div class="spinner"></div>Checking participant verification…</div>';return;}
  if(!S.session&&!S.persona){
    const testSwitcher=S.isOwner?`<div class="persona-row"><span class="persona-label">Testing as</span>${[[0,'Off'],...Object.entries(PERSONAS).map(([k,v])=>[+k,v.label])].map(([k,l])=>`<button class="pillar-chip ${S.persona===k?'selected':''}" onclick="setPersona(${k})">${l}</button>`).join('')}</div>`:'';
    m.innerHTML=`<h2>Share your voice</h2><p class="subtitle">Verify once, then contribute anonymously or with your chosen display name.</p>
    ${testSwitcher}
    <div class="card verify-card"><h3>Verify you’re one participant</h3>
      <p>Your email is used only by Supabase to make sure every person gets one voice. It is never included in synthesis or shown to other participants.</p>
      ${S.authError?`<p class="auth-error">${esc(S.authError)}</p>`:''}
      ${!S.otpSent?`<div class="auth-form"><input type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" value="${esc(S.authEmail)}" oninput="S.authEmail=this.value"><button class="btn btn-primary" onclick="sendVerificationCode()" ${S.authBusy?'disabled':''}>${S.authBusy?'Sending…':'Send code'}</button></div>`
      :`<p class="auth-note">We sent a six-digit code to <strong>${esc(S.authEmail)}</strong>.</p><div class="auth-form"><input type="text" id="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Verification code"><button class="btn btn-primary" onclick="verifyParticipantCode()" ${S.authBusy?'disabled':''}>${S.authBusy?'Checking…':'Verify'}</button></div><button class="raw-toggle" onclick="resetVerification()">Use a different email</button>`}
    </div>`;return;
  }
  const personaRow=S.isOwner?`<div class="persona-row"><span class="persona-label">Testing as</span>${[[0,'Off'],...Object.entries(PERSONAS).map(([k,v])=>[+k,v.label])].map(([k,l])=>`<button class="pillar-chip ${S.persona===k?'selected':''}" onclick="setPersona(${k})">${l}</button>`).join('')}</div>`:'';
  const identity=S.persona
    ?`<div class="auth-status test-status"><span>🧪 Test persona: <strong>${esc(PERSONAS[S.persona].label)}</strong></span><span>Always excluded unless tests are included</span></div>`
    :`<div class="auth-status"><span>✓ Verified participant${S.participantName?` · <strong>${esc(S.participantName)}</strong>`:''}</span><span><button class="raw-toggle" onclick="editDisplayName()">${S.participantName?'Edit name':'Set display name'}</button><button class="raw-toggle" onclick="signOutParticipant()">Sign out / switch</button></span></div>`;
  m.innerHTML=`${personaRow}${identity}<div id="wz-root"></div>`;
  renderWizard(document.getElementById('wz-root'));
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
      const rawButton=c?`<button class="raw-toggle" onclick="toggleRaw('${rawId}')">Show your full submission</button>`:'';
      const testButton=S.persona?'':`<button class="raw-toggle" style="margin-left:16px;color:var(--muted)" onclick="setTestFlag('${s.id}',${!s.isTest})">${s.isTest?'Unmark test':'Mark as test'}</button>`;
      const rawContent=c?`<div class="raw-content${S.openRaw.has(rawId)?' show':''}" id="${rawId}">${esc(rawPreview)}</div>`:'';
      rawBlock=`${rawButton}${testButton}<button class="raw-toggle" style="margin-left:16px;color:var(--muted)" onclick="deleteMine('${s.id}')">Delete</button>${rawContent}`;
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
  </div>${S.persona?`<p style="font-size:12px;color:var(--muted);margin:-8px 0 16px">Viewing as <strong>${esc(PERSONAS[S.persona].label)}</strong> — change on the Submit tab.</p>`:''}<div class="card">${bars}</div><h3 style="margin-bottom:16px">Submissions (${subs.length})</h3>${cards}`;
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
    const participantText=`${syn.count||'?'} participant${syn.count===1?'':'s'}`;
    const contributionText=syn.submissionCount?` · ${syn.submissionCount} contribution${syn.submissionCount===1?'':'s'}`:'';
    sb_=`<p style="font-size:12px;color:var(--muted);margin-bottom:16px">Last run: ${ts} · ${participantText}${contributionText} · ${syn.includedTests?'tests included':'tests excluded'}</p>`;
    if(syn.commons?.length){sb_+=`<div class="card"><span class="section-tag tag-commons">The Commons — Where we agree</span>`;syn.commons.forEach(c=>{
      // older saved syntheses had one summary + voices per pillar instead of a list of points
      const points=c.points?.length?c.points:[{point:c.summary,voices:c.voices}];
      const items=points.map(p=>`<li>${p.voices?.length?`<span class="who">${p.voices.map(esc).join(', ')}</span>`:''} ${esc(p.point)}</li>`).join('');
      sb_+=`<div class="synthesis-item"><strong>${esc(c.pillar)}</strong>${c.strength?` <span class="pill auto">${esc(c.strength)}</span>`:''}<ul class="syn-list commons">${items}</ul></div>`;});sb_+=`</div>`;}
    if(syn.contested?.length){sb_+=`<div class="card"><span class="section-tag tag-contested">Contested Ground — Where we diverge</span>`;syn.contested.forEach(c=>{
      const items=(c.positions||[]).map((p,i)=>{const o=typeof p==='string'?{stance:p,voices:[]}:p;   // older saved syntheses stored plain strings
        return`<li>${o.voices?.length?`<span class="who">${o.voices.map(esc).join(', ')}</span>`:`<span class="who">Position ${i+1}</span>`} ${esc(o.stance)}</li>`;}).join('');
      sb_+=`<div class="synthesis-item"><strong>${esc(c.pillar)}</strong><ul class="syn-list">${items}</ul>${c.tension?`<div class="tension"><strong>Core tension:</strong> ${esc(c.tension)}</div>`:''}</div>`;});sb_+=`</div>`;}
    if(syn.gaps?.length){sb_+=`<div class="card"><span class="section-tag tag-gaps">The Gaps — What's missing</span>`;syn.gaps.forEach(g=>{
      const topics=(PILLARS.find(p=>p.id===g.pillarId)?.bullets||[]).slice(0,4);
      sb_+=`<div class="synthesis-item"><strong>${esc(g.pillar)}</strong><ul class="syn-list gaps">
        <li><span class="who">Why it matters</span> ${esc(g.note)}</li>
        ${topics.length?`<li><span class="who">Topics to consider</span><ul class="syn-sub">${topics.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></li>`:''}</ul></div>`;});sb_+=`</div>`;}
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
      ?`<button class="btn btn-primary" onclick="runSynthesis()">Run synthesis on ${real.length} contributions</button>
         <p style="font-size:12px;color:var(--muted);margin-top:6px">${S.synthIncludeTests?'Including test submissions':'Test submissions excluded'}</p>`
      :`<p style="font-size:13px;color:var(--muted)">All ${testCount} submissions are tests. Toggle "Include test submissions" above to analyze them.</p>`}
  </div>`:''}
  ${!S.isOwner&&!S.synthesis?'<p style="font-size:13px;color:var(--muted);text-align:center;margin-top:16px">Only the project lead can trigger synthesis.</p>':''}
  ${S.synthesizing?'':`<div style="text-align:center;margin-top:16px"><button class="raw-toggle" onclick="${S.isOwner?'lockAdmin()':'unlockAdmin()'}">${S.isOwner?'Lock project-lead controls':'Project lead? Unlock'}</button></div>`}`;
}

// ---------- project-lead unlock (the key is checked by the server on every synthesis run) ----------
function unlockAdmin(){const k=prompt('Project-lead key:');if(!k)return;adminKey=k.trim();saveAdminKey(adminKey);S.isOwner=true;render();}
function lockAdmin(){adminKey='';saveAdminKey('');S.isOwner=false;setPersona(0);}
function setPersona(n){
  // Keep what was typed, but drop the on-screen name box so render() can't copy a stale name back over the new state.
  wzSyncFields();
  document.getElementById('display-name')?.remove();
  S.persona=n;savePersona(n);
  if(!n)S.displayName=S.participantName;
  render();refresh();}

// ---------- files ----------
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

// Pulls text out of one chosen file (and, for photos and scanned PDFs, an image Claude can read directly).
// Old binary .doc/.ppt can't be read in the browser: they come back empty and the wizard asks for a note instead.
async function readAttachment(file,ext){
  const out={text:'',ai:null};
  if(/^(png|jpe?g|gif)$/.test(ext)){
    const data=await imageToJpegBase64(file);   // shrinks phone photos; the API request limit is 4.5 MB
    if(b64Bytes(data)<=MAX_ATTACH_BYTES)out.ai={mediaType:'image/jpeg',data};
  }else if(ext==='pdf'){
    try{const pdf=await pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
      for(let i=1;i<=pdf.numPages;i++){const tc=await(await pdf.getPage(i)).getTextContent();out.text+=tc.items.map(x=>x.str).join(' ')+'\n';}}
    catch(pe){console.error('PDF parse:',pe);}
    out.text=out.text.trim();
    if(!out.text){ // scanned PDF: let Claude read it directly
      const data=await blobToBase64(file);
      if(b64Bytes(data)<=MAX_ATTACH_BYTES)out.ai={mediaType:'application/pdf',data};}
  }else if(ext==='pptx')out.text=await pptxToText(file);
  else if(ext==='docx')out.text=(await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()})).value.trim();
  return out;}
// ---- PowerPoint (.pptx is a zip of XML): slide text in presentation order, plus speaker notes ----
const DML='http://schemas.openxmlformats.org/drawingml/2006/main',REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml=str=>new DOMParser().parseFromString(str,'application/xml');
function paragraphs(doc){ // text per paragraph, skipping auto-fields such as slide numbers
  return [...doc.getElementsByTagNameNS(DML,'p')].map(p=>[...p.getElementsByTagNameNS(DML,'t')].filter(t=>t.parentNode.localName!=='fld').map(t=>t.textContent).join('')).map(t=>t.trim()).filter(Boolean);}
async function pptxToText(file){
  if(file.size>30*1024*1024){showToast(file.name+' is too large (30 MB max)');return '';}
  if(typeof JSZip==='undefined'){showToast('PowerPoint reader failed to load — reload the page');return '';}
  const zip=await JSZip.loadAsync(await file.arrayBuffer());
  const read=async n=>zip.file(n)?xml(await zip.file(n).async('string')):null;
  let order=[];
  try{ // real slide order lives in presentation.xml, not in the file names
    const pres=await read('ppt/presentation.xml'),rels=await read('ppt/_rels/presentation.xml.rels');
    const target={};[...rels.getElementsByTagName('Relationship')].forEach(r=>target[r.getAttribute('Id')]=r.getAttribute('Target'));
    order=[...pres.getElementsByTagNameNS('*','sldId')].map(e=>target[e.getAttributeNS(REL,'id')]).filter(Boolean).map(t=>'ppt/'+t.replace(/^\/?(ppt\/)?/,''));
  }catch(e){}
  if(!order.length)order=Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b)=>parseInt(a.match(/(\d+)\.xml$/)[1])-parseInt(b.match(/(\d+)\.xml$/)[1]));
  const out=[];let i=0;
  for(const path of order){const doc=await read(path);if(!doc)continue;i++;
    const lines=paragraphs(doc);
    let notes=[];
    try{const rels=await read(path.replace(/slides\/(slide\d+\.xml)$/,'slides/_rels/$1.rels'));
      const rel=rels&&[...rels.getElementsByTagName('Relationship')].find(r=>/notesSlide/.test(r.getAttribute('Type')||''));
      if(rel){const nd=await read('ppt/'+rel.getAttribute('Target').replace(/^\.\.\//,''));if(nd)notes=paragraphs(nd);}}catch(e){}
    if(lines.length||notes.length)out.push(`Slide ${i}\n${lines.join('\n')}${notes.length?`\nSpeaker notes: ${notes.join(' ')}`:''}`);}
  return out.join('\n\n');}

function togglePillarRef(id){S.openPillars.has(id)?S.openPillars.delete(id):S.openPillars.add(id);render()}
function toggleAllPillars(){if(S.openPillars.size===PILLARS.length)S.openPillars.clear();else PILLARS.forEach(p=>S.openPillars.add(p.id));render();}
async function setTestFlag(id,flag){
  try{
    const {data,error}=await sb.rpc('set_my_submission_test',{p_id:id,p_is_test:flag});
    if(error)throw error;
    if(!data){alert('Could not update — this submission is not yours, or it is gone.');await refresh();return;}
    await refresh();render();
    showToast(flag?('Marked as test — left out of synthesis'+(S.showTests?'':' (turn on "Show tests" to see it)')):'Unmarked — included in synthesis');
  }catch(e){alert('Error: '+(e.message||'could not update'));}}
async function deleteMine(id){
  if(!confirm('Delete this submission? This cannot be undone.'))return;
  const mineRow=S.submissions.find(x=>x.id===id);
  const stored=[mineRow?.audioUrl,mineRow?.fileUrl,mineRow?.discoveryAudioUrl].filter(p=>p&&!/^https:/.test(p));
  try{
    let deleted=false;
    if(S.persona){
      const result=await api('/api/test-persona-submit',{persona:S.persona,deleteId:id},{'x-admin-key':adminKey});
      deleted=result.deleted===true;
    }else{
      const {data,error}=await sb.rpc('delete_my_submission',{p_id:id});
      if(error)throw error;
      deleted=data===true;
    }
    if(!deleted){alert('Could not delete — this submission is not yours, or it is already gone.');await refresh();return;}
    if(stored.length)sb.storage.from(WZ_BUCKET).remove(stored).then(({error})=>{if(error)console.error('Could not remove stored files:',error);});
    S.openRaw.delete('raw-'+id);
    await refresh();render();showToast('Your submission was deleted');
  }catch(e){alert('Error: '+(e.message||'could not delete'));}}
function toggleRaw(id){S.openRaw.has(id)?S.openRaw.delete(id):S.openRaw.add(id);document.getElementById(id)?.classList.toggle('show');}

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
