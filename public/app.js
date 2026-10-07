if(typeof pdfjsLib!=='undefined')pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CONTENT_CHARS=100000;           // matches the CHECK constraint in supabase-setup.sql
const MAX_ATTACH_BYTES=3*1024*1024;       // matches api/summarize.js (Vercel request limit is 4.5 MB)
const POLL_MS=20000;

let S={view:'home',submissions:[],synthesis:null,isOwner:false,
  synthesizing:false,displayName:'',
  showTests:false,showMine:false,synthIncludeTests:false,openPillars:new Set(),openRaw:new Set(),
  loaded:false,persona:0,authReady:false,session:null,participantName:'',
  authEmail:'',otpSent:false,authBusy:false,authError:'',
  metrics:null,metricsState:'',metricsKey:-1,
  acc:{submissions:false,suggested:false},suggested:null,suggestedState:'',suggestedKey:-1};   // Voices accordions (open/closed) + suggested-pillar cache   // Home counts; the Submit tab's wizard state lives in W (wizard.js)
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
// ---------- tab locking: Pillars, Voices and Synthesis open after the participant's first real (non-test) contribution ----------
const LOCKED_TABS={pillars:'Share your voice first, then explore the pillars',voices:'Share your voice first to see what others have shared',synthesis:'Share your voice first to unlock this'};
// Derived from the list we already load, so it updates the moment a submission is saved, edited, deleted or marked as test.
// The project lead is never locked out (they run synthesis), and nothing is treated as unlocked until the list has loaded.
function hasContributed(){return !!S.session&&S.submissions.some(s=>s.mine&&!s.isTest);}
function isLocked(v){return !!LOCKED_TABS[v]&&!S.isOwner&&!hasContributed();}
function nav(v){
  if(isLocked(v)){document.querySelector('.toast')?.remove();showToast(LOCKED_TABS[v]);return;}
  if(v!=='submit')wzStopAllRec();                 // a recording never keeps running behind another tab
  if(v==='submit'&&W.step===8)wzReset();          // coming back after a submission starts a fresh one
  S.view=v;render();window.scrollTo(0,0)}
function filteredSubs(){let s=S.submissions;if(!S.showTests)s=s.filter(x=>!x.isTest);if(S.showMine)s=s.filter(x=>x.mine);return s;}
function setupNeeded(m){m.innerHTML=`<div class="card"><h3>Setup needed</h3><p style="font-size:14px;color:var(--muted)">This app isn't connected to a database yet. Add your Supabase URL and anon key to <strong>public/config.js</strong>, then reload.</p></div>`;}

function render(){
  // Keep whatever is typed in the form across re-renders.
  const n=document.getElementById('display-name');if(n)S.displayName=n.value;
  wzSyncFields();
  if(isLocked(S.view)&&S.loaded)S.view='home';   // e.g. the only real submission was deleted or marked as test while on this tab
  const fk=document.activeElement?.dataset?.fk;   // keyboard users keep their place after a redraw
  document.getElementById('nav').innerHTML=[
    {id:'home',label:'Home',icon:'🔥'},{id:'pillars',label:'Pillars',icon:'📋'},
    {id:'submit',label:'Submit',icon:'✍️'},{id:'voices',label:'Voices',icon:'👁'},
    {id:'synthesis',label:'Synthesis',icon:'⚡'}
  ].map(t=>{const lk=isLocked(t.id);
    return`<button class="${S.view===t.id?'active':''}${lk?' locked':''}"${lk?` aria-disabled="true" aria-label="${t.label} (locked: ${LOCKED_TABS[t.id]})"`:''} onclick="nav('${t.id}')">${t.icon} ${t.label}${lk?' <i class="ti ti-lock" aria-hidden="true"></i>':''}</button>`;}).join('');
  const m=document.getElementById('main');
  ({home:renderHome,submit:renderSubmit,pillars:renderPillars,voices:renderVoices,synthesis:renderSynthesis})[S.view]?.(m);
  if(S.view==='submit')wzAfterRender();
  if(fk)document.querySelector(`#main [data-fk="${fk}"]`)?.focus({preventScroll:true});
}

