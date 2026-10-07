// ---------- Submission wizard (the Submit tab, after the participant has verified) ----------
// Eight steps: 1 settings · 2 blank-slate topics · 3 AI pillar mapping · 4 format · 5 the contribution ·
// 6 label · 7 review · 8 confirmation + history. State lives in W and is drawn through app.js's render().
// Loaded after app.js's helpers are defined (it uses api, esc, sb, S, render, showToast, refresh, ...).

const WZ_BUCKET='submission-files';          // private Supabase Storage bucket (see supabase-setup.sql)
const WZ_MAX_FILE=25*1024*1024;              // matches the bucket's file_size_limit
const WZ_MAX_REC_SEC=600;                    // ten minutes per recording
const WZ_CHIPS=['Principle suggestion','Concern or worry','Story from the playa','Pilot idea to test','General observation','Question for the group'];
const WZ_FILE_TYPES={pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif'};
const WZ_AUDIO_EXT={'audio/webm':'webm','audio/mp4':'m4a','audio/ogg':'ogg'};
const WZ_STEP_NAMES=['Before you begin','Topics','Pillars','Format','Contribution','Label','Review','Done'];

const wzClip=(t,n)=>{t=String(t||'');return t.length>n?t.slice(0,n).trimEnd()+'…':t;};
const wzSize=b=>b>=1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
const wzTime=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');

function newRec(){return{blob:null,url:'',mime:'',seconds:0,transcript:'',recording:false,stt:'',path:''};}
function newWizard(){return{
  step:1,confirmed:false,runId:crypto.randomUUID(),anonymous:true,isTest:false,fromReview:false,focusTitle:false,
  dMode:null,dText:'',dRec:newRec(),dId:null,dChain:Promise.resolve(),
  mapState:'idle',mapFor:'',mapping:null,mapToken:0,pillars:new Set(),choice:'selected',
  mode:null,text:'',rec:newRec(),file:null,gdoc:null,gdocUrl:'',gdocBusy:false,note:'',ctype:'',submitting:false,
  editId:null,editText:'',editType:'',editBusy:false};}
let W=newWizard();
const RT={};   // live microphone runtime per recorder key ('d' = step 2, 'r' = step 5); never part of W

function wzDiscoveryText(){return (W.dMode==='voice'?W.dRec.transcript:W.dText).trim();}
function wzPillarNames(){
  if(W.choice==='not_sure')return 'the pillars that fit best (we’ll pick for you)';
  if(W.choice==='something_else')return 'something else entirely';
  return [...W.pillars].sort((a,b)=>a-b).map(id=>PILLARS.find(p=>p.id===id)?.name).filter(Boolean).join(', ')||'no pillar yet';}

// Copy on-screen field values back into W before any redraw (see CLAUDE.md gotcha on render()).
function wzSyncFields(){
  const v=(id,fn)=>{const e=document.getElementById(id);if(e)fn(e.value);};
  v('discovery-text',x=>W.dText=x);v('transcript-d',x=>W.dRec.transcript=x);v('transcript-r',x=>W.rec.transcript=x);
  v('voice-text',x=>W.text=x);v('upload-note',x=>W.note=x);v('gdoc-url',x=>W.gdocUrl=x);v('contrib-type',x=>W.ctype=x);
  v('edit-text',x=>W.editText=x);v('edit-type',x=>W.editType=x);}

// ---------- navigation ----------
function wzGo(n){wzStopAllRec();W.step=n;if(n===7)W.fromReview=false;W.focusTitle=true;render();window.scrollTo(0,0);}
function wzBack(){wzSyncFields();W.fromReview=false;if(W.step>1)wzGo(W.step-1);}
function wzEdit(n){wzSyncFields();W.fromReview=true;wzGo(n);}
function wzReset(){wzStopAllRec();[W.rec,W.dRec].forEach(r=>r.url&&URL.revokeObjectURL(r.url));W=newWizard();}
function wzNewSubmission(){wzReset();W.focusTitle=true;render();window.scrollTo(0,0);}
function wzShowHistory(){wzGo(8);}
async function wzNext(){
  wzSyncFields();const s=W.step;
  if(!wzValid(s))return;
  if(s===2){wzGo(3);wzEnsureMapping();return;}
  if(s===7)return wzSubmit();
  wzGo(W.fromReview&&s!==4?7:s+1);
}
function wzValid(s){
  if(s===1)return !!(W.anonymous||S.participantName||String(S.displayName||'').trim());
  if(s===2)return !!wzDiscoveryText()&&!W.dRec.recording;
  if(s===3)return W.mapState!=='loading'&&(W.choice!=='selected'||W.pillars.size>0);
  if(s===4)return !!W.mode;
  if(s===5){
    if(W.mode==='text')return !!W.text.trim();
    if(W.mode==='voice')return !!W.rec.blob&&!W.rec.recording&&!!W.rec.transcript.trim();
    if(W.mode==='upload')return !!W.gdoc||(!!W.file&&!W.file.busy&&(W.file.readable||!!W.note.trim()));
    return false;}
  if(s===7)return !W.submitting;
  return true;}

// ---------- rendering ----------
function renderWizard(m){
  const s=W.step;
  const body=[null,wzStep1,wzStep2,wzStep3,wzStep4,wzStep5,wzStep6,wzStep7,wzStep8][s]();
  m.innerHTML=`<div class="wz">${wzStepper()}${body}</div>`;
}
function wzStepper(){
  const dots=WZ_STEP_NAMES.map((n,i)=>`<li class="${i+1<W.step?'done':i+1===W.step?'active':''}"${i+1===W.step?' aria-current="step"':''}><span class="wz-sr">${n}</span></li>`).join('');
  return `<div class="wz-progress"><ol class="wz-stepper" aria-label="Step ${W.step} of 8">${dots}</ol><span class="wz-stepcount">Step ${W.step} of 8</span></div>`;}
function wzNav({next='Next',nextOk=true,back=true,final=false}={}){
  return `<div class="wz-nav">${back&&W.step>1?`<button type="button" class="btn-ghost" onclick="wzBack()">← Back</button>`:'<span></span>'}
    <button type="button" class="btn btn-amber" onclick="wzNext()" ${nextOk?'':'disabled'}>${next}</button></div>`;}
const wzTitle=t=>`<h2 class="wz-title" tabindex="-1">${t}</h2>`;
const wzSwitch=(on,label,help,fk,fn)=>`<button type="button" class="wz-setting" role="switch" aria-checked="${on}" data-fk="${fk}" onclick="${fn}">
  <span class="wz-track ${on?'on':''}" aria-hidden="true"></span><span class="wz-setting-text"><span class="wz-setting-label">${label}</span>${help?`<span class="wz-help">${help}</span>`:''}</span></button>`;

function wzStep1(){
  const named=!W.anonymous;
  const nameBit=!named?'':S.participantName
    ?`<div class="wz-name">Your name will show as <strong>${esc(S.participantName)}</strong>. <button type="button" class="raw-toggle" onclick="editDisplayName()">Change</button></div>`
    :`<div class="wz-name"><label for="display-name">Choose one name or handle to show on your contributions</label><input type="text" id="display-name" maxlength="80" placeholder="Your name or handle" value="${esc(S.displayName)}" oninput="wzNameInput()"></div>`;
  const settings=`<div class="card wz-settings">${wzSwitch(W.anonymous,'Submit anonymously','Other participants will see your summary but not your name.','anon','wzToggle(\'anonymous\')')}
      ${nameBit}
      ${wzSwitch(W.isTest,'Test submission','Test submissions won’t be included in the final synthesis','test','wzToggle(\'isTest\')')}</div>`;
  const mine=wzMine().length;
  return `<p class="wz-eyebrow">Before you begin</p>${wzTitle('Share your thinking on how humans and AI should coexist — at Burning Man and beyond.')}
    <p class="subtitle">You can submit with your name or anonymously, as many times as you like.</p>${settings}
    <div class="wz-nav"><span>${mine?`<button type="button" class="raw-toggle" onclick="wzShowHistory()">Your past submissions (${mine})</button>`:''}</span>
    <button type="button" class="btn btn-amber" id="wz-start" onclick="wzNext()" ${wzValid(1)?'':'disabled'}>Get started →</button></div>`;}
// Typing doesn't redraw the page, so re-check the current step's gate and enable/disable Next ourselves.
function wzLiveGate(){wzSyncFields();const b=document.querySelector('.wz-nav .btn-amber');if(b&&W.step!==7)b.disabled=!wzValid(W.step);}
function wzToggle(k){wzSyncFields();W[k]=!W[k];render();}
function wzNameInput(){const e=document.getElementById('display-name');S.displayName=e.value;const b=document.getElementById('wz-start');if(b)b.disabled=!wzValid(1);}

function wzModeCard(on,icon,title,sub,fn,fk){
  return `<button type="button" class="wz-card ${on?'selected':''}" aria-pressed="${on}" data-fk="${fk}" onclick="${fn}"><i class="ti ti-${icon}" aria-hidden="true"></i><span class="wz-card-title">${title}</span>${sub?`<span class="wz-card-sub">${sub}</span>`:''}</button>`;}

function wzStep2(){
  const area=W.dMode==='text'
    ?`<textarea id="discovery-text" rows="6" oninput="wzLiveGate()" placeholder="What principles, boundaries, or values matter most? What concerns you? What excites you?">${esc(W.dText)}</textarea><p class="wz-help">No limit — say what you need to say.</p>`
    :W.dMode==='voice'?wzRecorder('d'):'';
  return `<p class="wz-eyebrow">Step 2</p>${wzTitle('What topics matter most to you?')}
    <p class="subtitle">Before we show you what we’re working with, we’d like to hear from you. In your own words, what are the most important topics to address as humans and AI begin to coexist?</p>
    <p class="wz-help wz-help-spaced">These will become Pillars or themes. You will have the option to add in-depth ideas and upload documents on the next page.</p>
    <div class="wz-cards two">${wzModeCard(W.dMode==='text','pencil','Write it','','wzSetDMode(\'text\')','dm-text')}${wzModeCard(W.dMode==='voice','microphone','Say it','','wzSetDMode(\'voice\')','dm-voice')}</div>
    <div class="wz-inline">${area}</div>${wzNav({nextOk:wzValid(2)})}`;}
function wzSetDMode(m){wzSyncFields();wzStopAllRec();W.dMode=m;render();}

// ---- step 3: AI mapping ----
async function wzEnsureMapping(){
  const text=wzDiscoveryText();
  if(W.mapState==='done'&&W.mapFor===text)return;
  if(W.mapState==='loading'&&W.mapFor===text)return;
  const w=W,token=++w.mapToken;
  w.mapState='loading';w.mapFor=text;w.mapping=null;render();
  const saved=wzSaveDiscovery().catch(e=>{console.error(e);showToast('Couldn’t save your topic notes yet — we’ll try again when you submit.');});
  try{
    const r=await api('/api/map-pillars',{text});
    if(w!==W||token!==w.mapToken)return;
    w.mapping={matched:r.matched||[],newIdeas:r.newIdeas||[],reasoning:r.reasoning||''};
    w.mapState='done';w.choice='selected';w.pillars=new Set(w.mapping.matched);
    render();
    await saved;wzSaveDiscovery().catch(e=>console.error(e));   // second write stores Claude's mapping next to the answer
  }catch(e){
    console.error('Pillar mapping:',e);
    if(w!==W||token!==w.mapToken)return;
    w.mapState='failed';w.mapping=null;render();
  }}
function wzPillarCard(p){
  const on=W.choice==='selected'&&W.pillars.has(p.id);
  return `<button type="button" class="wz-pillar ${on?'selected':''}" aria-pressed="${on}" data-fk="p${p.id}" onclick="wzTogglePillar(${p.id})"><span class="emoji">${p.emoji}</span><span>${esc(p.name)}</span>${on?'<i class="ti ti-check wz-tick" aria-hidden="true"></i>':''}</button>`;}
function wzStep3(){
  if(W.mapState==='loading')return `<p class="wz-eyebrow">Step 3</p>${wzTitle('Here’s how your ideas connect')}<div class="loading" role="status"><div class="spinner"></div>Mapping your ideas...</div>
    <div class="wz-nav"><button type="button" class="btn-ghost" onclick="wzBack()">← Back</button><span></span></div>`;
  const mp=W.mapping;
  const matched=mp?mp.matched.map(id=>PILLARS.find(p=>p.id===id)).filter(Boolean):[];
  const matchedHtml=matched.length?`<h3>Your ideas connect to these draft pillars:</h3><div class="wz-pillars">${matched.map(wzPillarCard).join('')}</div>${mp.reasoning?`<p class="wz-help">${esc(mp.reasoning)}</p>`:''}`:'';
  const newHtml=mp&&mp.newIdeas.length?`<h3>This seems new — not covered by our draft pillars yet:</h3>${mp.newIdeas.map(t=>`<div class="wz-new"><span class="wz-badge">New</span><span>${esc(t)}</span></div>`).join('')}`:'';
  const failNote=W.mapState==='failed'?`<p class="wz-note">We couldn’t map your ideas automatically just now. No problem — pick the pillars that fit best below.</p>`:'';
  const special=(k,label)=>`<button type="button" class="wz-pillar special ${W.choice===k?'selected':''}" aria-pressed="${W.choice===k}" data-fk="${k}" onclick="wzChoose('${k}')"><span>${label}</span>${W.choice===k?'<i class="ti ti-check wz-tick" aria-hidden="true"></i>':''}</button>`;
  return `<p class="wz-eyebrow">Step 3</p>${wzTitle('Here’s how your ideas connect')}${failNote}${matchedHtml}${newHtml}
    <h3 class="wz-sub">${matched.length||mp?'All draft pillars — tap to add or remove':'Which pillars fit your ideas? Tap to choose (one or more)'}</h3>
    <div class="wz-pillars">${PILLARS.map(wzPillarCard).join('')}${special('not_sure','Not sure yet')}${special('something_else','Something else entirely')}</div>
    ${wzNav({nextOk:wzValid(3)})}`;}
function wzTogglePillar(id){wzSyncFields();W.choice='selected';W.pillars.has(id)?W.pillars.delete(id):W.pillars.add(id);render();}
function wzChoose(k){wzSyncFields();if(W.choice===k)W.choice='selected';else{W.choice=k;W.pillars=new Set();}render();}

function wzStep4(){
  return `<p class="wz-eyebrow">Step 4</p>${wzTitle('How do you want to share?')}
    <div class="wz-cards three">${wzModeCard(W.mode==='text','pencil','Write it','Type out your thoughts','wzSetMode(\'text\')','m-text')}${wzModeCard(W.mode==='voice','microphone','Say it','Record a voice note','wzSetMode(\'voice\')','m-voice')}${wzModeCard(W.mode==='upload','upload','Upload','Attach a file','wzSetMode(\'upload\')','m-upload')}</div>
    <p class="wz-help">Upload accepts: PDF, DOC, DOCX, PPT, PPTX, PNG, JPG, Google Docs, Google Slides</p>${wzNav({nextOk:wzValid(4)})}`;}
function wzSetMode(m){W.mode=m;render();}

// ---- step 5: the contribution ----
function wzStep5(){
  const hint=`<div class="wz-hint"><i class="ti ti-flask" aria-hidden="true"></i><span>You’re contributing to: <strong>${esc(wzPillarNames())}</strong></span></div>`;
  let input='';
  if(W.mode==='text')input=`<textarea id="voice-text" rows="8" oninput="wzLiveGate()" placeholder="What principle, concern, or idea do you want to share about AI at Burning Man and beyond?">${esc(W.text)}</textarea><p class="wz-help">No limit — say what you need to say.</p>`;
  else if(W.mode==='voice')input=wzRecorder('r');
  else input=wzUploader();
  return `<p class="wz-eyebrow">Step 5</p>${wzTitle('Share your thinking')}${hint}${input}${wzNav({nextOk:wzValid(5)})}`;}

// ---- voice recorder (steps 2 and 5) ----
function wzRecorder(key){
  const r=key==='d'?W.dRec:W.rec;
  if(!(navigator.mediaDevices&&window.MediaRecorder))return `<p class="wz-note">Your browser can’t record audio. Go back and choose “Write it” instead.</p>`;
  const stt=r.stt==='unsupported'?'Automatic transcription isn’t available in this browser — type what you said below.'
    :r.stt==='error'?'Transcription stopped early — check the text below and add anything missing.'
    :r.blob&&!r.transcript.trim()?'We didn’t catch any words — type or paste what you said below.':'';
  const status=r.recording?'Recording… tap to stop':r.blob?`Recorded ${wzTime(r.seconds)}`:'Tap to record';
  return `<div class="wz-recorder">
    <button type="button" class="wz-rec-btn ${r.recording?'live':''}" data-fk="rec-${key}" onclick="wzToggleRec('${key}')" aria-label="${r.recording?'Stop recording':r.blob?'Record again':'Start recording'}"><i class="ti ti-${r.recording?'player-stop':'microphone'}" aria-hidden="true"></i></button>
    <div class="wz-rec-status" role="status"><span id="time-${key}">${r.recording?'0:00':''}</span> ${status}</div>
    ${r.recording?`<canvas class="wz-wave" id="wave-${key}" width="600" height="80" aria-hidden="true"></canvas>`:''}
    ${r.blob&&!r.recording?`<audio controls src="${r.url}" class="wz-audio"></audio>`:''}
    ${r.blob||r.recording?`<label class="wz-label" for="transcript-${key}">Transcript — edit anything we got wrong</label><textarea id="transcript-${key}" rows="5" oninput="wzLiveGate()" ${r.recording?'readonly':''} placeholder="Your words will appear here">${esc(r.transcript)}</textarea>`:''}
    ${stt?`<p class="wz-note">${stt}</p>`:''}
    ${r.blob||r.recording?`<p class="wz-help">Your browser’s speech service does the transcribing, so the audio may pass through it (Google in Chrome, Apple in Safari).</p>`:''}
  </div>`;}
function wzRecOf(key){return key==='d'?W.dRec:W.rec;}
async function wzToggleRec(key){wzSyncFields();wzRecOf(key).recording?wzStopRec(key):await wzStartRec(key);}
let wzMicAsking=false;
async function wzStartRec(key){
  if(Object.keys(RT).length||wzMicAsking)return;
  const r=wzRecOf(key);let stream;
  wzMicAsking=true;
  try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
  catch(e){showToast('Microphone blocked — allow it in your browser, or go back and choose “Write it”.');return;}
  finally{wzMicAsking=false;}
  if(r.url)URL.revokeObjectURL(r.url);
  Object.assign(r,{blob:null,url:'',mime:'',seconds:0,transcript:'',path:'',stt:''});
  const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported?.(t))||'';
  const mr=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
  const rt={key,r,stream,mr,chunks:[],started:Date.now(),stopping:false,finalText:'',timer:0,raf:0,ctx:null,sr:null,closed:false};
  mr.ondataavailable=e=>{if(e.data&&e.data.size)rt.chunks.push(e.data);};
  mr.onstop=()=>wzFinishRec(rt);
  RT[key]=rt;r.recording=true;
  mr.start(1000);
  rt.timer=setInterval(()=>{
    const sec=(Date.now()-rt.started)/1000,el=document.getElementById('time-'+key);
    if(el)el.textContent=wzTime(sec);
    if(sec>=WZ_MAX_REC_SEC){showToast('Ten-minute limit reached — recording stopped.');wzStopRec(key);}
  },250);
  render();wzStartWave(rt);wzStartSpeech(rt,r);
}
function wzStartWave(rt){
  try{
    const AC=window.AudioContext||window.webkitAudioContext;rt.ctx=new AC();
    const an=rt.ctx.createAnalyser();an.fftSize=128;rt.ctx.createMediaStreamSource(rt.stream).connect(an);
    const data=new Uint8Array(an.frequencyBinCount);
    const draw=()=>{
      rt.raf=requestAnimationFrame(draw);
      const c=document.getElementById('wave-'+rt.key);if(!c)return;
      const g=c.getContext('2d'),w=c.width,h=c.height;an.getByteFrequencyData(data);
      g.clearRect(0,0,w,h);g.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--amber').trim()||'#EF9F27';
      const n=48,bw=w/n;
      for(let i=0;i<n;i++){const v=data[Math.floor(i*data.length/n)]/255,bh=Math.max(4,v*h);g.fillRect(i*bw+2,(h-bh)/2,bw-4,bh);}
    };
    draw();
  }catch(e){console.error('Waveform unavailable:',e);}}
