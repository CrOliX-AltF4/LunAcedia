import { CONNECTOR_REGISTRY } from "../connectors/connector_registry.js";

/** Inline HTML for the LunAcedia web dashboard served at GET /. */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LunAcedia</title>
<style>
/* Palette pulled from the Lun ecosystem's shared identity sheet — LunAcedia keeps its own variable names for its own
   concepts (urgent/normal/info priority), but the hex values are the shared ones so
   this dashboard and a hub's panel read as one system. */
:root{--bg:#0d0f14;--surface:#111827;--border:#1e2330;--text:#d1d5db;--muted:#9ca3af;--urgent:#f87171;--normal:#b9945a;--info:#9ca3af;--accent:#b9945a}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif;min-height:100vh}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10}
header h1{font-size:15px;font-weight:600;color:var(--accent);letter-spacing:.5px}
#badge{background:var(--urgent);color:#fff;border-radius:10px;padding:2px 8px;font-size:12px;font-weight:700;display:none}
.spacer{flex:1}
button{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;transition:border-color .15s}
button:hover{border-color:var(--accent);color:var(--accent)}
#filters{padding:10px 20px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border)}
.chip{background:var(--surface);border:1px solid var(--border);padding:3px 12px;border-radius:14px;cursor:pointer;font-size:12px;transition:border-color .15s,color .15s}
.chip:hover,.chip.active{border-color:var(--accent);color:var(--accent)}
#list{padding:12px 20px;display:flex;flex-direction:column;gap:8px;max-width:900px}
.card{background:var(--surface);border:1px solid var(--border);border-left:3px solid transparent;border-radius:8px;padding:12px 16px;cursor:pointer;transition:border-color .15s}
.card:hover{border-color:#444}
.card.unread{border-left-color:var(--accent)}
.card-top{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.src{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.pri{font-size:11px;padding:1px 6px;border-radius:4px;font-weight:600}
.pri-urgent{background:#f8717122;color:var(--urgent)}
.pri-normal{background:#b9945a22;color:var(--normal)}
.pri-info{color:var(--info)}
.card-title{font-size:14px;font-weight:500}
.card-body{font-size:13px;color:var(--muted);margin-top:6px;display:none;line-height:1.6}
.card.open .card-body{display:block}
.card-time{font-size:11px;color:var(--muted);margin-top:4px}
.card-actions{display:none;gap:6px;margin-top:8px}
.card.open .card-actions{display:flex}
.card-actions button{padding:3px 10px;font-size:12px}
.trash-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)}
.trash-row span{flex:1;font-size:13px}
.topic-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer}
.topic-row span{flex:1;font-size:13px}
.topic-row small,.topic-msg small{color:var(--muted)}
.topic-msg{padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;white-space:pre-wrap}
#empty{color:var(--muted);text-align:center;padding:60px 20px;display:none}
/* auth overlay */
#auth{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100}
#auth-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;width:320px}
#auth-box h2{font-size:15px;margin-bottom:4px}
#auth-box p{font-size:12px;color:var(--muted);margin-bottom:14px}
#auth-box input{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:14px;margin-bottom:12px}
/* digest modal */
#digest{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:100}
#digest.open{display:flex}
#digest-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:560px;width:90%;max-height:80vh;overflow-y:auto}
#digest-box h3{color:var(--accent);margin-bottom:12px}
#digest-text{font-size:14px;line-height:1.7;white-space:pre-wrap}
#digest-close{margin-top:14px}
/* command bar */
#cmdbar{padding:10px 20px;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border)}
#cmd-input{flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:13px;font-family:inherit}
#cmd-input:focus{outline:none;border-color:var(--accent)}
#cmd-status{font-size:12px;color:var(--muted);white-space:nowrap}
/* pending actions */
#pending{padding:0 20px;max-width:900px}
#pending.empty{display:none}
.pending-row{background:var(--surface);border:1px solid var(--accent);border-radius:8px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px}
.pending-row span{flex:1;font-size:13px}
.pending-row button{padding:4px 12px;font-size:12px}
.pending-row .confirm{border-color:var(--accent);color:var(--accent)}
.pending-row .cancel{color:var(--urgent)}
/* settings modal */
#settings{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:100}
#settings.open{display:flex}
#settings-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:560px;width:90%;max-height:85vh;overflow-y:auto}
#settings-box h3{color:var(--accent);margin-bottom:14px}
#settings-box h4{font-size:13px;color:var(--muted);margin:18px 0 8px;text-transform:uppercase;letter-spacing:.5px}
#settings-box h4:first-of-type{margin-top:0}
.src-row{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:13px}
.src-row .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
.src-row .dot.on{background:#4ade80}
.src-row span{flex:1}
.tier-row{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px}
.tier-row span{flex:1}
select,textarea{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;font-family:inherit}
textarea{width:100%;min-height:52px;margin-bottom:10px;resize:vertical}
.field-hint{font-size:11px;color:var(--muted);margin:-6px 0 8px}
#settings-save{margin-top:14px}
#settings-status{font-size:12px;color:var(--accent);margin-left:10px}
#ai-banner{display:none;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--urgent);border-radius:8px;margin:10px 20px;padding:10px 16px;font-size:13px}
#ai-banner button{border-color:var(--accent);color:var(--accent)}
#ai-setup{position:fixed;inset:0;background:rgba(0,0,0,.7);display:none;align-items:center;justify-content:center;z-index:100}
#ai-setup.open{display:flex}
#ai-setup-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:420px;width:90%}
#ai-setup-box h3{color:var(--accent);margin-bottom:14px}
#ai-setup-box select,#ai-setup-box input{width:100%;margin-bottom:12px}
#ai-setup-status{font-size:12px;margin-left:8px}
</style>
</head>
<body>

<div id="auth">
  <div id="auth-box">
    <h2>◆ LunAcedia</h2>
    <p>Enter your ACEDIA_SECRET bearer token.</p>
    <input id="tok" type="password" placeholder="Bearer token" />
    <button onclick="login()">Connect</button>
  </div>
</div>

<div id="digest">
  <div id="digest-box">
    <h3 id="digest-title">Digest</h3>
    <div id="digest-text">Loading…</div>
    <button id="digest-close" onclick="closeDigest()">Close</button>
  </div>
</div>

<div id="settings">
  <div id="settings-box">
    <h3>⚙ Réglages</h3>

    <h4>Sources</h4>
    <div id="src-list"></div>

    <h4>Paliers d'autonomie</h4>
    <div class="field-hint">Auto = l'IA agit seule. Confirmation = sur demande explicite ou après proposition. Manuel = jamais l'IA, quoi qu'il arrive.</div>
    <div id="tier-list"></div>

    <h4>Classification email</h4>
    <div class="field-hint">Un par ligne. Expéditeurs/mots-clés VIP et urgents passent en priorité urgente, mots-clés normaux en priorité normale.</div>
    <textarea id="vip-senders" placeholder="boss@corp.com"></textarea>
    <textarea id="urgent-keywords" placeholder="urgent&#10;deadline"></textarea>
    <textarea id="normal-keywords" placeholder="newsletter"></textarea>

    <button id="settings-save" onclick="saveSettings()">Enregistrer</button>
    <span id="settings-status"></span>
    <br><br>
    <button onclick="closeSettings()">Fermer</button>
  </div>
</div>

<div id="ai-setup">
  <div id="ai-setup-box">
    <h3>⚙ Configurer l'IA</h3>
    <div class="field-hint">LunAcedia garde toujours son propre fournisseur IA (chat, digest, propositions, commandes) — le Core ne le fournit plus.</div>
    <select id="ai-provider-select" onchange="onAiProviderChange()">
      <option value="openai">OpenAI</option>
      <option value="ollama">Ollama (local)</option>
    </select>
    <input id="ai-api-key" type="password" placeholder="Clé API OpenAI (sk-...)" />
    <input id="ai-ollama-url" type="text" placeholder="http://localhost:11434" style="display:none" />
    <button onclick="saveAiProvider()">Enregistrer</button>
    <span id="ai-setup-status"></span>
    <br><br>
    <button onclick="closeAiSetup()">Fermer</button>
  </div>
</div>

<header>
  <h1>◆ LunAcedia</h1>
  <span id="badge">0</span>
  <div class="spacer"></div>
  <button onclick="openProposals()">Propositions</button>
  <button onclick="openFreeSlots()">Créneaux libres</button>
  <button onclick="openDigest()">Digest</button>
  <button onclick="openSettings()">⚙ Réglages</button>
  <button onclick="openTrash()">Corbeille</button>
  <button onclick="openTopics()">Sujets</button>
  <button onclick="openUsage()">Dépense LLM</button>
  <button onclick="openDevices()">Appareils</button>
  <button onclick="openAgent()">Agent</button>
</header>

<div id="ai-banner">
  <span>⚠ IA non configurée — chat, digest, propositions et commandes sont désactivés.</span>
  <button onclick="openAiSetup()">Configurer</button>
</div>

<div id="cmdbar">
  <input id="cmd-input" type="text" placeholder="Dis-moi ce qu'il faut faire… (ex. crée une tâche pour rappeler le rendez-vous)" onkeydown="if(event.key==='Enter')sendCommand()" />
  <button onclick="sendCommand()">Envoyer</button>
  <span id="cmd-status"></span>
</div>

<div id="filters">
  <span class="chip active" data-f="all">All</span>
  <span class="chip" data-f="urgent">Urgent</span>
  <span class="chip" data-f="normal">Normal</span>
  <span class="chip" data-f="info">Info</span>
  <span class="chip" data-f="github">${CONNECTOR_REGISTRY.github.label}</span>
  <span class="chip" data-f="email">${CONNECTOR_REGISTRY.email.label}</span>
  <span class="chip" data-f="calendar">${CONNECTOR_REGISTRY.calendar.label}</span>
  <span class="chip" data-f="tasks">${CONNECTOR_REGISTRY.tasks.label}</span>
  <span class="chip" data-f="rss">${CONNECTOR_REGISTRY.rss.label}</span>
  <span class="chip" data-f="ha">${CONNECTOR_REGISTRY.ha.label}</span>
</div>

<div id="pending" class="empty"></div>
<div id="list"></div>
<div id="empty">No events yet.</div>

<script>
const ICONS={github:'⎇',email:'✉',calendar:'📅',tasks:'✓',rss:'◉',ha:'⌂',system:'⚙'};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let tok=sessionStorage.getItem('at')||'';
let events=[];
let filter='all';

function ago(ts){const s=Math.floor((Date.now()-ts)/1e3);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}

async function req(path,opts={}){
  const h={'Content-Type':'application/json'};
  if(tok)h['Authorization']='Bearer '+tok;
  const r=await fetch(path,{...opts,headers:h});
  if(r.status===401){showAuth();throw new Error('401');}
  return r;
}

function showAuth(){document.getElementById('auth').style.display='flex';}
function hideAuth(){document.getElementById('auth').style.display='none';}

function login(){
  tok=document.getElementById('tok').value.trim();
  sessionStorage.setItem('at',tok);
  hideAuth();
  load();
}

document.getElementById('tok').addEventListener('keydown',e=>{if(e.key==='Enter')login();});

async function load(){
  try{
    // The box: what is in the inbox at the source, read and unread.
    const r=await req('/api/inbox');
    if(!r.ok)return;
    events=(await r.json()).items||[];
    render();
  }catch(e){if(e.message!=='401')console.error(e);}
}

function render(){
  const shown=events.filter(e=>{
    if(filter==='all')return true;
    if(['urgent','normal','info'].includes(filter))return e.priority===filter;
    return e.source===filter;
  });
  const unread=events.filter(e=>!e.read).length;
  const badge=document.getElementById('badge');
  badge.textContent=unread;
  badge.style.display=unread?'':'none';
  document.title=unread?'('+unread+') LunAcedia':'LunAcedia';
  const list=document.getElementById('list');
  const empty=document.getElementById('empty');
  if(!shown.length){list.innerHTML='';empty.style.display='';return;}
  empty.style.display='none';
  list.innerHTML=shown.map(e=>\`
<div class="card\${!e.read?' unread':''}" data-key="\${esc(e.dedupeKey)}" onclick="toggle(this)">
  <div class="card-top">
    <span class="src">\${ICONS[e.source]||'●'} \${esc(e.source)}</span>
    <span class="pri pri-\${esc(e.priority)}">\${esc(e.priority)}</span>
  </div>
  <div class="card-title">\${esc(e.title)}</div>
  <div class="card-body">\${e.body?esc(e.body):''}</div>
  <div class="card-time">\${ago(e.ts)}</div>
  <div class="card-actions">\${e.source==='email'?'<button data-g="unread" onclick="gesture(this,event)">Non lu</button><button data-g="archive" onclick="gesture(this,event)">Archiver</button><button data-g="trash" onclick="gesture(this,event)">Corbeille</button>':''}\${e.source==='github'?'<button data-g="done" onclick="gesture(this,event)">Terminé</button>':''}\${e.source==='tasks'?'<button data-g="done" onclick="gesture(this,event)">Fait</button>':''}</div>
</div>\`).join('');
}

async function toggle(el){
  const key=el.dataset.key;
  el.classList.toggle('open');
  if(!el.classList.contains('open')||el.dataset.loaded)return;
  // Opening = reading it: the whole text, and it is read at the source.
  try{
    const r=await req('/api/inbox/'+encodeURIComponent(key)+'/open',{method:'POST'});
    if(!r.ok)return;
    const data=await r.json();
    if(data.body!==undefined){
      el.querySelector('.card-body').innerHTML=esc(data.body).replace(/\\n/g,'<br>');
      el.dataset.loaded='1';
    }
    if(data.change==='read'){
      const ev=events.find(e=>e.dedupeKey===key);
      if(ev)ev.read=true;
      el.classList.remove('unread');
    }
  }catch(e){}
}

// Master's gesture on an item — applied at the source; the key comes from the card, never a JS argument.
async function gesture(btn,ev){
  ev.stopPropagation();
  const key=btn.closest('.card').dataset.key;
  const g=btn.dataset.g;
  btn.disabled=true;
  try{
    const r=await req('/api/inbox/'+encodeURIComponent(key)+'/'+g,{method:'POST'});
    if(!r.ok){btn.disabled=false;return;}
  }catch(e){btn.disabled=false;return;}
  load();
}

// Gmail's trash (kept 30 days by Gmail) — ids read from the row, never interpolated into onclick.
async function openTrash(){
  const d=document.getElementById('digest');
  document.getElementById('digest-title').textContent='Corbeille (Gmail, 30 jours)';
  const box=document.getElementById('digest-text');
  d.classList.add('open');
  box.textContent='Loading…';
  try{
    const r=await req('/api/inbox/trash');
    const items=(await r.json()).items||[];
    box.innerHTML=items.length?items.map(t=>\`<div class="trash-row" data-id="\${esc(t.id)}"><span>\${esc(t.title)} — \${esc(t.from)}</span><button onclick="restoreTrash(this)">Restaurer</button></div>\`).join(''):'La corbeille est vide.';
  }catch(e){box.textContent='Error: '+e.message;}
}
async function restoreTrash(btn){
  const row=btn.closest('.trash-row');
  const id=btn.closest('.trash-row').dataset.id;
  btn.disabled=true;
  await req('/api/inbox/trash/'+encodeURIComponent(id)+'/restore',{method:'POST'}).catch(()=>{});
  row.remove();
  setTimeout(load,1500);
}

// Paired devices: each phone has its own token; revoke one and it is refused at once.
// Ids are read from the row, never interpolated into onclick.
async function openDevices(){
  const d=document.getElementById('digest');
  document.getElementById('digest-title').textContent='Appareils appairés';
  const box=document.getElementById('digest-text');
  d.classList.add('open');
  box.textContent='Loading…';
  try{
    const r=await req('/api/devices');
    const data=await r.json();
    const rows=(data.devices||[]).map(x=>\`<div class="trash-row" data-id="\${esc(x.id)}"><span>\${esc(x.name)} <small>— appairé le \${esc(new Date(x.createdAt).toLocaleDateString())}, vu \${esc(ago(Date.parse(x.lastSeenAt)))}\${x.pushToken?' · notifications':''}</small></span><button onclick="revokeDevice(this)">Révoquer</button></div>\`).join('')||'<p><small>Aucun appareil appairé.</small></p>';
    box.innerHTML=rows+\`<p style="margin-top:12px"><button onclick="newPairingCode()">Appairer un appareil</button></p><div id="pairing"></div>
<p><small>Un appareil muet depuis 90 jours est révoqué automatiquement.</small></p>\`;
  }catch(e){box.textContent='Error: '+e.message;}
}
async function newPairingCode(){
  const out=document.getElementById('pairing');
  try{
    const r=await req('/api/devices/pairing-code',{method:'POST'});
    const c=await r.json();
    out.innerHTML=\`<p>Dans l'application : adresse <code>\${esc(location.origin)}</code>, code <strong style="font-size:20px;letter-spacing:3px">\${esc(c.code)}</strong></p><p><small>Valable jusqu'à \${esc(new Date(c.expiresAt).toLocaleTimeString())}, une seule fois.</small></p>\`;
  }catch(e){out.textContent='Error: '+e.message;}
}
async function revokeDevice(btn){
  const row=btn.closest('.trash-row');
  const id=row.dataset.id;
  btn.disabled=true;
  await req('/api/devices/'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{});
  row.remove();
}

// LLM spend: what LunAcedia's own model cost, and the alert paliers — information only, nothing is ever cut.
const CALLER_LABELS={core:'Natsume (Core)',topics:'Sujets du téléphone',api:'API directe',background:'Tâches de fond',unattributed:'Non attribué'};
function usd(n){return (Number(n)||0).toFixed(2)+' $';}
function paliersText(list){return (list||[]).join('/');}
function callerPaliersText(map){return Object.entries(map||{}).map(([c,l])=>c+'='+paliersText(l)).join(', ');}
function parsePaliersInput(s){return String(s||'').split('/').map(x=>Number(x.trim().replace(',','.'))).filter(n=>Number.isFinite(n)&&n>0);}
function parseCallerInput(s){const out={};for(const part of String(s||'').split(',')){const [c,v]=part.split('=').map(x=>(x||'').trim());if(c&&v){const p=parsePaliersInput(v);if(p.length)out[c]=p;}}return out;}
async function openUsage(){
  const d=document.getElementById('digest');
  document.getElementById('digest-title').textContent='Dépense LLM (estimation)';
  const box=document.getElementById('digest-text');
  d.classList.add('open');
  box.textContent='Loading…';
  try{
    const r=await req('/api/usage?days=7');
    const u=await r.json();
    const today=u.days[0]||{totalUsd:0,byCaller:{},calls:0,unpricedCalls:0};
    const byCaller=Object.entries(today.byCaller||{}).map(([c,v])=>\`<div class="topic-msg">\${esc(CALLER_LABELS[c]||c)} : \${esc(usd(v))}</div>\`).join('');
    const week=u.days.map(x=>\`<div class="topic-msg"><small>\${esc(x.day)}</small> \${esc(usd(x.totalUsd))} · \${esc(x.calls)} appels</div>\`).join('');
    const fired=(u.fired||[]).map(a=>\`<div class="topic-msg"><small>\${esc(new Date(a.at).toLocaleString())}</small><br>\${esc(a.title)}</div>\`).join('')||'<div class="topic-msg"><small>Aucune alerte cette semaine.</small></div>';
    const unpriced=today.unpricedCalls?\`<p><small>\${esc(today.unpricedCalls)} appel(s) d'un modèle sans prix connu, hors total.</small></p>\`:'';
    box.innerHTML=\`<p><strong>Aujourd'hui : \${esc(usd(today.totalUsd))}</strong> · \${esc(today.calls)} appels · dernière heure \${esc(usd(u.lastHourUsd))} (habituellement \${esc(usd(u.usualHourlyUsd))}/h)</p>\${unpriced}\${byCaller}
<h4 style="margin-top:12px">7 derniers jours</h4>\${week}
<h4 style="margin-top:12px">Alertes émises</h4>\${fired}
<h4 style="margin-top:12px">Paliers d'alerte (jamais de coupure)</h4>
<label>Par jour (ex. 5/10/20)<input id="ua-daily" type="text"></label>
<label>Par appelant (ex. topics=1/2, core=5)<input id="ua-callers" type="text"></label>
<label>Dépense inhabituelle : facteur (0 = désactivée)<input id="ua-factor" type="number" min="0" step="0.5"></label>
<label>…au-dessus de ($/h)<input id="ua-min" type="number" min="0" step="0.1"></label>
<button onclick="saveUsageAlerts(this)">Enregistrer</button> <span id="ua-status"></span>\`;
    document.getElementById('ua-daily').value=paliersText(u.alerts.dailyUsd);
    document.getElementById('ua-callers').value=callerPaliersText(u.alerts.perCallerUsd);
    document.getElementById('ua-factor').value=u.alerts.spikeFactor;
    document.getElementById('ua-min').value=u.alerts.spikeMinUsd;
  }catch(e){box.textContent='Error: '+e.message;}
}
async function saveUsageAlerts(btn){
  const status=document.getElementById('ua-status');
  btn.disabled=true;
  try{
    const body={
      dailyUsd:parsePaliersInput(document.getElementById('ua-daily').value),
      perCallerUsd:parseCallerInput(document.getElementById('ua-callers').value),
      spikeFactor:Number(document.getElementById('ua-factor').value)||0,
      spikeMinUsd:Number(document.getElementById('ua-min').value)||0,
    };
    const r=await req('/api/config/usage-alerts',{method:'PUT',body:JSON.stringify(body)});
    const data=await r.json();
    status.textContent=r.ok?'Enregistré.':('Refusé : '+(data.error||r.status));
  }catch(e){status.textContent='Error: '+e.message;}
  btn.disabled=false;
}

// The pocket app's topics — read-only here: the phone is where they are used.
// Ids are read from the row, never interpolated into onclick.
async function openTopics(){
  const d=document.getElementById('digest');
  document.getElementById('digest-title').textContent='Sujets (application mobile)';
  const box=document.getElementById('digest-text');
  d.classList.add('open');
  box.textContent='Loading…';
  try{
    const r=await req('/api/conversations');
    const items=(await r.json()).conversations||[];
    box.innerHTML=items.length?items.map(t=>\`<div class="topic-row" data-id="\${esc(t.id)}" onclick="openTopic(this)"><span>\${esc(t.title)}\${t.archived?' <small>(archivé)</small>':''}</span><small>\${esc(t.messageCount)} messages · \${esc(ago(Date.parse(t.updatedAt)))}</small></div>\`).join(''):'Aucun sujet pour le moment.';
  }catch(e){box.textContent='Error: '+e.message;}
}
async function openTopic(row){
  const id=row.dataset.id;
  const box=document.getElementById('digest-text');
  box.textContent='Loading…';
  try{
    const r=await req('/api/conversations/'+encodeURIComponent(id)+'?limit=100');
    const data=await r.json();
    document.getElementById('digest-title').textContent=data.conversation?data.conversation.title:'Sujet';
    const back='<button onclick="openTopics()">← Sujets</button>';
    box.innerHTML=back+(data.messages||[]).map(m=>\`<div class="topic-msg"><small>\${m.role==='user'?'Toi':'Assistant'} · \${esc(new Date(m.at).toLocaleString())}</small><br>\${esc(m.text)}</div>\`).join('');
  }catch(e){box.textContent='Error: '+e.message;}
}

async function openDigestLike(path,title){
  const d=document.getElementById('digest');
  const h=document.getElementById('digest-title');
  const t=document.getElementById('digest-text');
  h.textContent=title;
  d.classList.add('open');
  t.textContent='Loading…';
  try{
    const r=await req(path);
    const data=await r.json();
    t.textContent=data.response||data.proposals||data.error||'No response';
  }catch(e){t.textContent='Error: '+e.message;}
}
async function sendCommand(){
  const input=document.getElementById('cmd-input');
  const status=document.getElementById('cmd-status');
  const text=input.value.trim();
  if(!text)return;
  status.textContent='…';
  try{
    const r=await req('/api/intent',{method:'POST',body:JSON.stringify({text})});
    if(r.status===503){status.textContent="IA non configurée.";return;}
    const data=await r.json();
    if(!data.matched){status.textContent="Je n'ai pas compris de commande.";return;}
    if(data.status==='executed'){status.textContent='✓ Fait.';input.value='';}
    else if(data.status==='pending'){status.textContent='En attente de confirmation.';input.value='';loadPending();}
    else if(data.status==='refused'){status.textContent='Refusé — action manuelle uniquement.';}
    else{status.textContent='Erreur.';}
  }catch(e){status.textContent='Erreur.';}
}

// ── AI provider onboarding ──────────────────────────────────────
function openAiSetup(){document.getElementById('ai-setup').classList.add('open');}
function closeAiSetup(){document.getElementById('ai-setup').classList.remove('open');}
function onAiProviderChange(){
  const p=document.getElementById('ai-provider-select').value;
  document.getElementById('ai-api-key').style.display=p==='openai'?'':'none';
  document.getElementById('ai-ollama-url').style.display=p==='ollama'?'':'none';
}
async function saveAiProvider(){
  const status=document.getElementById('ai-setup-status');
  const provider=document.getElementById('ai-provider-select').value;
  const apiKey=document.getElementById('ai-api-key').value.trim();
  const ollamaUrl=document.getElementById('ai-ollama-url').value.trim();
  status.textContent='…';
  try{
    const r=await req('/api/config/ai-provider',{method:'POST',body:JSON.stringify({provider,apiKey,ollamaUrl})});
    const data=await r.json();
    if(!r.ok){status.textContent=data.error||'Erreur';return;}
    status.textContent='Configuré ✓';
    document.getElementById('ai-banner').style.display='none';
    setTimeout(closeAiSetup,900);
  }catch(e){status.textContent='Erreur';}
}
async function checkAiProvider(){
  try{
    const r=await fetch('/api/health');
    const data=await r.json();
    document.getElementById('ai-banner').style.display=data.ai==='none'?'flex':'none';
  }catch(e){}
}

function openDigest(){openDigestLike('/api/digest','Digest');}
function openProposals(){openDigestLike('/api/proposals','Propositions');}
function closeDigest(){document.getElementById('digest').classList.remove('open');}

function fmtSlot(s){
  const opts={weekday:'short',hour:'2-digit',minute:'2-digit'};
  return new Date(s.start).toLocaleString(undefined,opts)+' → '+new Date(s.end).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
}

async function openFreeSlots(){
  const d=document.getElementById('digest');
  const h=document.getElementById('digest-title');
  const t=document.getElementById('digest-text');
  h.textContent='Créneaux libres (24h, ≥30min)';
  d.classList.add('open');
  t.textContent='Loading…';
  try{
    const r=await req('/api/calendar/free-slots');
    const slots=await r.json();
    t.textContent=Array.isArray(slots)&&slots.length
      ? slots.map(fmtSlot).join('\\n')
      : 'Aucun créneau libre trouvé.';
  }catch(e){t.textContent='Error: '+e.message;}
}

// ── Pending actions ──────────────────────────────────────────────────────────
async function loadPending(){
  try{
    const r=await req('/api/actions/pending');
    if(!r.ok)return;
    const pending=await r.json();
    renderPending(pending);
  }catch(e){if(e.message!=='401')console.error(e);}
}

function describeAction(a){
  const label=(typeof ACTION_KIND_LABELS!=='undefined'&&ACTION_KIND_LABELS[a.action.kind])||a.action.kind;
  const detail=a.action.body||a.action.label||(a.action.fields&&(a.action.fields.title||a.action.fields.summary))||a.action.sourceId||'';
  return esc(label)+(detail?' — '+esc(String(detail)).slice(0,60):'');
}

function renderPending(pending){
  const el=document.getElementById('pending');
  if(!pending.length){el.className='empty';el.innerHTML='';return;}
  el.className='';
  // id passed via data-id + this, never interpolated straight into onclick as a JS string
  // argument — see dashboard.test.ts's toggle()/dedupeKey regression guard for why.
  // A durable list since M5: each write says when it expires, and if a third party's text led to it.
  el.innerHTML=pending.map(p=>\`
<div class="pending-row" data-id="\${esc(p.id)}">
  <span>\${describeAction(p)} <small>— expire à \${esc(new Date(p.expiresAt).toLocaleTimeString())}\${p.untrusted?" · après un texte d'un tiers":''}</small></span>
  <button class="confirm" onclick="confirmPending(this)">Confirmer</button>
  <button class="cancel" onclick="cancelPending(this)">Annuler</button>
</div>\`).join('');
}

async function confirmPending(btn){
  const row=btn.closest('.pending-row');
  const id=row.dataset.id;
  btn.disabled=true;
  try{
    const r=await req('/api/actions/'+encodeURIComponent(id)+'/confirm',{method:'POST'});
    // Hours may have passed: the source or the tier may say no — said, never swallowed.
    if(!r.ok){
      const e=await r.json().catch(()=>({}));
      row.querySelector('span').innerHTML='<strong>Rien n’a été fait</strong> — '+esc(e.error||('HTTP '+r.status));
      return;
    }
  }catch(e){row.querySelector('span').textContent='Erreur : '+e.message;return;}
  loadPending();
}
async function cancelPending(btn){
  const id=btn.closest('.pending-row').dataset.id;
  await req('/api/actions/'+encodeURIComponent(id)+'/cancel',{method:'POST'}).catch(()=>{});
  loadPending();
}

// The agent (law 3): its switch, and its writes. Writes always wait for Master's confirmation
// (tiers), merging a PR stays manual; the phone can only turn the agent off.
async function openAgent(){
  const d=document.getElementById('digest');
  document.getElementById('digest-title').textContent='Agent';
  const box=document.getElementById('digest-text');
  d.classList.add('open');
  box.textContent='Loading…';
  try{
    const r=await req('/api/agent/settings');
    const s=await r.json();
    box.innerHTML=\`<label style="display:block;margin-bottom:10px"><input type="checkbox" id="agent-enabled" \${s.enabled?'checked':''} onchange="setAgent('enabled',this.checked)"> Agent actif <small>— coupé, aucun outil n'est jamais appelé</small></label>
<label style="display:block;margin-bottom:10px"><input type="checkbox" id="agent-writes" \${s.writes?'checked':''} onchange="setAgent('writes',this.checked)"> Écritures <small>— répondre, créer, modifier, supprimer : toujours avec ta confirmation ; fusionner une PR reste manuel</small></label>
<p id="agent-msg"><small></small></p>\`;
  }catch(e){box.textContent='Error: '+e.message;}
}
async function setAgent(key,value){
  const msg=document.getElementById('agent-msg');
  try{
    const r=await req('/api/agent/settings',{method:'PUT',body:JSON.stringify({[key]:value})});
    msg.innerHTML=r.ok?'<small>Enregistré.</small>':'<small>Refusé ('+esc(String(r.status))+').</small>';
  }catch(e){msg.textContent='Erreur : '+e.message;}
}
// End of the agent section

// ── Settings (sources / tiers / email rules) ─────────────────────────────────
const GOOGLE_SOURCES=[{key:'gmail',label:'Gmail'},{key:'gcal',label:'Google Calendar'},{key:'gtasks',label:'Google Tasks'}];

const ACTION_KIND_LABELS={
  reply:'Répondre à un email',
  archive_email:'Archiver un email',
  delete_email:'Supprimer un email',
  mark_email_read:'Marquer un email lu',
  mark_email_unread:'Marquer un email non lu',
  create_event:'Créer un événement calendrier',
  update_event:'Modifier un événement',
  delete_event:'Supprimer un événement',
  create_task:'Créer une tâche',
  complete_task:'Compléter une tâche',
  delete_task:'Supprimer une tâche',
  comment_issue:'Commenter une issue/PR GitHub',
  add_label:'Ajouter un label GitHub',
  create_issue:'Créer une issue GitHub',
  close_issue:'Fermer une issue GitHub',
  open_pr:'Ouvrir une PR GitHub',
  merge_pr:'Merger une PR GitHub',
};

function renderTiers(tiers){
  const el=document.getElementById('tier-list');
  el.innerHTML=Object.keys(ACTION_KIND_LABELS).map(kind=>{
    const label=esc(ACTION_KIND_LABELS[kind]);
    if(kind==='merge_pr'){
      return \`<div class="tier-row"><span>\${label}</span><span style="color:var(--urgent);font-size:12px">Manuel — toujours humain</span></div>\`;
    }
    const value=esc(tiers[kind]||'confirm');
    return \`<div class="tier-row"><span>\${label}</span><select data-tier="\${esc(kind)}"><option value="auto"\${value==='auto'?' selected':''}>Auto</option><option value="confirm"\${value==='confirm'?' selected':''}>Confirmation</option><option value="manual"\${value==='manual'?' selected':''}>Manuel</option></select></div>\`;
  }).join('');
}

async function openSettings(){
  document.getElementById('settings').classList.add('open');
  try{
    const [statusRes,tiersRes,rulesRes]=await Promise.all([
      req('/api/oauth/google/status'),
      req('/api/config/tiers'),
      req('/api/config/email-rules').catch(()=>null),
    ]);
    const status=await statusRes.json();
    renderSources(status);
    const tiers=await tiersRes.json();
    renderTiers(tiers);
    if(rulesRes&&rulesRes.ok){
      const rules=await rulesRes.json();
      document.getElementById('vip-senders').value=(rules.vipSenders||[]).join('\\n');
      document.getElementById('urgent-keywords').value=(rules.urgentKeywords||[]).join('\\n');
      document.getElementById('normal-keywords').value=(rules.normalKeywords||[]).join('\\n');
    }
  }catch(e){console.error(e);}
}
function closeSettings(){document.getElementById('settings').classList.remove('open');}

function renderSources(status){
  const el=document.getElementById('src-list');
  el.innerHTML=GOOGLE_SOURCES.map(s=>\`
<div class="src-row">
  <span class="dot\${status[s.key]?' on':''}"></span>
  <span>\${esc(s.label)} — \${status[s.key]?'connecté':'non connecté'}</span>
  <button onclick="connectSource('\${s.key}')">\${status[s.key]?'Reconnecter':'Connecter'}</button>
</div>\`).join('');
}

function connectSource(key){
  const url='/api/oauth/google/start?connector='+encodeURIComponent(key);
  window.open(url,'_blank','width=520,height=680');
}

async function saveSettings(){
  const statusEl=document.getElementById('settings-status');
  statusEl.textContent='Enregistrement…';
  const tiers={};
  document.querySelectorAll('select[data-tier]').forEach(sel=>{tiers[sel.dataset.tier]=sel.value;});
  const rules={
    vipSenders:document.getElementById('vip-senders').value.split('\\n').map(s=>s.trim()).filter(Boolean),
    urgentKeywords:document.getElementById('urgent-keywords').value.split('\\n').map(s=>s.trim()).filter(Boolean),
    normalKeywords:document.getElementById('normal-keywords').value.split('\\n').map(s=>s.trim()).filter(Boolean),
  };
  try{
    await Promise.all([
      req('/api/config/tiers',{method:'PATCH',body:JSON.stringify(tiers)}),
      req('/api/config/email-rules',{method:'PATCH',body:JSON.stringify(rules)}),
    ]);
    statusEl.textContent='Enregistré ✓';
    setTimeout(()=>{statusEl.textContent='';},2000);
  }catch(e){statusEl.textContent='Erreur';}
}

document.querySelectorAll('.chip').forEach(c=>{
  c.addEventListener('click',()=>{
    document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));
    c.classList.add('active');
    filter=c.dataset.f;
    render();
  });
});

// Initial load — try without token first; if 401, auth overlay appears
(async()=>{
  try{
    const r=await fetch('/api/events?limit=100');
    if(r.status===401){showAuth();return;}
    if(r.ok){hideAuth();events=(await r.json()).events||[];render();loadPending();checkAiProvider();}
  }catch(e){console.error(e);}
})();

setInterval(load,15000);
setInterval(loadPending,15000);
</script>
</body>
</html>`;