// Home counts come from /api/metrics. They are cached for the session and re-fetched only when the number of
// real contributions we can already see changes (the 20 s poll updates that), so the numbers stay roughly live.
async function fetchMetrics(key){
  S.metricsKey=key;S.metricsState='loading';
  try{
    const r=await fetch('/api/metrics');
    let d={};try{d=await r.json();}catch(e){}
    if(r.status===401&&d.code==='crew_login'){location.reload();return;}
    if(!r.ok||![d.voices,d.pillarsCovered,d.contributions].every(Number.isInteger))throw new Error('metrics '+r.status);
    S.metrics=d;S.metricsState='ok';
  }catch(e){console.error(e);S.metricsState='failed';}
  if(S.view==='home')render();
}
function renderHome(m){
  const key=S.submissions.filter(s=>!s.isTest).length;
  if(S.loaded&&S.metricsKey!==key&&S.metricsState!=='loading')fetchMetrics(key);
  const mt=S.metrics,num=v=>mt?String(v):'—';
  const stats=S.metricsState==='failed'&&!mt?'':`<div class="stat-row home-stats" aria-label="Live counts"><div class="stat"><div class="stat-num">${num(mt?.voices)}</div><div class="stat-label">Voices heard</div></div><div class="stat"><div class="stat-num">${mt?mt.pillarsCovered+'/12':'—'}</div><div class="stat-label">Pillars covered</div></div><div class="stat"><div class="stat-num">${num(mt?.contributions)}</div><div class="stat-label">Contributions</div></div></div>`;
  const step=(n,title,text,go)=>{const inner=`<span class="step-num">${n}</span><span class="step-title">${title}</span><span class="step-text">${text}</span>`;
    return go?`<button class="step-card clickable" onclick="nav('submit')">${inner}</button>`:`<div class="step-card">${inner}</div>`;};
  m.innerHTML=`<section class="hero">
    <p class="hero-eyebrow">Prometheus Lab</p>
    <h1>Help shape how <span class="hl">humans and AI</span> live together</h1>
    <p class="hero-sub">We're writing a constitution for the playa — and beyond. Your perspective matters. Two minutes. Submit as many times as you like.</p>
    <button class="btn btn-amber hero-cta" onclick="nav('submit')"><i class="ti ti-flame" aria-hidden="true"></i> Add your voice</button>
    <div class="hero-trust"><span><i class="ti ti-eye-off" aria-hidden="true"></i> Anonymous by default</span><span><i class="ti ti-shield-check" aria-hidden="true"></i> Your email stays private</span></div>
  </section>
  ${stats}
  <div class="section-divider"><span>How it works</span></div>
  <div class="step-grid">${step(1,'Share','Write, speak, or upload what you believe',true)}${step(2,'Map','AI connects your ideas to 12 constitutional pillars')}${step(3,'Synthesize','See where we agree, disagree, and have gaps')}</div>
  <div class="card info-card"><h2 class="info-q">What's a constitution here?</h2><p>Behavioral agreements between humans and AI — how we coexist on the playa, and eventually everywhere. Tested at Burning Man, refined through practice. Inspired by how the 10 Principles came together.</p></div>
  <div class="card info-card trust-card"><i class="ti ti-shield-lock trust-icon" aria-hidden="true"></i><div><h2 class="info-q">Built on trust</h2><p>Your email is used only to make sure each voice counts once, and it is never shown to anyone or sent to the AI. Even anonymous submissions are tied to a real person, so every perspective carries equal weight. Your raw words stay private to you. Only AI-generated summaries are shared with the group.</p></div></div>
  <p class="home-footer">A project by burners, technologists, artists, and skeptics.<br>Pro-AI and AI-cautious voices both welcome.</p>`;
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

// ---------- Voices: accordions + suggested pillars ----------
// Suggested pillars come from /api/suggested-pillars (the table behind them has no browser read path). Cached for the session
// and re-fetched only when the number of visible submissions changes, like the Home counts.
async function fetchSuggested(key){
  S.suggestedKey=key;S.suggestedState='loading';
  try{
    const r=await fetch('/api/suggested-pillars');
    let d={};try{d=await r.json();}catch(e){}
    if(r.status===401&&d.code==='crew_login'){location.reload();return;}
    if(!r.ok||!Array.isArray(d.items))throw new Error('suggested '+r.status);
    S.suggested=d.items;S.suggestedState='ok';
  }catch(e){console.error(e);S.suggestedState='failed';}
  if(S.view==='voices')render();
}
// "Show tests" decides whether test people count; the Mine-only filter does not apply (the server never says who is who).
function suggestedGroups(){
  return (S.suggested||[]).map(g=>({idea:g.idea,people:g.people.filter(p=>S.showTests||!p.isTest)})).filter(g=>g.people.length)
    .sort((a,b)=>b.people.length-a.people.length||a.idea.localeCompare(b.idea));
}
function renderSuggested(groups){
  if(S.suggestedState==='failed'&&!S.suggested)return '<p class="acc-empty">Couldn’t load suggested pillars right now.</p>';
  if(!S.suggested)return '<p class="acc-empty">Loading…</p>';
  if(!groups.length)return '<p class="acc-empty">No new pillars suggested yet.</p>';
  return groups.map(g=>{
    const names=g.people.map(p=>p.name).join(', ');
    return`<div class="sugg-row who-host"><span class="sugg-name">${esc(g.idea)}</span>
      <button class="sugg-count" onclick="toggleWho(event,this)" aria-label="${g.people.length} suggested this: ${esc(names)}">(${g.people.length})</button>
      <span class="sugg-who" role="tooltip">Suggested by ${esc(names)}</span></div>`;}).join('');
}
// Hover shows the names on desktop (CSS); tapping the count toggles them for touch screens.
function closeWho(except){document.querySelectorAll('.who-host.open').forEach(r=>{if(r!==except)r.classList.remove('open');});}
function toggleWho(ev,btn){ev.stopPropagation();const host=btn.closest('.who-host');closeWho(host);host.classList.toggle('open');}
document.addEventListener('click',()=>closeWho());
function accordion(id,title,count,inner){
  const open=S.acc[id];
  return`<section class="acc" id="acc-${id}"><button class="acc-head" data-acc-head aria-expanded="${open}" aria-controls="acc-body-${id}" onclick="toggleAcc('${id}')"><span class="acc-chev" aria-hidden="true">${open?'▾':'▸'}</span><span class="acc-title">${title} <span class="acc-count">(${count})</span></span></button>
    <div class="acc-body${open?' settled':''}" id="acc-body-${id}" style="max-height:${open?'none':'0'}"${open?'':' inert'}>${inner}</div></section>`;
}
// Animated with max-height. The toggle edits the DOM directly (a full render() would replace the element and cancel the transition).
function toggleAcc(id){
  const el=document.getElementById('acc-'+id),body=document.getElementById('acc-body-'+id);if(!el||!body)return;
  const open=S.acc[id]=!S.acc[id];
  // the first [data-acc-head] inside the section is its own header (nested sections come later in the DOM)
  el.querySelector('[data-acc-head]').setAttribute('aria-expanded',open);el.classList.toggle('open',open);
  const chev=el.querySelector('[data-acc-head] .acc-chev');if(!chev.classList.contains('rot'))chev.textContent=open?'▾':'▸';   // .rot chevrons turn with CSS instead
  clearTimeout(body._t);closeWho();
  if(open){
    body.removeAttribute('inert');body.style.maxHeight=body.scrollHeight+'px';
    body._t=setTimeout(()=>{body.style.maxHeight='none';body.classList.add('settled');},320);   // after the animation: let content grow freely
  }else{
    body.classList.remove('settled');body.style.maxHeight=body.scrollHeight+'px';body.offsetHeight;   // pin the height, then animate to 0
    body.style.maxHeight='0';body.setAttribute('inert','');
  }
}

function renderVoices(m){
  if(!sb){setupNeeded(m);return;}
  const allReal=S.submissions.filter(s=>!s.isTest);
  const subs=filteredSubs();
  // Counts follow the active filters: tests only count while "Show tests" is on, and the header also follows "Mine only".
  const visible=S.showTests?S.submissions:allReal;
  const myCount=visible.filter(s=>s.mine).length;
  const scope=S.showMine?visible.filter(s=>s.mine):visible;
  const nReal=scope.filter(s=>!s.isTest).length,nTest=scope.length-nReal;
  const sugKey=S.submissions.length;
  if(S.loaded&&S.suggestedKey!==sugKey&&S.suggestedState!=='loading')fetchSuggested(sugKey);
  const groups=suggestedGroups();
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
  m.innerHTML=`<h2>All Voices <span style="color:var(--accent)">(${nReal}${nTest?' + '+nTest+' test':''})</span></h2>
  <div class="filter-bar">
    <div class="toggle-row" onclick="S.showTests=!S.showTests;render()"><div class="toggle toggle-sm ${S.showTests?'on':''}"></div><span>Show tests</span></div>
    <div class="toggle-row" onclick="S.showMine=!S.showMine;render()"><div class="toggle toggle-sm ${S.showMine?'on':''}"></div><span>Mine only (${myCount})</span></div>
  </div>${S.persona?`<p style="font-size:12px;color:var(--muted);margin:-8px 0 16px">Viewing as <strong>${esc(PERSONAS[S.persona].label)}</strong> — change on the Submit tab.</p>`:''}<div class="card">${bars}</div>
  ${accordion('submissions','Submissions',subs.length,cards||'<p class="acc-empty">No submissions match these filters.</p>')}
  ${accordion('suggested','Suggested Pillars',groups.length,renderSuggested(groups))}`;
}

// ---------- Synthesis results: three levels (section → pillar → detail), everything starts collapsed ----------
// Older saved syntheses lack the newer fields (consensus, participants, themes, spectrum...), so each item is normalised first.
const STRENGTH_PCT={strong:85,moderate:60,emerging:35};
// "Mary", "2 anonymous", "Mary (2 participants)" -> one entry per person
function expandVoices(list){
  const out=[];
  for(const v of list||[]){
    const a=/^(\d+) anonymous$/.exec(v);if(a){for(let i=0;i<+a[1];i++)out.push('Anonymous');continue;}
    const m=/^(.*) \((\d+) participants\)$/.exec(v);if(m){for(let i=0;i<+m[2];i++)out.push(m[1]);continue;}
    out.push(v);
  }
  return out;
}
// Union of several voice lists. Only used for old results, which can't say whether two "anonymous" entries are the same person.
function unionPeople(lists){
  const named=new Set();let anon=0;
  for(const l of lists){const e=expandVoices(l);anon=Math.max(anon,e.filter(n=>n==='Anonymous').length);e.forEach(n=>{if(n!=='Anonymous')named.add(n);});}
  return[...[...named].sort((a,b)=>a.localeCompare(b)),...Array(anon).fill('Anonymous')];
}
function synCommons(c){
  const points=c.points?.length?c.points:[{point:c.summary,voices:c.voices}];   // oldest results: one summary + voices per pillar
  return{name:c.pillar,id:c.pillarId,pct:Number.isFinite(c.consensus)?c.consensus:(STRENGTH_PCT[c.strength]??35),
    people:c.participants||unionPeople(points.map(p=>p.voices)),themes:c.themes||[],quotes:c.quotes||[],nuance:c.nuance||'',points};
}
function synContested(c){
  const positions=(c.positions||[]).map(p=>typeof p==='string'?{stance:p,voices:[]}:p).map(p=>({...p,people:p.people||expandVoices(p.voices)}));
  const people=c.participants||unionPeople(positions.map(p=>p.voices));
  const biggest=Math.max(0,...positions.map(p=>p.people.length));
  return{name:c.pillar,id:c.pillarId,pct:Number.isFinite(c.consensus)?c.consensus:(people.length?Math.round(100*biggest/people.length):0),
    people,positions,tension:c.tension||'',spectrum:c.spectrum||null};
}
const pillarEmoji=id=>PILLARS.find(p=>p.id===id)?.emoji||'';
// (N) pill; hovering it (desktop) or tapping it (phone) lists the participants. Must sit outside the row's header button.
function synPill(people){
  if(!people.length)return'';
  const names=people.join(', ');
  return`<button class="sugg-count" onclick="toggleWho(event,this)" aria-label="${people.length} participants: ${esc(names)}">(${people.length})</button><span class="sugg-who" role="tooltip">${esc(names)}</span>`;
}
function synByLine(voices){const v=(voices||[]).map(esc).join(', ');return v?` <span class="syn-by">— ${v}</span>`:'';}
function synSpectrum(c){
  const sp=c.spectrum;
  if(!sp||!sp.left||!sp.right||!c.positions.some(p=>p.people.length))return'';
  const per=6,rows=Math.max(1,...c.positions.map(p=>Math.ceil(p.people.length/per)));
  const dots=c.positions.flatMap(pos=>{
    const n=Math.min(per,pos.people.length);
    return pos.people.map((name,i)=>{
      const col=i%per,row=Math.floor(i/per),inRow=Math.min(per,pos.people.length-row*per);
      const x=Math.min(96,Math.max(4,pos.value+(col-(inRow-1)/2)*4.5));
      const edge=x<22?' edge-l':x>78?' edge-r':'';
      return`<button class="dot who-host${edge}" style="left:${x.toFixed(1)}%;top:${5+row*16}px" aria-label="${esc(name)}: ${esc(pos.stance)}" onclick="toggleWho(event,this)"><span class="sugg-who" role="tooltip">${esc(name)}</span></button>`;});
  }).join('');
  return`<div class="syn-label">Tension spectrum</div><div class="syn-spec"><div class="spec-field" style="height:${24+(rows-1)*16}px"><div class="spec-track"></div>${dots}</div><div class="spec-poles"><span>${esc(sp.left)}</span><span>${esc(sp.right)}</span></div></div>`;
}
function synDetail(kind,c){
  if(kind==='commons'){
    const themes=c.themes.length?`<div class="syn-themes">${c.themes.map(t=>`<span class="syn-theme">${esc(t)}</span>`).join('')}</div>`:'';
    const pts=c.points.map(p=>`<li>${esc(p.point)}${synByLine(p.voices)}</li>`).join('');
    const quotes=c.quotes.map(q=>`<blockquote class="syn-quote">“${esc(q)}”</blockquote>`).join('');
    return`<div class="syn-detail">${themes}<div class="syn-label">What people agree on</div><ul class="syn-pts">${pts}</ul>${quotes}${c.nuance?`<div class="syn-label">Nuance</div><p class="syn-note">${esc(c.nuance)}</p>`:''}</div>`;
  }
  const pos=c.positions.map((p,i)=>`<li><strong>${esc(p.stance)}</strong>${p.voices?.length?synByLine(p.voices):` <span class="syn-by">— Position ${i+1}</span>`}</li>`).join('');
  return`<div class="syn-detail">${synSpectrum(c)}<div class="syn-label">Positions</div><ul class="syn-pts">${pos}</ul>${c.tension?`<div class="syn-label">Core tension</div><p class="syn-note">${esc(c.tension)}</p>`:''}</div>`;
}
function synPillarRow(kind,c){
  const id=`syn-${kind}-${c.id??String(c.name).replace(/\W+/g,'-')}`,open=!!S.acc[id];
  const meter=`<span class="syn-meter" role="img" aria-label="${kind==='commons'?'Consensus':'Largest group'} ${c.pct}%"><i style="width:${c.pct}%"></i></span>`;
  return`<section class="acc syn-pillar${open?' open':''}" id="acc-${id}"><div class="syn-prow who-host">
    <button class="syn-phead" data-acc-head aria-expanded="${open}" aria-controls="acc-body-${id}" onclick="toggleAcc('${id}')"><span class="acc-chev rot" aria-hidden="true">▸</span>${meter}<span class="syn-pname">${pillarEmoji(c.id)} ${esc(c.name)}</span></button>${synPill(c.people)}</div>
    <div class="acc-body${open?' settled':''}" id="acc-body-${id}" style="max-height:${open?'none':'0'}"${open?'':' inert'}>${synDetail(kind,c)}</div></section>`;
}
function synGapRow(g){
  const id=`syn-gaps-${g.pillarId??String(g.pillar).replace(/\W+/g,'-')}`,open=!!S.acc[id];
  const sugg=g.suggestions?.length?g.suggestions:(PILLARS.find(p=>p.id===g.pillarId)?.bullets||[]).slice(0,4);   // older results: the pillar's own topics
  return`<section class="acc syn-pillar${open?' open':''}" id="acc-${id}"><div class="syn-prow">
    <button class="syn-phead" data-acc-head aria-expanded="${open}" aria-controls="acc-body-${id}" onclick="toggleAcc('${id}')"><span class="acc-chev rot" aria-hidden="true">▸</span><span class="syn-pname">${pillarEmoji(g.pillarId)} ${esc(g.pillar)}</span></button></div>
    <div class="acc-body${open?' settled':''}" id="acc-body-${id}" style="max-height:${open?'none':'0'}"${open?'':' inert'}><div class="syn-detail">
      ${g.note?`<div class="syn-label">Why it matters</div><p class="syn-note">${esc(g.note)}</p>`:''}
      ${sugg.length?`<div class="syn-label">What to address next</div><ul class="syn-arrows">${sugg.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}</div></div></section>`;
}
function synSection(key,tag,title,count,rows,empty){
  const id='syn-'+key,open=!!S.acc[id];
  return`<section class="acc syn-sec ${key}${open?' open':''}" id="acc-${id}">
    <button class="syn-shead" data-acc-head aria-expanded="${open}" aria-controls="acc-body-${id}" onclick="toggleAcc('${id}')"><span class="acc-chev rot" aria-hidden="true">▸</span><span class="syn-tag">${tag}</span><span class="syn-stitle">${title}</span><span class="syn-scount">(${count})</span></button>
    <div class="acc-body${open?' settled':''}" id="acc-body-${id}" style="max-height:${open?'none':'0'}"${open?'':' inert'}><div class="syn-rows">${rows||`<p class="acc-empty">${empty}</p>`}</div></div></section>`;
}
function renderSynthesisResult(syn){
  const commons=(syn.commons||[]).map(synCommons),contested=(syn.contested||[]).map(synContested),gaps=syn.gaps||[];
  const covered=new Set([...(syn.commons||[]),...(syn.contested||[])].map(c=>c.pillarId??c.pillar)).size;
  const stat=(icon,color,num,label)=>`<div class="syn-stat"><i class="ti ti-${icon}" style="color:${color}" aria-hidden="true"></i><div class="syn-num">${num}</div><div class="syn-slabel">${label}</div></div>`;
  return`<div class="syn">
    <div class="syn-stats" aria-label="Synthesis at a glance">${stat('users','var(--syn-fg)',syn.count||'—','Voices heard')}${stat('layout-grid','var(--syn-fg)',covered+'/12','Pillars covered')}${stat('circle-check','var(--syn-commons)',commons.length,'Common ground')}${stat('arrows-split-2','var(--syn-contested)',contested.length,'Contested')}${stat('circle-dashed','var(--syn-gaps)',gaps.length,'Gaps')}</div>
    ${synSection('commons','The Commons','Where we agree',commons.length,commons.map(c=>synPillarRow('commons',c)).join(''),'No shared ground found yet.')}
    ${synSection('contested','Contested','Where we diverge',contested.length,contested.map(c=>synPillarRow('contested',c)).join(''),'No open disagreements found.')}
    ${synSection('gaps','Gaps','What’s missing',gaps.length,gaps.map(synGapRow).join(''),'Every pillar was addressed.')}
  </div>`;
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
    sb_=`<p style="font-size:12px;color:var(--muted);margin-bottom:16px">Last run: ${ts} · ${participantText}${contributionText} · ${syn.includedTests?'tests included':'tests excluded'}</p>${renderSynthesisResult(syn)}`;
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
  ${S.synthesizing||S.isOwner?'':`<div style="text-align:center;margin-top:16px"><button class="raw-toggle" onclick="unlockAdmin()">Project lead? Unlock</button></div>`}`;   // no in-page "lock" link: it could strand the lead outside a locked Synthesis tab
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