function wzStartSpeech(rt,r){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){r.stt='unsupported';return;}
  try{
    const sr=new SR();sr.continuous=true;sr.interimResults=true;sr.lang=navigator.language||'en-US';rt.sr=sr;
    sr.onresult=e=>{
      if(rt.closed)return;let interim='';
      for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)rt.finalText+=t.trim()+' ';else interim+=t;}
      r.transcript=(rt.finalText+interim).trim();
      const el=document.getElementById('transcript-'+rt.key);if(el)el.value=r.transcript;};
    sr.onerror=e=>{if(e.error!=='no-speech'&&e.error!=='aborted'){r.stt='error';rt.srFailed=true;}};
    sr.onend=()=>{
      if(rt.stopping||rt.srFailed){rt.closed=true;return;}
      try{sr.start();}catch(e){rt.closed=true;}};   // Chrome ends recognition on silence; keep listening
    sr.start();
  }catch(e){r.stt='error';}}
function wzStopRec(key){
  const rt=RT[key];if(!rt)return;
  rt.stopping=true;try{rt.sr?.stop();}catch(e){}
  if(rt.mr.state!=='inactive')rt.mr.stop();else wzFinishRec(rt);}
function wzStopAllRec(){Object.keys(RT).forEach(wzStopRec);}
function wzFinishRec(rt){
  if(RT[rt.key]!==rt)return;
  delete RT[rt.key];
  clearInterval(rt.timer);cancelAnimationFrame(rt.raf);rt.stream.getTracks().forEach(t=>t.stop());try{rt.ctx?.close();}catch(e){}
  const r=rt.r,base=(rt.mr.mimeType||'audio/webm').split(';')[0];
  r.recording=false;r.seconds=Math.round((Date.now()-rt.started)/1000);
  if(rt.chunks.length){r.mime=WZ_AUDIO_EXT[base]?base:'audio/webm';r.blob=new Blob(rt.chunks,{type:r.mime});r.url=URL.createObjectURL(r.blob);}
  render();}

