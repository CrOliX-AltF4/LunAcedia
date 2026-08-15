import { CONNECTOR_REGISTRY } from "../connectors/connector_registry.js";

/** Inline HTML for the LunAcedia web dashboard served at GET /. */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LunAcedia</title>
<style>
/* Palette pulled from the Lun ecosystem's shared identity sheet (LunAnima repo,
   docs/lun-identity-tokens.md) — LunAcedia keeps its own variable names for its own
   concepts (urgent/normal/info priority), but the hex values are the shared ones so
   this dashboard and the Natsume panel read as one system. */
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
    <div class="tier-row"><span>Répondre à un email</span><select data-tier="reply"><option value="auto">Auto</option><option value="confirm">Confirmation</option><option value="manual">Manuel</option></select></div>
    <div class="tier-row"><span>Compléter une tâche</span><select data-tier="complete"><option value="auto">Auto</option><option value="confirm">Confirmation</option><option value="manual">Manuel</option></select></div>
    <div class="tier-row"><span>Modifier un événement</span><select data-tier="update"><option value="auto">Auto</option><option value="confirm">Confirmation</option><option value="manual">Manuel</option></select></div>

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

<header>
  <h1>◆ LunAcedia</h1>
  <span id="badge">0</span>
  <div class="spacer"></div>
  <button onclick="openProposals()">Propositions</button>
  <button onclick="openDigest()">Digest</button>
  <button onclick="openSettings()">⚙ Réglages</button>
  <button onclick="markAll()">Mark all read</button>
</header>

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
    const r=await req('/api/events?limit=100');
    if(!r.ok)return;
    events=(await r.json()).events||[];
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
  \${e.body?'<div class="card-body">'+esc(e.body)+'</div>':''}
  <div class="card-time">\${ago(e.ts)}</div>
</div>\`).join('');
}

async function toggle(el){
  const key=el.dataset.key;
  el.classList.toggle('open');
  if(el.classList.contains('unread')){
    el.classList.remove('unread');
    const ev=events.find(e=>e.dedupeKey===key);
    if(ev)ev.read=true;
    render();
    await req('/api/events/'+encodeURIComponent(key)+'/read',{method:'POST'}).catch(()=>{});
  }
}

async function markAll(){
  events.forEach(e=>e.read=true);
  render();
  await req('/api/events/read-all',{method:'POST'}).catch(()=>{});
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
function openDigest(){openDigestLike('/api/digest','Digest');}
function openProposals(){openDigestLike('/api/proposals','Propositions');}
function closeDigest(){document.getElementById('digest').classList.remove('open');}

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
  if(a.action.kind==='reply')return 'Répondre : '+esc(a.action.body||'').slice(0,60);
  if(a.action.kind==='complete')return 'Compléter la tâche '+esc(a.action.sourceId);
  if(a.action.kind==='update')return 'Modifier l\\'événement '+esc(a.action.sourceId);
  return 'Action '+esc(a.action.kind);
}

function renderPending(pending){
  const el=document.getElementById('pending');
  if(!pending.length){el.className='empty';el.innerHTML='';return;}
  el.className='';
  // id passed via data-id + this, never interpolated straight into onclick as a JS string
  // argument — see dashboard.test.ts's toggle()/dedupeKey regression guard for why.
  el.innerHTML=pending.map(p=>\`
<div class="pending-row" data-id="\${esc(p.id)}">
  <span>\${describeAction(p)}</span>
  <button class="confirm" onclick="confirmPending(this)">Confirmer</button>
  <button class="cancel" onclick="cancelPending(this)">Annuler</button>
</div>\`).join('');
}

async function confirmPending(btn){
  const id=btn.closest('.pending-row').dataset.id;
  await req('/api/actions/'+encodeURIComponent(id)+'/confirm',{method:'POST'}).catch(()=>{});
  loadPending();
}
async function cancelPending(btn){
  const id=btn.closest('.pending-row').dataset.id;
  await req('/api/actions/'+encodeURIComponent(id)+'/cancel',{method:'POST'}).catch(()=>{});
  loadPending();
}

// ── Settings (sources / tiers / email rules) ─────────────────────────────────
const GOOGLE_SOURCES=[{key:'gmail',label:'Gmail'},{key:'gcal',label:'Google Calendar'},{key:'gtasks',label:'Google Tasks'}];

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
    for(const k in tiers){
      const sel=document.querySelector('select[data-tier="'+k+'"]');
      if(sel)sel.value=tiers[k];
    }
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
    if(r.ok){hideAuth();events=(await r.json()).events||[];render();loadPending();}
  }catch(e){console.error(e);}
})();

setInterval(load,15000);
setInterval(loadPending,15000);
</script>
</body>
</html>`;
