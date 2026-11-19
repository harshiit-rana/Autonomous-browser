/**
 * Fixture pages for the single-agent tool surface (issue #225, RUN-03). Served by `WebArenaServer` under `/agent/*`.
 * Every page reports what happened to it in a visible `#out` element (and `window.__events`), so a test can check the
 * page's own state instead of trusting the tool's return value.
 */
import type * as http from 'node:http';

const page = (title: string, body: string, script = '') => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:16px} .box{padding:8px;border:1px solid #888;margin:8px 0}
#menu-panel{display:none} #menu:hover #menu-panel,#menu.open #menu-panel{display:block}
[role=listbox]{list-style:none;padding:0;margin:0;border:1px solid #666;width:160px}
[role=option]{padding:4px} [role=option][aria-selected=true]{background:#cde}
#zone{width:220px;height:80px;border:2px dashed #555} #card{width:120px;padding:8px;background:#fd8;cursor:move}
#cover{position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.4)}
</style></head>
<body>${body}
<p id="out" aria-live="polite">idle</p>
<script>window.__events=[];function report(t){window.__events.push(t);document.getElementById('out').textContent=t;}${script}</script>
</body></html>`;

const PAGES: Record<string, () => string> = {
  '/agent': () => page('Agent Tool Arena', `<h1>Agent Tool Arena</h1>
<ul>
<li><a href="/agent/select">Select</a></li><li><a href="/agent/hover">Hover</a></li><li><a href="/agent/drag">Drag</a></li>
<li><a href="/agent/nav/a">Navigation A</a></li><li><a href="/agent/tabs">Tabs</a></li><li><a href="/agent/upload">Upload</a></li>
<li><a href="/agent/dialog">Dialogs</a></li><li><a href="/agent/occlusion">Occlusion</a></li><li><a href="/agent/stale">Stale refs</a></li>
<li><a href="/agent/stuck">Stuck</a></li>
</ul>`),

  '/agent/select': () => page('Select Fixture', `<h1>Choose options</h1>
<label for="size">Shirt size</label>
<select id="size" name="size"><option value="">--</option><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
<div class="box">
  <span id="color-label">Colour</span>
  <div id="color" role="combobox" tabindex="0" aria-labelledby="color-label" aria-haspopup="listbox" aria-expanded="false" aria-controls="color-list" class="box">Pick a colour</div>
  <ul id="color-list" role="listbox" hidden>
    <li role="option" id="c-red" aria-selected="false">Red</li>
    <li role="option" id="c-green" aria-selected="false">Green</li>
    <li role="option" id="c-blue" aria-selected="false">Blue</li>
  </ul>
</div>`, `
document.getElementById('size').addEventListener('change',e=>report('size='+e.target.value));
const cb=document.getElementById('color'),lb=document.getElementById('color-list');
cb.addEventListener('click',()=>{lb.hidden=!lb.hidden;cb.setAttribute('aria-expanded',String(!lb.hidden));});
lb.querySelectorAll('[role=option]').forEach(o=>o.addEventListener('click',()=>{
  lb.querySelectorAll('[role=option]').forEach(x=>x.setAttribute('aria-selected','false'));
  o.setAttribute('aria-selected','true');cb.textContent=o.textContent;lb.hidden=true;cb.setAttribute('aria-expanded','false');
  report('color='+o.textContent);}));`),

  '/agent/hover': () => page('Hover Fixture', `<h1>Hover menu</h1>
<div id="menu" class="box"><span id="menu-title">Account menu (hover me)</span>
  <div id="menu-panel"><a href="/agent/nav/b" id="secret-link">Secret settings</a></div>
</div>`, `
const m=document.getElementById('menu');
m.addEventListener('mouseenter',()=>{m.classList.add('open');report('hovered');});`),

  '/agent/drag': () => page('Drag Fixture', `<h1>Drag the card</h1>
<div id="card" draggable="true" role="button" aria-label="Drag card">Card A</div>
<div id="zone" role="region" aria-label="Drop zone" tabindex="0">Drop here</div>`, `
const card=document.getElementById('card'),zone=document.getElementById('zone');
card.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain','card-a');});
zone.addEventListener('dragover',e=>e.preventDefault());
zone.addEventListener('drop',e=>{e.preventDefault();zone.textContent='Dropped: '+e.dataTransfer.getData('text/plain');report('dropped '+e.dataTransfer.getData('text/plain'));});`),

  '/agent/nav/a': () => page('Page A', `<h1>Page A</h1><a id="to-b" href="/agent/nav/b">Go to page B</a>`),
  '/agent/nav/b': () => page('Page B', `<h1>Page B</h1><a id="to-a" href="/agent/nav/a">Go to page A</a>`),

  '/agent/tabs': () => page('Tabs Fixture', `<h1>Tabs</h1>
<a id="popup-link" href="/agent/nav/b" target="_blank">Open page B in a new tab</a>`),

  '/agent/upload': () => page('Upload Fixture', `<h1>Upload a file</h1>
<label for="file">Attachment</label><input id="file" type="file">`, `
document.getElementById('file').addEventListener('change',async e=>{const f=e.target.files[0];
  const t=f?await f.text():'';report('file='+(f?f.name:'none')+' bytes='+(f?f.size:0)+' text='+t.slice(0,40));});`),

  '/agent/dialog': () => page('Dialog Fixture', `<h1>Dialogs</h1>
<button id="confirm-btn">Discard draft</button><button id="alert-btn">Show notice</button>`, `
document.getElementById('confirm-btn').addEventListener('click',()=>{const ok=confirm('Discard the draft?');report('confirm='+ok);});
document.getElementById('alert-btn').addEventListener('click',()=>{alert('Saved!');report('alert-closed');});`),

  '/agent/occlusion': () => page('Occlusion Fixture', `<h1>Covered button</h1>
<button id="under">Under the cover</button><div id="cover"></div>`),

  '/agent/stale': () => page('Stale Fixture', `<h1>Disappearing button</h1>
<div id="holder"><button id="vanish">Vanish</button></div><button id="rebuild">Rebuild list</button>`, `
document.getElementById('vanish').addEventListener('click',e=>{e.target.remove();report('vanished');});
document.getElementById('rebuild').addEventListener('click',()=>{document.getElementById('holder').innerHTML='';report('rebuilt');});`),

  '/agent/frames': () => page('Frames Fixture', `<h1>Frames and shadow roots</h1>
<iframe id="same" src="/agent/frame-inner" width="320" height="90"></iframe>
<iframe id="cross" width="320" height="90"></iframe>
<div id="host"></div>
<button id="hidden-btn" style="display:none">Hidden button</button>
<button id="cloaked-btn" style="visibility:hidden">Cloaked button</button>`, `
const sr=document.getElementById('host').attachShadow({mode:'open'});
sr.innerHTML='<button id="shadow-btn">Shadow button</button><div id="inner-host"></div>';
sr.getElementById('shadow-btn').addEventListener('click',()=>report('shadow clicked'));
sr.getElementById('inner-host').attachShadow({mode:'open'}).innerHTML='<a href="#deep" id="deep-link">Deep shadow link</a>';
document.getElementById('cross').src='http://localhost:'+location.port+'/agent/nav/a';`),

  '/agent/frame-inner': () => `<!DOCTYPE html><html><body><p>Frame paragraph: code 42891</p>
<button id="frame-btn" onclick="parent.report('frame clicked')">Frame button</button></body></html>`,

  '/agent/stuck': () => page('Stuck Fixture', `<h1>Nothing happens</h1><button id="noop">Load more</button>`),

  '/agent/growing': () => page('Growing Fixture', `<h1>Infinite feed</h1><div id="feed"></div><button id="more">More</button>`, `
let n=0;const feed=document.getElementById('feed');
function add(){for(let i=0;i<20;i++){const p=document.createElement('p');p.textContent='Feed item '+(++n)+' lorem ipsum dolor sit amet consectetur';feed.appendChild(p);}}
add();document.getElementById('more').addEventListener('click',add);`)
};

/** Serves `/agent/*`; returns false when the path is not an agent fixture. */
export function handleAgentFixture(pathname: string, res: http.ServerResponse): boolean {
  const render = PAGES[pathname.replace(/\/$/, '') || pathname];
  if (!render) return false;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(render());
  return true;
}
