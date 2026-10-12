if(typeof pdfjsLib!=='undefined')pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CONTENT_CHARS=100000;           // matches the CHECK constraint in supabase-setup.sql
const MAX_ATTACH_BYTES=3*1024*1024;       // matches api/summarize.js (Vercel request limit is 4.5 MB)
const POLL_MS=20000;

let S={view:'home',submissions:[],isAdmin:false,adminChecked:false,adminBusy:false,adminError:'',unlockTabs:false,
  synthesizing:false,displayName:'',
  showTests:false,showMine:false,synthIncludeTests:false,openPillars:new Set(),openRaw:new Set(),
  loaded:false,authReady:false,session:null,participantName:'',
  authEmail:'',otpSent:false,authBusy:false,authError:'',editingName:false,nameDraft:'',nameBusy:false,
  // Synthesis history: version list (metadata, newest first), full bodies by version (immutable, so cached
  // for good), the version being viewed (null = latest), and the pending-material status from GET /api/synthesize.
  synVersions:[],synBodies:{},synView:null,synStatus:null,synStatusState:'',synStatusKey:'',
  acc:{submissions:false,suggested:false},suggested:null,suggestedState:'',suggestedKey:-1};   // Voices accordions (open/closed) + suggested-pillar cache   // Home counts; the Submit tab's wizard state lives in W (wizard.js)
let sb=null;

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
  audioUrl:r.audio_url,fileUrl:r.file_url,fileName:r.file_name,discoveryAudioUrl:r.discovery_audio_url,
  // Public source metadata has no raw source text or uploader identity.
  sourceType:r.source_type||'individual',sourceTitle:r.source_title||'',voiceLabels:r.voice_labels||[]};}
// Only public columns: the provenance columns (submission_ids, voice_keys) are not readable from the browser.
const SYN_META='version,created_at,voice_count,contribution_count,source_count,included_tests,provenance';
function mapVersion(r){return{version:r.version,timestamp:Date.parse(r.created_at),count:r.voice_count,submissionCount:r.contribution_count,
  sourceCount:r.source_count,includedTests:r.included_tests,provenance:r.provenance};}