// ---- file upload (step 5) ----
function wzUploader(){
  const f=W.file,g=W.gdoc;
  const chip=f?`<div class="file-preview"><i class="ti ti-file" aria-hidden="true"></i><span class="name">${esc(f.name)}</span><span class="wz-meta">${wzSize(f.size)}${f.busy?' · reading…':''}</span><button type="button" class="remove" aria-label="Remove file" onclick="wzClearFile()">✕</button></div>`
    :g?`<div class="file-preview"><i class="ti ti-link" aria-hidden="true"></i><span class="name">${esc(g.name)}</span><span class="wz-meta">Google link</span><button type="button" class="remove" aria-label="Remove link" onclick="wzClearFile()">✕</button></div>`:'';
  const needNote=f&&!f.busy&&!f.readable;
  return `<div class="drop-zone" id="drop-zone"><input type="file" id="wz-file" accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.gif" aria-label="Choose a file to upload" onchange="wzPickFile(this.files[0]);this.value=''"><i class="ti ti-upload icon" aria-hidden="true"></i><span class="label">Drag a file here or <strong>click to browse</strong><br><span class="wz-help">PDF, DOC, DOCX, PPT, PPTX, PNG, JPG, GIF · up to 25 MB</span></span></div>
    <div class="form-row" style="margin:0 0 6px"><input type="text" id="gdoc-url" placeholder="Or paste a Google Docs / Slides link" value="${esc(W.gdocUrl)}" onkeydown="if(event.key==='Enter')wzAddGoogle()"><button type="button" class="btn btn-secondary" style="padding:10px 18px;font-size:14px" onclick="wzAddGoogle()" ${W.gdocBusy?'disabled':''}>${W.gdocBusy?'Adding…':'Add'}</button></div>
    <p class="wz-help">Google files must be shared as “Anyone with the link can view”.</p>${chip}
    ${needNote?`<p class="wz-note">We can’t read the words in this kind of file automatically, so please add a few sentences of your own below.</p>`:''}
    ${f||g?`<label class="wz-label" for="upload-note">${needNote?'Describe it in your own words (required)':'Add a note of your own (optional)'}</label><textarea id="upload-note" rows="4" oninput="wzLiveGate()" placeholder="What should we know about this?">${esc(W.note)}</textarea>`:''}`;}
