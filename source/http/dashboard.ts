/** Inline HTML for the LunAcedia web dashboard served at GET /. */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LunAcedia</title>
<style>
:root{--bg:#0f0f11;--surface:#1a1a1d;--border:#2a2a2e;--text:#e8e8ec;--muted:#6b6b74;--urgent:#ff4455;--normal:#4488ff;--info:#7777aa;--accent:#c8a415}
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
.pri-urgent{background:#ff445522;color:var(--urgent)}
.pri-normal{background:#4488ff22;color:var(--normal)}
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
    <h3>Digest</h3>
    <div id="digest-text">Loading…</div>
    <button id="digest-close" onclick="closeDigest()">Close</button>
  </div>
</div>

<header>
  <h1>◆ LunAcedia</h1>
  <span id="badge">0</span>
  <div class="spacer"></div>
  <button onclick="openDigest()">Digest</button>
  <button onclick="markAll()">Mark all read</button>
</header>

<div id="filters">
  <span class="chip active" data-f="all">All</span>
  <span class="chip" data-f="urgent">Urgent</span>
  <span class="chip" data-f="normal">Normal</span>
  <span class="chip" data-f="info">Info</span>
  <span class="chip" data-f="github">GitHub</span>
  <span class="chip" data-f="email">Email</span>
  <span class="chip" data-f="calendar">Calendar</span>
  <span class="chip" data-f="tasks">Tasks</span>
  <span class="chip" data-f="rss">RSS</span>
  <span class="chip" data-f="ha">Home Assistant</span>
</div>

<div id="list"></div>
<div id="empty">No events yet.</div>

<script>
const ICONS={github:'⎇',email:'✉',calendar:'📅',tasks:'✓',rss:'◉',ha:'⌂',system:'⚙'};
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
<div class="card\${!e.read?' unread':''}" data-key="\${e.dedupeKey}" onclick="toggle(this,'\${e.dedupeKey.replace(/'/g,"\\\\'")}')">
  <div class="card-top">
    <span class="src">\${ICONS[e.source]||'●'} \${e.source}</span>
    <span class="pri pri-\${e.priority}">\${e.priority}</span>
  </div>
  <div class="card-title">\${e.title}</div>
  \${e.body?'<div class="card-body">'+e.body+'</div>':''}
  <div class="card-time">\${ago(e.ts)}</div>
</div>\`).join('');
}

async function toggle(el,key){
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

async function openDigest(){
  const d=document.getElementById('digest');
  const t=document.getElementById('digest-text');
  d.classList.add('open');
  t.textContent='Loading…';
  try{
    const r=await req('/api/digest');
    const data=await r.json();
    t.textContent=data.response||data.error||'No response';
  }catch(e){t.textContent='Error: '+e.message;}
}
function closeDigest(){document.getElementById('digest').classList.remove('open');}

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
    if(r.ok){hideAuth();events=(await r.json()).events||[];render();}
  }catch(e){console.error(e);}
})();

setInterval(load,15000);
</script>
</body>
</html>`;