async function refresh(){
  if(!sb)return;
  try{
    const [subs,vers]=await Promise.all([
      sb.rpc('list_submissions',{}),
      sb.from('synthesis_versions').select(SYN_META).order('version',{ascending:false}).limit(100)]);
    if(subs.error)throw subs.error;
    if(vers.error)console.error('Synthesis history:',vers.error);   // the rest of the app still works without it
    const next=(subs.data||[]).map(mapSubmission),nextVers=vers.error?S.synVersions:(vers.data||[]).map(mapVersion);
    const changed=!S.loaded||JSON.stringify(next)!==JSON.stringify(S.submissions)||JSON.stringify(nextVers)!==JSON.stringify(S.synVersions);
    S.submissions=next;S.synVersions=nextVers;
    const first=!S.loaded;S.loaded=true;
    // Don't re-render the form while someone is typing in it.
    if(changed&&(first||(S.view!=='submit'&&S.view!=='pillars'&&S.view!=='admin')))render();
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
  try{sessionStorage.removeItem('prometheus-lab-admin');sessionStorage.removeItem('prometheus-lab-persona');}catch(e){}   // keys from the old in-page unlock
  S.unlockTabs=readUnlockTabs();
  if(location.hash==='#admin')S.view='admin';
  checkAdmin();
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
// The bold name in the green "Verified" box is a button: click it to rename yourself from any wizard step.
function startNameEdit(){S.editingName=true;S.nameDraft=S.participantName||S.displayName||'';render();const e=document.getElementById('auth-name-input');if(e){e.focus();e.select();}}
function cancelNameEdit(){S.editingName=false;S.nameBusy=false;render();}
async function saveNameEdit(){
  if(S.nameBusy)return;
  const name=String(S.nameDraft||'').trim();
  if(!name||name.length>80)return alert('Your name must be 1 to 80 characters.');
  if(name===S.participantName){cancelNameEdit();return;}
  S.nameBusy=true;render();
  try{await saveParticipantName(name);S.editingName=false;S.nameBusy=false;const box=document.getElementById('display-name');if(box)box.value=S.displayName;   // render() copies this box back into state, so update it too
    await refresh();render();showToast('Name saved');}
  catch(e){S.nameBusy=false;render();alert('Error: '+(e.message||'could not save name'));}
}
// ---------- tab locking: Pillars, Voices and Synthesis open after the participant's first real (non-test) contribution ----------
const LOCKED_TABS={pillars:'Share your own thinking first, then explore the pillars.',voices:'Share your voice first, then see what others have shared.',synthesis:'Share your voice first, then see where the group agrees and disagrees.'};
// Derived from the list we already load, so it updates the moment a submission is saved, edited, deleted or marked as test.
// Only a logged-in admin who switched on "Unlock all tabs" (Admin page) skips this.
function hasContributed(){return !!S.session&&S.submissions.some(s=>s.mine&&!s.isTest);}
function isLocked(v){return !!LOCKED_TABS[v]&&!(S.isAdmin&&S.unlockTabs)&&!hasContributed();}
function nav(v){
  if(v!=='submit')wzStopAllRec();                 // a recording never keeps running behind another tab
  if(v==='submit'&&W.step===7)wzReset();          // coming back after a submission starts a fresh one
  S.view=v;render();window.scrollTo(0,0)}
// Test submissions are an admin tool: everyone else never sees them, or any switch or wording about them.
function showingTests(){return S.isAdmin&&S.showTests;}
// "Mine only" means your own thoughts. Transcript speakers and document authors you uploaded are other people's voices,
// even though your account manages (edits/deletes) them.
const ownVoice=s=>s.mine&&s.sourceType==='individual';
function filteredSubs(){let s=S.submissions;if(!showingTests())s=s.filter(x=>!x.isTest);if(S.showMine)s=s.filter(ownVoice);return s;}
function setupNeeded(m){m.innerHTML=`<div class="card"><h3>Setup needed</h3><p style="font-size:14px;color:var(--muted)">This app isn't connected to a database yet. Add your Supabase URL and anon key to <strong>public/config.js</strong>, then reload.</p></div>`;}

// A locked tab opens to a faded placeholder of its layout (grey bars, never the real content: the pillars must stay
// unseen until wizard step 2 has captured what someone thinks unprompted) with the unlock message on top.
function renderLocked(m,v){
  const bars=ws=>ws.map(w=>`<span class="sk-bar" style="width:${w}%"></span>`).join('');
  const card=ws=>`<div class="sk-card">${bars(ws)}</div>`;
  const ghost={
    pillars:`<h2>The Pillars</h2>${[70,55,80,62,48,74].map(w=>`<div class="sk-card sk-row"><span class="sk-dot"></span>${bars([w])}</div>`).join('')}`,
    voices:`<h2>All Voices</h2>${card([30,95,88,60])}${card([25,90,70])}${card([35,92,85,50])}`,
    synthesis:`<h2>Collective Synthesis</h2><div class="sk-stats">${'<span class="sk-card"></span>'.repeat(5)}</div>${card([22,90,75])}${card([28,85,60])}${card([18,80,70])}`}[v];
  m.innerHTML=`<div class="locked-view"><div class="locked-ghost" aria-hidden="true">${ghost}</div>
    <div class="locked-panel"><i class="ti ti-lock locked-icon" aria-hidden="true"></i><h2>Unlocks after your first submission</h2><p>${LOCKED_TABS[v]}</p>
    <button class="btn btn-amber" onclick="nav('submit')">Start here</button></div></div>`;
}

function render(){
  // Keep whatever is typed in the form across re-renders.
  const n=document.getElementById('display-name');if(n)S.displayName=n.value;
  wzSyncFields();
  const fk=document.activeElement?.dataset?.fk;   // keyboard users keep their place after a redraw
  document.getElementById('nav').innerHTML=[
    {id:'home',label:'Home',icon:'🔥'},{id:'pillars',label:'Pillars',icon:'📋'},
    {id:'submit',label:'Submit',icon:'✍️'},{id:'voices',label:'Voices',icon:'👁'},
    {id:'synthesis',label:'Synthesis',icon:'⚡'}
  ].map(t=>{const lk=isLocked(t.id);
    return`<button class="${S.view===t.id?'active':''}${lk?' locked':''}"${lk?` aria-label="${t.label} (unlocks after your first submission)"`:''} onclick="nav('${t.id}')"><span class="nav-ico" aria-hidden="true">${t.icon}</span> <span class="nav-lbl">${t.label}${lk?' <i class="ti ti-lock" aria-hidden="true"></i>':''}</span></button>`;}).join('');
  const m=document.getElementById('main');
  if(isLocked(S.view))renderLocked(m,S.view);
  else({home:renderHome,submit:renderSubmit,pillars:renderPillars,voices:renderVoices,synthesis:renderSynthesis,admin:renderAdmin})[S.view]?.(m);
  if(S.view==='submit')wzAfterRender();
  if(fk)document.querySelector(`#main [data-fk="${fk}"]`)?.focus({preventScroll:true});
}

function renderHome(m){
  const step=(n,title,text,go)=>`<button class="step-card clickable" onclick="nav('${go}')"><span class="step-num">${n}</span><span class="step-title">${title}</span><span class="step-text">${text}</span></button>`;
  m.innerHTML=`<section class="hero">
    <p class="hero-eyebrow">Prometheus Lab</p>
    <h1>Help shape how <span class="hl">Humans and AI</span> coexist together</h1>
    <p class="hero-sub">We're writing a constitution for the playa — and beyond. Your perspective matters. Two minutes. Submit as many times as you like.</p>
    <button class="btn btn-amber hero-cta" onclick="nav('submit')"><i class="ti ti-flame" aria-hidden="true"></i> Start here</button>
  </section>
  <div class="section-divider"><span>How it works</span></div>
  <div class="step-grid">${step(1,'Share','Write, speak, or upload what you believe','submit')}${step(2,'Map',`AI connects your ideas to ${PILLARS.length} constitutional pillars`,'pillars')}${step(3,'Synthesize','See where we agree and where we disagree','synthesis')}</div>
  <div class="info-stack">
  <div class="card info-card"><div class="info-head"><i class="ti ti-script info-icon" aria-hidden="true"></i><h2 class="info-q">What's a constitution here?</h2></div><p>Behavioral agreements between humans and AI — how we coexist on the playa, and eventually everywhere. Tested at Burning Man, refined through practice. Inspired by how the 10 Principles came together.</p></div>
  <div class="card info-card trust-card"><div class="info-head"><i class="ti ti-shield-lock info-icon" aria-hidden="true"></i><h2 class="info-q">Built on trust</h2></div><p><strong class="trust-lead">Your email stays private.</strong> It only makes sure each voice counts once, and is never shown to anyone or sent to the AI. Your raw words stay yours; only AI summaries are shared with the group.</p></div>
  </div>
  <p class="home-footer">A project by burners, technologists, artists, and skeptics.<br>Pro-AI and AI-cautious voices both welcome.</p>
  <p class="admin-link-row">${S.session?`<button class="admin-link" onclick="signOutParticipant()">Sign out</button>`:''}<button class="admin-link" onclick="nav('admin')">Admin</button></p>`;
}

function renderPillars(m){
  const items=PILLARS.map(p=>{const open=S.openPillars.has(p.id);
    return`<div class="pillar-ref"><div class="pillar-ref-header" onclick="togglePillarRef(${p.id})">
      <span class="num">${p.id}</span><span class="emoji-lg">${p.emoji}</span><span class="title">${p.name}</span><span class="arrow ${open?'open':''}">▶</span></div>
      <div class="pillar-ref-body ${open?'open':''}"><ul>${p.bullets.map(b=>`<li>${b}</li>`).join('')}</ul>
      ${p.principle?`<div class="principle">Connects to: ${p.principle}</div>`:''}</div></div>`;}).join('');
  m.innerHTML=`<h2>The ${PILLARS.length} Pillars</h2><p class="subtitle">Every topic the constitution could address. Tap to expand. Pick 1–3 when you submit.</p>
  <div style="margin-bottom:16px"><button class="btn-secondary btn" style="font-size:12px;padding:6px 14px" onclick="toggleAllPillars()">${S.openPillars.size===PILLARS.length?'Collapse all':'Expand all'}</button></div>${items}`;
}

function renderSubmit(m){
  if(!sb){setupNeeded(m);return;}
  if(!S.authReady){m.innerHTML='<div class="loading"><div class="spinner"></div>Checking participant verification…</div>';return;}
  if(!S.session){
    m.innerHTML=`<h2>Share your voice</h2><p class="subtitle">Verify once, then contribute anonymously or with your chosen display name.</p>
    <div class="card verify-card"><h3>Verify you’re one participant</h3>
      <p>Your email is used only by Supabase to make sure every person gets one voice. It is never included in synthesis or shown to other participants.</p>
      ${S.authError?`<p class="auth-error">${esc(S.authError)}</p>`:''}
      ${!S.otpSent?`<div class="auth-form"><input type="email" id="auth-email" autocomplete="email" placeholder="you@example.com" value="${esc(S.authEmail)}" oninput="S.authEmail=this.value"><button class="btn btn-primary" onclick="sendVerificationCode()" ${S.authBusy?'disabled':''}>${S.authBusy?'Sending…':'Send code'}</button></div>`
      :`<p class="auth-note">We sent a six-digit code to <strong>${esc(S.authEmail)}</strong>.</p><div class="auth-form"><input type="text" id="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Verification code"><button class="btn btn-primary" onclick="verifyParticipantCode()" ${S.authBusy?'disabled':''}>${S.authBusy?'Checking…':'Verify'}</button></div><div class="spam-nudge" role="note"><span class="spam-icon" aria-hidden="true">📬</span><div><strong>Code not showing up?</strong> Peek in your <strong>spam</strong> or <strong>promotions</strong> folder — it likes to hide there.</div></div><button class="raw-toggle" onclick="resetVerification()">Use a different email</button>`}
    </div>`;return;
  }
  const identity=S.editingName
    ?`<div class="auth-status editing"><span class="auth-edit">✓ <input type="text" id="auth-name-input" class="auth-name-input" maxlength="80" autocomplete="nickname" placeholder="Your name or handle" aria-label="Your name or handle" value="${esc(S.nameDraft)}" oninput="S.nameDraft=this.value" onkeydown="if(event.key==='Enter')saveNameEdit();else if(event.key==='Escape')cancelNameEdit();"><button type="button" class="raw-toggle" onclick="saveNameEdit()" ${S.nameBusy?'disabled':''}>${S.nameBusy?'Saving…':'Save'}</button><button type="button" class="raw-toggle" onclick="cancelNameEdit()" aria-label="Cancel" title="Cancel">✕</button></span></div>`
    :`<div class="auth-status"><span>✓ Verified participant · <button type="button" class="auth-name" onclick="startNameEdit()" title="Click to edit your name" aria-label="${S.participantName?`Your name is ${esc(S.participantName)}. Click to edit`:'Add your name'}">${S.participantName?`<strong>${esc(S.participantName)}</strong>`:'<strong>Add your name</strong>'}<i class="ti ti-pencil" aria-hidden="true"></i></button></span></div>`;
  m.innerHTML=`${identity}<div id="wz-root"></div>`;
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
  return (S.suggested||[]).map(g=>({idea:g.idea,people:g.people.filter(p=>showingTests()||!p.isTest)})).filter(g=>g.people.length)
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
  const visible=showingTests()?S.submissions:allReal;
  const myCount=visible.filter(ownVoice).length;
  const scope=S.showMine?visible.filter(ownVoice):visible;
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
    // Transcript speakers / document authors are named by the source; a person's own contribution always shows
    // their current saved name (renaming updates every earlier named contribution), or Anonymous.
    const who=s.sourceType!=='individual'&&s.voiceLabels?.length?s.voiceLabels.join(' + '):(s.displayName||'Anonymous'),when=s.timestamp?new Date(s.timestamp).toLocaleDateString():'';
    const isMine=s.mine;
    const displayText=s.summary||'Summary pending...';
    const rawId='raw-'+s.id;
    const sourceMeta=s.sourceType&&s.sourceType!=='individual'
      ?` · ${esc(s.sourceType)}${s.sourceTitle?`: ${esc(s.sourceTitle)}`:''}`:'';
    let rawBlock='';
    if(isMine){
      const c=s.content||'';
      const rawPreview=c.length>800?(c.slice(0,800)+'…'):c;
      const rawButton=c?`<button class="raw-toggle" onclick="toggleRaw('${rawId}')">Show your full submission</button>`:'';
      const sourceLocked=s.sourceType&&s.sourceType!=='individual';
      const testButton=sourceLocked||!S.isAdmin?'':`<button class="raw-toggle" style="margin-left:16px;color:var(--muted)" onclick="setTestFlag('${s.id}',${!s.isTest})">${s.isTest?'Unmark test':'Mark as test'}</button>`;
      const rawContent=c?`<div class="raw-content${S.openRaw.has(rawId)?' show':''}" id="${rawId}">${esc(rawPreview)}</div>`:'';
      rawBlock=`${rawButton}${testButton}${sourceLocked?'':`<button class="raw-toggle" style="margin-left:16px;color:var(--muted)" onclick="deleteMine('${s.id}')">Delete</button>`}${rawContent}`;
    }
    return`<div class="submission-card${isMine?' mine':''}${s.isTest?' test-card':''}">
      <div class="submission-meta">${esc(who)} · ${when}${sourceMeta}${s.autoTagged?' · <span style="color:var(--commons)">auto-tagged</span>':''}${isMine?' · <span class="mine-badge">yours</span>':''}${s.isTest?' · <span class="test-badge">test</span>':''}</div>
      <div class="submission-pills">${pills}</div>
      <div class="submission-text"><span class="summary-text">${esc(displayText)}</span></div>${rawBlock}</div>`;
  }).join('');
  m.innerHTML=`<h2>All Voices <span style="color:var(--accent)">(${nReal}${nTest?' + '+nTest+' test':''})</span></h2>
  <div class="filter-bar">
    ${S.isAdmin?`<div class="toggle-row" onclick="S.showTests=!S.showTests;render()"><div class="toggle toggle-sm ${S.showTests?'on':''}"></div><span>Show tests</span></div>`:''}
    <div class="toggle-row" onclick="S.showMine=!S.showMine;render()"><div class="toggle toggle-sm ${S.showMine?'on':''}"></div><span>Mine only (${myCount})</span></div>
  </div><div class="card">${bars}</div>
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
// Saved versions keep the pillar names they were made with, so look pillars up by name: current list first, then the
// original 12 (versions from before the 2026-10-11 consolidation). Matching by id would mix up old and new pillars.
const pillarByName=name=>PILLARS.find(p=>p.name===name)||LEGACY_PILLARS.find(p=>p.name===name);
const pillarEmoji=name=>pillarByName(name)?.emoji||'';
// How many pillars the version was made against: the current list unless a finding names a pillar only the old list has.
function synPillarTotal(syn){
  const names=[...(syn.commons||[]),...(syn.contested||[]),...(syn.gaps||[])].map(f=>f.pillar).filter(Boolean);
  return names.some(n=>!PILLARS.some(p=>p.name===n))?LEGACY_PILLARS.length:PILLARS.length;
}
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
    <button class="syn-phead" data-acc-head aria-expanded="${open}" aria-controls="acc-body-${id}" onclick="toggleAcc('${id}')"><span class="acc-chev rot" aria-hidden="true">▸</span>${meter}<span class="syn-pname">${pillarEmoji(c.name)} ${esc(c.name)}</span></button>${synPill(c.people)}</div>
    <div class="acc-body${open?' settled':''}" id="acc-body-${id}" style="max-height:${open?'none':'0'}"${open?'':' inert'}>${synDetail(kind,c)}</div></section>`;
}
function synGapRow(g){
  const id=`syn-gaps-${g.pillarId??String(g.pillar).replace(/\W+/g,'-')}`,open=!!S.acc[id];
  const sugg=g.suggestions?.length?g.suggestions:(PILLARS.find(p=>p.name===g.pillar)?.bullets||[]).slice(0,4);   // older results: the pillar's own topics
  return`<section class="acc syn-pillar${open?' open':''}" id="acc-${id}"><div class="syn-prow">
    <button class="syn-phead" data-acc-head aria-expanded="${open}" aria-controls="acc-body-${id}" onclick="toggleAcc('${id}')"><span class="acc-chev rot" aria-hidden="true">▸</span><span class="syn-pname">${pillarEmoji(g.pillar)} ${esc(g.pillar)}</span></button></div>
    <div class="acc-body${open?' settled':''}" id="acc-body-${id}" style="max-height:${open?'none':'0'}"${open?'':' inert'}><div class="syn-detail">
      ${g.note?`<div class="syn-label">Why it matters</div><p class="syn-note">${esc(g.note)}</p>`:''}
      ${sugg.length?`<div class="syn-label">What to address next</div><ul class="syn-arrows">${sugg.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}</div></div></section>`;
}
function synSection(key,tag,title,count,rows,empty){
  const id='syn-'+key,open=!!S.acc[id];
  return`<section class="acc syn-sec ${key}${open?' open':''}" id="acc-${id}">
    <button class="syn-shead" data-acc-head aria-expanded="${open}" aria-controls="acc-body-${id}" onclick="toggleAcc('${id}')"><span class="syn-tag">${tag}</span><span class="syn-stitle">${title}</span><span class="syn-scount">${count}</span><i class="ti ti-chevron-down acc-chev rot" aria-hidden="true"></i></button>
    <div class="acc-body${open?' settled':''}" id="acc-body-${id}" style="max-height:${open?'none':'0'}"${open?'':' inert'}><div class="syn-rows">${rows||`<p class="acc-empty">${empty}</p>`}</div></div></section>`;
}
function renderSynthesisResult(syn){
  const commons=(syn.commons||[]).map(synCommons),contested=(syn.contested||[]).map(synContested),gaps=syn.gaps||[];
  const covered=new Set([...(syn.commons||[]),...(syn.contested||[])].map(c=>c.pillarId??c.pillar)).size;
  const stat=(icon,color,num,label)=>`<div class="syn-stat"><div class="syn-slabel"><i class="ti ti-${icon}" style="color:${color}" aria-hidden="true"></i>${label}</div><div class="syn-num">${num}</div></div>`;
  return`<div class="syn">
    <div class="syn-stats${gaps.length?'':' syn-stats-4'}" aria-label="Synthesis at a glance">${stat('users','var(--syn-fg)',syn.count||'—','Voices heard')}${stat('layout-grid','var(--syn-fg)',covered+`<span class="syn-of"> / ${synPillarTotal(syn)}</span>`,'Pillars covered')}${stat('circle-check','var(--syn-commons)',commons.length,'Common ground')}${stat('arrows-split-2','var(--syn-contested)',contested.length,'Contested')}${gaps.length?stat('circle-dashed','var(--syn-gaps)',gaps.length,'Gaps'):''}</div>
    ${synSection('commons','The Commons','Where we agree',commons.length,commons.map(c=>synPillarRow('commons',c)).join(''),'No shared ground found yet.')}
    ${synSection('contested','Contested','Where we diverge',contested.length,contested.map(c=>synPillarRow('contested',c)).join(''),'No open disagreements found.')}
    ${gaps.length?synSection('gaps','Gaps','What’s missing',gaps.length,gaps.map(synGapRow).join(''),''):''}
  </div>`;
}

// ---------- Synthesis page: a snapshot history. Old versions are read back exactly as stored, never re-run. ----------
const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
const synDay=(ts,year)=>new Date(ts).toLocaleDateString('en-US',year?{month:'long',day:'numeric',year:'numeric'}:{month:'long',day:'numeric'});
const synCounts=v=>`${plural(v.count??0,'voice')} · ${plural(v.submissionCount??0,'contribution')}`;
function shownVersion(){return S.synVersions.find(v=>v.version===S.synView)||S.synVersions[0]||null;}
function pickSynVersion(v){S.synView=v===''?null:Number(v);if(S.synView===S.synVersions[0]?.version)S.synView=null;render();}
const synLoading=new Set();
async function loadSynBody(n){   // undefined = not loaded yet, false = failed
  if(synLoading.has(n))return;synLoading.add(n);
  try{
    const {data,error}=await sb.from('synthesis_versions').select(SYN_META+',commons,contested,gaps').eq('version',n).maybeSingle();
    if(error)throw error;
    S.synBodies[n]=data?{...mapVersion(data),commons:data.commons||[],contested:data.contested||[],gaps:data.gaps||[]}:false;
  }catch(e){console.error(e);S.synBodies[n]=false;}
  synLoading.delete(n);
  if(S.view==='synthesis')render();
}
// Re-checked only when the visible submissions, the latest version or the include-tests choice change.
async function fetchSynStatus(key,includeTests){
  S.synStatusKey=key;S.synStatusState='loading';
  try{
    const r=await fetch('/api/synthesize'+(includeTests?'?includeTests=1':''));const d=await r.json();
    if(!r.ok)throw new Error(d.error||('status '+r.status));
    if(S.synStatusKey!==key)return;S.synStatus=d;S.synStatusState='ok';
  }catch(e){console.error(e);if(S.synStatusKey===key)S.synStatusState='failed';}
  if(S.view==='synthesis')render();
}
function synStatusLine(st){
  if(!st||!S.synVersions.length)return'';
  const p=st.pending,line=(kind,html,note)=>`<p class="syn-status ${kind}"><span class="syn-dot" aria-hidden="true"></span><span>${html}${note?`<span class="syn-note">${note}</span>`:''}</span></p>`;
  const soon='New submissions will be added to the synthesis soon.';
  if(p.pillarsChanged)return line('pending',`<strong>The pillars have changed</strong> since the latest synthesis. The next synthesis will reread every contribution against the new pillars.`);
  if(p.contributions>0)return line('pending',`<strong>${plural(p.contributions,'new contribution')}</strong> from ${plural(p.voices,'voice')} ${p.contributions===1?'is':'are'} waiting for the next synthesis.`,soon);
  if(p.edited>0)return line('pending',`<strong>${plural(p.edited,'contribution')}</strong> in the latest synthesis ${p.edited===1?'has':'have'} been edited since. The next synthesis will read the new text.`,soon);
  if(p.removed>0)return line('pending',`<strong>${plural(p.removed,'contribution')}</strong> in the latest synthesis ${p.removed===1?'has':'have'} since been removed or marked as test. The next synthesis will leave ${p.removed===1?'it':'them'} out.`);
  return line('current','Current through all submitted contributions.');
}
function renderSynthesis(m){
  if(!sb){setupNeeded(m);return;}
  const real=S.synthIncludeTests?S.submissions:S.submissions.filter(s=>!s.isTest);
  if(!S.submissions.length&&!S.synVersions.length){m.innerHTML=`<h2>Collective Synthesis</h2><p class="subtitle">Once voices come in, AI sorts everything into two groups: where we agree and where we diverge.</p>
    <div class="preview-block" style="border-color:var(--commons)"><div class="preview-title"><span class="section-tag tag-commons" style="margin:0">The Commons</span></div><p>Topics where voices broadly agree. Easy wins — ratify quickly. Each shows the pillar, consensus summary, and strength.</p></div>
    <div class="preview-block" style="border-color:var(--contested)"><div class="preview-title"><span class="section-tag tag-contested" style="margin:0">Contested Ground</span></div><p>Topics where voices diverge. Your discussion agenda — the real debates. Each shows competing positions and the core tension.</p></div>
    <div style="text-align:center;margin-top:16px"><button class="btn btn-primary" onclick="nav('submit')">Add the first voice</button></div>`;return;}
  // pending-material status (counts only)
  const incTests=S.isAdmin&&S.synthIncludeTests;
  const key=`${S.submissions.map(s=>s.id+(s.isTest?'t':'')).join()}|${S.synVersions[0]?.version??0}|${incTests}`;
  if(S.synStatusKey!==key)fetchSynStatus(key,incTests);
  const st=S.synStatusState==='ok'?S.synStatus:null;

  const v=shownVersion(),latest=S.synVersions[0];
  let meta='',picker='',older='',body='';
  if(v){
    const syn=S.synBodies[v.version];
    if(syn===undefined)loadSynBody(v.version);
    const opts=S.synVersions.map(x=>`<option value="${x.version}"${x.version===v.version?' selected':''}>Version ${x.version} · ${new Date(x.timestamp).toLocaleDateString('en-US',{month:'short',day:'numeric'})}${x===latest?' (latest)':''}</option>`).join('');
    picker=`<div class="syn-versions"><label for="syn-version">Viewing version</label><div class="syn-select"><select id="syn-version" onchange="pickSynVersion(this.value)">${opts}</select><i class="ti ti-chevron-down" aria-hidden="true"></i></div></div>`;
    meta=`<p class="syn-meta"><strong>${synDay(v.timestamp,true)}</strong> <span class="syn-sep" aria-hidden="true">/</span> ${plural(v.count??0,'voice')} <span class="syn-sep" aria-hidden="true">/</span> ${plural(v.submissionCount??0,'contribution')}</p>`;
    if(v!==latest)older=`<p class="syn-status older">You’re viewing an earlier snapshot. <button class="raw-toggle" onclick="pickSynVersion('')">Show the latest</button></p>`;
    body=syn?renderSynthesisResult(syn):syn===false?`<p class="syn-status">Couldn’t load this version. Try again in a moment.</p>`
      :`<div class="card"><div class="loading"><div class="spinner"></div>Loading synthesis…</div></div>`;
  }else{body=`<div class="preview-block"><span class="section-tag tag-commons" style="margin:0">The Commons</span><p style="margin-top:8px">Consensus positions appear here once the first synthesis is created.</p></div>
    <div class="preview-block"><span class="section-tag tag-contested" style="margin:0">Contested Ground</span><p style="margin-top:8px">Competing positions and tensions appear here.</p></div>`;}
  if(S.synthesizing)body=`<div class="card"><div class="loading"><div class="spinner"></div>Reading all voices and finding patterns...</div></div>`;

  // Project lead: create a new version, only when something changed since the latest one.
  const testCount=S.submissions.filter(s=>s.isTest).length;
  let toggle='',action='';
  if(S.isAdmin&&!S.synthesizing&&S.submissions.length){
    const canCreate=st?st.pending.changed:S.synStatusState==='failed';   // if the check failed, the server still refuses a no-change run
    if(testCount)toggle=`<div class="toggle-row" onclick="S.synthIncludeTests=!S.synthIncludeTests;render()"><div class="toggle toggle-sm ${S.synthIncludeTests?'on':''}" style="${S.synthIncludeTests?'background:var(--muted)':''}"></div><span>Include test submissions (${testCount})</span></div>`;
    action=!real.length?`<p class="syn-run-note">All ${testCount} submissions are tests. Toggle "Include test submissions" to analyze them.</p>`
      :canCreate?`<button class="btn btn-amber syn-create" onclick="runSynthesis()"><i class="ti ti-bolt" aria-hidden="true"></i>Create new synthesis</button>`
      :st?'':`<p class="syn-run-note">Checking for new contributions…</p>`;
  }
  const lead=!S.isAdmin&&!latest?'<p class="syn-run-note">Only the project lead can create a synthesis.</p>':'';
  const status=synStatusLine(st);
  const foot=status||toggle||action||lead?`<div class="syn-foot"><div class="syn-foot-l">${status}${toggle}${lead}</div>${action?`<div class="syn-foot-r">${action}</div>`:''}</div>`:'';
  m.innerHTML=`<div class="syn syn-page">
    <div class="syn-top"><div class="syn-titles"><p class="syn-eyebrow syn-intro">AI analysis of all voices</p><h2>Collective Synthesis</h2>${meta}</div>${picker}</div>
    ${older}${body}${foot}</div>`;
}

// ---------- Admin page (project lead) ----------
// The password is checked by /api/admin, which sets an HttpOnly session cookie; synthesis checks that cookie again.
// "Unlock all tabs" is a plain session cookie (no expiry), so it lasts for this browser session across tabs and only
// counts while the admin cookie is valid. Add new controls to ADMIN_CONTROLS.
const UNLOCK_COOKIE='pl_unlock_tabs';
function readUnlockTabs(){return document.cookie.split(/;\s*/).includes(UNLOCK_COOKIE+'=1');}
function setUnlockTabs(on){
  document.cookie=`${UNLOCK_COOKIE}=${on?'1':''}; Path=/; SameSite=Strict${on?'':'; Max-Age=0'}${location.protocol==='https:'?'; Secure':''}`;
  S.unlockTabs=on;render();showToast(on?'Tabs unlocked for you':'Tabs locked again');}
const ADMIN_CONTROLS=[
  {title:'Unlock all tabs',
   text:'Open Pillars, Voices and Synthesis without submitting first. Only affects you, in this browser, until you log out of admin or close the browser. Everyone else still unlocks them by submitting.',
   control:()=>`<button class="admin-switch" role="switch" aria-checked="${S.unlockTabs}" aria-label="Unlock all tabs" onclick="setUnlockTabs(${!S.unlockTabs})"><span class="toggle ${S.unlockTabs?'on':''}" aria-hidden="true"></span><span>${S.unlockTabs?'On':'Off'}</span></button>`},
];
async function checkAdmin(){
  try{const r=await fetch('/api/admin');const d=await r.json();S.isAdmin=r.ok&&d.admin===true;}catch(e){S.isAdmin=false;}
  S.adminChecked=true;render();}
async function adminLogin(e){
  e.preventDefault();
  const password=document.getElementById('admin-password')?.value||'';
  if(!password||S.adminBusy)return;
  S.adminBusy=true;S.adminError='';render();
  try{await api('/api/admin',{action:'login',password});S.isAdmin=true;showToast('Logged in as admin');}
  catch(err){S.adminError=err.status===401?'That password isn’t right.':(err.message||'Could not log in.');}
  S.adminBusy=false;render();
  if(!S.isAdmin)document.getElementById('admin-password')?.focus();}
async function adminLogout(){
  try{await api('/api/admin',{action:'logout'});}catch(e){console.error(e);}
  adminEnded();showToast('Logged out of admin');}
function adminEnded(){if(S.unlockTabs)document.cookie=`${UNLOCK_COOKIE}=; Path=/; Max-Age=0`;S.unlockTabs=false;S.isAdmin=false;render();}
function renderAdmin(m){
  if(!S.adminChecked){m.innerHTML='<div class="loading"><div class="spinner"></div>Checking…</div>';return;}
  if(!S.isAdmin){
    m.innerHTML=`<h2>Admin</h2><p class="subtitle">For the project lead.</p>
    <form class="card admin-login" onsubmit="adminLogin(event)">
      <label for="admin-password">Admin password</label>
      <div class="auth-form"><input type="password" id="admin-password" autocomplete="current-password" required><button class="btn btn-primary" ${S.adminBusy?'disabled':''}>${S.adminBusy?'Checking…':'Log in'}</button></div>
      ${S.adminError?`<p class="auth-error" role="alert">${esc(S.adminError)}</p>`:''}
    </form>`;
    if(!S.adminBusy)document.getElementById('admin-password')?.focus();
    return;}
  m.innerHTML=`<h2>Admin</h2><p class="subtitle">You’re logged in as admin in this browser until you close it.</p>
  ${ADMIN_CONTROLS.map(c=>`<div class="card admin-control"><div><h3>${c.title}</h3><p>${c.text}</p></div>${c.control()}</div>`).join('')}
  <p class="admin-note">Run synthesis from the Synthesis tab.</p>
  <button class="raw-toggle" onclick="adminLogout()">Log out of admin</button>`;
}

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
  else if(/^(md|markdown|txt)$/.test(ext))out.text=(await file.text()).trim();
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
    showToast(flag?('Marked as test — left out of synthesis'+(showingTests()?'':' (turn on "Show tests" to see it)')):'Unmarked — included in synthesis');
  }catch(e){alert('Error: '+(e.message||'could not update'));}}
async function deleteMine(id){
  if(!confirm('Delete this submission? This cannot be undone.'))return;
  const mineRow=S.submissions.find(x=>x.id===id);
  const stored=[mineRow?.audioUrl,mineRow?.fileUrl,mineRow?.discoveryAudioUrl].filter(p=>p&&!/^https:/.test(p));
  try{
    const {data,error}=await sb.rpc('delete_my_submission',{p_id:id});
    if(error)throw error;
    if(data!==true){alert('Could not delete — this submission is not yours, or it is already gone.');await refresh();return;}
    if(stored.length)sb.storage.from(WZ_BUCKET).remove(stored).then(({error})=>{if(error)console.error('Could not remove stored files:',error);});
    S.openRaw.delete('raw-'+id);
    await refresh();render();showToast('Your submission was deleted');
  }catch(e){alert('Error: '+(e.message||'could not delete'));}}
function toggleRaw(id){S.openRaw.has(id)?S.openRaw.delete(id):S.openRaw.add(id);document.getElementById(id)?.classList.toggle('show');}

// ---------- synthesis (project lead) ----------
async function runSynthesis(){
  if(S.synthesizing||!S.isAdmin)return;
  const real=S.synthIncludeTests?S.submissions:S.submissions.filter(s=>!s.isTest);
  if(!real.length)return alert('No submissions to analyze.');
  S.synthesizing=true;render();
  try{
    const r=await api('/api/synthesize',{includeTests:S.synthIncludeTests});
    S.synthesizing=false;S.synView=null;S.synStatusKey='';   // show the latest, re-check pending material
    await refresh();render();
    const fc=r.factCheck,fixed=fc?.removed?` · fact-check removed ${fc.removed} unsupported credit${fc.removed===1?'':'s'}`:'';
    showToast(r.unchanged?`Nothing new since Version ${r.version}, so no new synthesis was needed`:`Version ${r.version} created${fixed}`);
  }catch(e){
    S.synthesizing=false;
    if(e.status===401){adminEnded();alert('Your admin session has ended. Log in again from the Admin link at the bottom of Home.');}
    else{S.synStatusKey='';render();alert('Error: '+(e.message||'synthesis failed'));}
  }}

function showToast(msg){const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
init();