function wzAfterRender(){
  const dz=document.getElementById('drop-zone');
  if(dz){dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('dragover');});
    dz.addEventListener('dragleave',()=>dz.classList.remove('dragover'));
    dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('dragover');wzPickFile(e.dataTransfer.files[0]);});}
  if(W.focusTitle){W.focusTitle=false;document.querySelector('.wz-title')?.focus({preventScroll:true});}}
function wzClearFile(){wzSyncFields();W.file=null;W.gdoc=null;render();}
async function wzPickFile(file){
  if(!file)return;wzSyncFields();
  const ext=(file.name.split('.').pop()||'').toLowerCase();
  if(!WZ_FILE_TYPES[ext])return showToast('That file type isn’t supported — use PDF, DOC, DOCX, PPT, PPTX, PNG, JPG or GIF.');
  if(file.size>WZ_MAX_FILE)return showToast(file.name+' is too large (25 MB max).');
  const rec={name:file.name,size:file.size,ext,blob:file,busy:true,text:'',ai:null,readable:false,path:''};
  W.file=rec;W.gdoc=null;render();
  try{Object.assign(rec,await readAttachment(file,ext));}catch(e){console.error(e);showToast('Could not read '+file.name+' — you can still add a note of your own.');}
  rec.busy=false;rec.readable=!!rec.text.trim()||!!rec.ai;
  if(W.file===rec)render();}
async function wzAddGoogle(){
  wzSyncFields();const url=W.gdocUrl.trim();
  if(!url||W.gdocBusy)return;
  if(!/^https:\/\/docs\.google\.com\/.*(document|presentation)\/d\//.test(url))return showToast('That doesn’t look like a Google Docs or Slides link');
  W.gdocBusy=true;render();
  try{const r=await api('/api/google-doc',{url});
    W.gdoc={name:(r.kind==='presentation'?'Slides: ':'Doc: ')+r.name,link:url,text:r.text};W.file=null;W.gdocUrl='';
    document.getElementById('gdoc-url')?.remove();   // render() copies the box back into state, so drop the box too
  }catch(e){showToast(e.message||'Could not read that Google file');}
  W.gdocBusy=false;render();}

// ---- step 6 ----
function wzStep6(){
  return `<p class="wz-eyebrow">Step 6</p>${wzTitle('What kind of contribution is this?')}
    <p class="subtitle">Help us understand the nature of your input. This is free text — just a quick label. You can skip it.</p>
    <input type="text" id="contrib-type" maxlength="120" placeholder="e.g. concern / principle suggestion / story from playa / pilot idea / general observation / question" value="${esc(W.ctype)}" oninput="wzTypeInput(this)" aria-label="Type of contribution">
    <div class="wz-chips">${WZ_CHIPS.map(c=>`<button type="button" class="wz-chip" onclick="wzChip(this)">${c}</button>`).join('')}</div>
    ${wzNav({next:W.ctype.trim()?'Next':'Skip'})}`;}
function wzTypeInput(el){W.ctype=el.value;const nx=document.querySelector('.wz-nav .btn-amber');if(nx)nx.textContent=W.ctype.trim()?'Next':'Skip';}
function wzChip(btn){const e=document.getElementById('contrib-type');if(e){e.value=btn.textContent;e.focus();wzTypeInput(e);}}

// ---- step 7: review ----
function wzReviewBlock(title,html,step){return `<div class="wz-review"><div class="wz-review-head"><h3>${title}</h3><button type="button" class="raw-toggle" onclick="wzEdit(${step})" aria-label="Edit ${title.toLowerCase()}">Edit</button></div>${html}</div>`;}
function wzPreview(){
  if(W.mode==='text')return `<p>${esc(wzClip(W.text.trim(),400))}</p>`;
  if(W.mode==='voice')return `<audio controls src="${W.rec.url}" class="wz-audio"></audio><p class="wz-help">${esc(wzClip(W.rec.transcript.trim(),300))}</p>`;
  const f=W.gdoc||W.file;
  return `<p><i class="ti ti-${W.gdoc?'link':'file'}" aria-hidden="true"></i> ${esc(f.name)}${W.file?` <span class="wz-meta">(${wzSize(W.file.size)})</span>`:''}</p>${W.note.trim()?`<p class="wz-help">${esc(wzClip(W.note.trim(),300))}</p>`:''}`;}
function wzStep7(){
  const fmt={text:'Written text',voice:'Voice recording',upload:'File upload'}[W.mode];
  const badges=[W.anonymous?'Anonymous':'',W.isTest?'Test submission':''].filter(Boolean);
  const who=!W.anonymous?`<p class="wz-help">Submitting as <strong>${esc(S.participantName||S.displayName)}</strong></p>`:'';
  return `<p class="wz-eyebrow">Step 7</p>${wzTitle('Review and submit')}
    ${wzReviewBlock('Pillars',`<p>${esc(wzPillarNames())}</p>`,3)}
    ${wzReviewBlock('Format',`<p>${fmt}</p>`,4)}
    ${wzReviewBlock('Your submission',wzPreview(),5)}
    ${wzReviewBlock('Type of contribution',`<p>${W.ctype.trim()?esc(W.ctype.trim()):'<span class="wz-help">Not specified</span>'}</p>`,6)}
    ${badges.length?`<div class="wz-badges">${badges.map(b=>`<span class="wz-badge solid">${b}</span>`).join('')}</div>`:''}${who}
    ${W.submitting?'<div class="loading" role="status"><div class="spinner"></div>Saving your voice…</div>'
      :`<div class="wz-nav"><button type="button" class="btn-ghost" onclick="wzBack()">← Back</button><button type="button" class="btn btn-amber" onclick="wzNext()">✓ Submit</button></div>`}`;}

// ---------- submit ----------
async function wzUpload(label,blob,type,ext){
  const path=`${S.session.user.id}/${W.runId}/${label}-${Date.now().toString(36)}.${ext}`;
  const {error}=await sb.storage.from(WZ_BUCKET).upload(path,new Blob([blob],{type}),{contentType:type,upsert:false});
  if(error)throw new Error('Could not upload your '+(label==='file'?'file':'recording')+': '+(error.message||'storage error'));
  return path;}
function wzSaveDiscovery(){   // serialised, so the second write (with the AI mapping) always updates the first row
  const w=W;
  return w.dChain=w.dChain.catch(()=>{}).then(async()=>{
    if(!S.session)return;
    const text=wzDiscoveryText();if(!text)return;
    const voice=w.dMode==='voice';let audio=null;
    if(voice&&w.dRec.blob)audio=w.dRec.path||(w.dRec.path=await wzUpload('discovery',w.dRec.blob,w.dRec.mime,WZ_AUDIO_EXT[w.dRec.mime]||'webm'));
    const {data,error}=await sb.rpc('save_discovery_input',{p_id:w.dId,p_input_text:text,p_input_type:voice?'voice':'text',p_audio_url:audio,
      p_ai_mapping:w.mapState==='done'&&w.mapFor===text?w.mapping:null,p_is_anonymous:w.anonymous,p_is_test:w.isTest});
    if(error)throw error;w.dId=data;});}
function wzBuild(){
  if(W.mode==='text')return{content:W.text.trim(),attachments:[]};
  if(W.mode==='voice')return{content:W.rec.transcript.trim(),attachments:[]};
  const parts=[W.note.trim()],f=W.file;
  if(W.gdoc)parts.push(`[From: ${W.gdoc.name}]\n${W.gdoc.text}`);
  else if(f.text.trim())parts.push(`[From: ${f.name}]\n${f.text.trim()}`);
  else parts.push(/^(png|jpe?g|gif)$/.test(f.ext)?`[Attached image: ${f.name}]`:`[Attached file: ${f.name}]`);
  return{content:parts.filter(Boolean).join('\n\n'),attachments:f?.ai?[{name:f.name,mediaType:f.ai.mediaType,data:f.ai.data}]:[]};}
async function wzSubmit(){
  if(W.submitting||!wzValid(7))return;
  if(!S.session)return alert('Verify your email before contributing.');
  const {content,attachments}=wzBuild();
  if(!content)return alert('Please add your contribution first.');
  if(content.length>MAX_CONTENT_CHARS)return alert('That is too long ('+content.length.toLocaleString()+' characters). The limit is '+MAX_CONTENT_CHARS.toLocaleString()+'. Try trimming it.');
  const w=W;w.submitting=true;render();
  try{
    let audioPath=null,filePath=null;const fileName=(w.mode==='upload'?(w.gdoc||w.file).name:null);
    if(w.mode==='voice'&&w.rec.blob)audioPath=w.rec.path||(w.rec.path=await wzUpload('submission',w.rec.blob,w.rec.mime,WZ_AUDIO_EXT[w.rec.mime]||'webm'));
    if(w.mode==='upload'&&w.file)filePath=w.file.path||(w.file.path=await wzUpload('file',w.file.blob,WZ_FILE_TYPES[w.file.ext],w.file.ext));
    if(w.mode==='upload'&&w.gdoc)filePath=w.gdoc.link;
    await wzSaveDiscovery().catch(e=>console.error('Discovery save:',e));   // retry; never blocks the submission
    const selected=w.choice==='selected'?[...w.pillars].sort((a,b)=>a-b):[];
    let pillars=selected,autoTagged=false,summary='';
    try{   // one server call: summarize + (for "not sure yet") auto-pick pillars. The Anthropic key stays on the server.
      const r=await api('/api/summarize',{text:content,selectedPillars:selected,noTag:w.choice==='something_else',contributionType:w.ctype.trim(),attachments});
      if(r.attachmentsSkipped)showToast('Image analysis unavailable — analyzed text only');
      if(Array.isArray(r.pillars)&&r.pillars.length){pillars=r.pillars;autoTagged=!!r.autoTagged;}
      if(r.summary)summary=r.summary;
    }catch(e){console.error('AI processing:',e);showToast('AI analysis: '+(e.message||'error'));}
    if(!summary)summary=content.slice(0,200)+(content.length>200?'…':'');
    const wasTest=w.isTest;
    if(!w.anonymous&&!S.participantName)await saveParticipantName(S.displayName);
    const {error}=await sb.rpc('submit_submission',{p_pillars:pillars,p_content:content,p_summary:summary,p_auto_tagged:autoTagged,p_is_test:w.isTest,p_anonymous:w.anonymous,
      p_contribution_type:w.ctype.trim()||null,p_input_mode:w.mode,p_pillar_choice:w.choice,p_audio_url:audioPath,p_file_url:filePath,p_file_name:fileName,p_discovery_input_id:w.dId});
    if(error)throw error;
    wzReset();W.step=8;W.confirmed=true;W.focusTitle=true;
    S.displayName=S.participantName;
    await refresh();render();window.scrollTo(0,0);
    showToast(wasTest?'Test submission saved':'Your voice has been added to the fire');
  }catch(e){w.submitting=false;render();alert('Error: '+(e.message||e.code||'could not save'));}}

// ---------- step 8: confirmation + history ----------
function wzMine(){return S.submissions.filter(s=>s.mine);}
function wzStep8(){
  const hero=W.confirmed?`<div class="wz-confirm"><i class="ti ti-flask" aria-hidden="true"></i>${wzTitle('Your voice is in the lab now')}
    <p>Your contribution will be part of the synthesis that shapes how humans and AI coexist — starting at Burning Man.</p></div>`
    :`${wzTitle('Your submissions')}`;
  const rows=wzMine().map(wzHistoryRow).join('')||'<p class="wz-help">Nothing here yet.</p>';
  return `${hero}<h3 class="wz-sub">Your submissions</h3><div class="wz-history">${rows}</div>
    <div class="wz-nav"><span></span><button type="button" class="btn btn-amber" onclick="wzNewSubmission()">+ Submit another</button></div>`;}
function wzHistoryRow(s){
  const pills=(s.pillars||[]).map(id=>PILLARS.find(p=>p.id===id)).filter(Boolean).map(p=>`<span class="pill">${p.emoji} ${esc(p.name)}</span>`).join('')
    ||(s.pillarChoice==='something_else'?'<span class="pill">Something else entirely</span>':'');
  const when=s.timestamp?new Date(s.timestamp).toLocaleDateString():'';
  const meta=`<div class="submission-meta">${when}${s.isTest?' · <span class="test-badge">test</span>':''}${s.contributionType?` · ${esc(s.contributionType)}`:''}</div>`;
  if(W.editId===s.id)return `<div class="wz-hrow editing" data-id="${esc(s.id)}">${meta}<div class="submission-pills">${pills}</div>
    <label class="wz-label" for="edit-text">Your original text</label><textarea id="edit-text" rows="8">${esc(W.editText)}</textarea>
    ${s.inputMode&&s.inputMode!=='text'?`<p class="wz-help">You’re editing the text of this ${s.inputMode==='voice'?'recording':'upload'}. The original ${s.inputMode==='voice'?'audio':'file'} stays attached.</p>`:''}
    <label class="wz-label" for="edit-type">Type of contribution</label><input type="text" id="edit-type" maxlength="120" value="${esc(W.editType)}">
    <p class="wz-help">When you save, the AI summary is re-run on your new text.</p>
    <div class="wz-nav"><button type="button" class="btn-ghost" onclick="wzEditCancel()" ${W.editBusy?'disabled':''}>Cancel</button><button type="button" class="btn btn-amber" onclick="wzEditSave()" ${W.editBusy?'disabled':''}>${W.editBusy?'Saving…':'Save changes'}</button></div></div>`;
  // Buttons carry only the row id and a kind; the path is looked up in state, never pasted into an attribute.
  const media=[s.audioUrl?`<button type="button" class="raw-toggle" onclick="wzOpenStored('${esc(s.id)}','audio')">Play recording</button>`:'',
    s.fileUrl?`<button type="button" class="raw-toggle" onclick="wzOpenStored('${esc(s.id)}','file')">${/^https:/.test(s.fileUrl)?'Open link':'Open file'}</button>`:''].filter(Boolean).join(' · ');
  return `<div class="wz-hrow" data-id="${esc(s.id)}">${meta}<div class="submission-pills">${pills}</div>
    <p class="wz-hsum">${esc(wzClip(s.summary||'Summary pending…',180))}</p>
    <div class="wz-hactions">${s.content!=null?`<button type="button" class="btn-ghost" onclick="wzEditStart('${esc(s.id)}')">Edit</button>`:''}${media}</div></div>`;}
function wzEditStart(id){wzSyncFields();const s=S.submissions.find(x=>x.id===id);if(!s)return;W.editId=id;W.editText=s.content||'';W.editType=s.contributionType||'';render();}
function wzEditCancel(){W.editId=null;render();}
async function wzEditSave(){
  wzSyncFields();
  const s=S.submissions.find(x=>x.id===W.editId);if(!s||W.editBusy)return;
  const text=W.editText.trim();
  if(!text)return alert('Your submission can’t be empty.');
  if(text.length>MAX_CONTENT_CHARS)return alert('That is too long. The limit is '+MAX_CONTENT_CHARS.toLocaleString()+' characters.');
  W.editBusy=true;render();
  try{
    const r=await api('/api/summarize',{text,selectedPillars:s.pillars||[],noTag:true,contributionType:W.editType.trim()});
    if(!r.summary)throw new Error('The AI summary came back empty — please try again.');
    const {data,error}=await sb.rpc('update_my_submission',{p_id:s.id,p_content:text,p_summary:r.summary,p_contribution_type:W.editType.trim()||null});
    if(error)throw error;
    if(!data){alert('Could not save — this submission is not yours, or it is gone.');}
    else showToast('Saved — summary refreshed');
    W.editId=null;W.editBusy=false;await refresh();render();
  }catch(e){W.editBusy=false;render();alert('Error: '+(e.message||'could not save'));}}
async function wzOpenStored(id,kind){
  const s=S.submissions.find(x=>x.id===id),path=kind==='audio'?s?.audioUrl:s?.fileUrl;
  if(!path)return;
  if(/^https:\/\//.test(path)){window.open(path,'_blank','noopener');return;}
  const tab=window.open('','_blank');   // opened first so the browser's pop-up blocker allows it
  const {data,error}=await sb.storage.from(WZ_BUCKET).createSignedUrl(path,120);
  if(error||!data?.signedUrl){tab?.close();return showToast('Could not open that file.');}
  if(tab)tab.location.href=data.signedUrl;else showToast('Allow pop-ups for this site to open files.');}
