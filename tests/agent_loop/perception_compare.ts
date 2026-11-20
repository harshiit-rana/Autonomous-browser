/**
 * Step 0 of #225: measure the perception implementations on the same fixture pages, inside real Electron.
 *   (a) iframes (same- and cross-origin), (b) shadow DOM (open, nested), (c) visibility and occlusion, (d) stable ids,
 *   plus (e) whether page headings/text reach the model at all.
 * Run: npx tsx tests/agent_loop/run_suite.ts perception_compare  (writes docs/audits/evidence/225/step0/perception_compare.json)
 */
import { BrowserWindow } from 'electron';
import { WebArenaServer } from '../../src/testing/arena_server.js';
import { PerceptionEngine } from '../../src/agent/perception.js';
import { AXTreeExtractor } from '../../attic/perception/axtree_extractor.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function load(win: BrowserWindow, url: string) {
`);
  await win.webContents.loadURL(url);
  await sleep(700);
}

function flatten(node: any, out: any[] = []): any[] {
  if (!node) return out;
  out.push(node);
  for (const c of node.children || []) flatten(c, out);
  return out;
}

export async function run() {
`);
  const arena = new WebArenaServer();
  const port = await arena.start(0);
  const base = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({ width: 1000, height: 760, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  const results: Record<string, any> = {};

  const impls: Record<string, (url: string) => Promise<{ names: string[]; text: string; idOf: (name: string) => string | undefined; raw: any }>> = {
    'agent/perception.ts': async () => {
      const s = await PerceptionEngine.captureSnapshot(win.webContents, false);
      const els = Array.from(s.elements.values()) as any[];
      return {
        names: els.map(e => e.name),
        text: s.formattedTree + '\n' + ((s as any).pageText || ''),
        idOf: (n: string) => els.find(e => e.name.includes(n))?.ref,
        raw: els.map(e => ({ ref: e.ref, name: e.name, occluded: e.occludedBy })).slice(0, 40)
      };
    },
    'perception/axtree_extractor.ts': async () => {
      const raw = await win.webContents.executeJavaScript(AXTreeExtractor.DOM_AX_EXTRACTOR_SCRIPT);
      const pruned = AXTreeExtractor.pruneTree(raw);
      const nodes = flatten(pruned.root);
      return {
        names: nodes.map(n => n.name || '').filter(Boolean),
        text: pruned.semanticText,
        idOf: (n: string) => nodes.find(x => (x.name || '').includes(n))?.nodeId,
        raw: pruned.semanticText.slice(0, 1500)
      };
    }
  };

  for (const [impl, snap] of Object.entries(impls)) {
    const r: Record<string, any> = {};
    await load(win, `${base}/agent/frames`);
    const f = await snap('');
    r.iframeSameOrigin_frameButtonFound = f.names.some(n => n.includes('Frame button'));
    r.iframeSameOrigin_textFound = f.text.includes('42891');
    r.shadowDom_buttonFound = f.names.some(n => n.includes('Shadow button'));
    r.shadowDom_nestedLinkFound = f.names.some(n => n.includes('Deep shadow link'));
    r.hidden_displayNoneExcluded = !f.names.some(n => n.includes('Hidden button'));
    r.hidden_visibilityHiddenExcluded = !f.names.some(n => n.includes('Cloaked button'));
    r.framesRaw = f.raw;

    await load(win, `${base}/agent/occlusion`);
    const o = await snap('');
    r.occlusion_coveredButtonFlagged = /occluded/i.test(o.text) || (Array.isArray(o.raw) && o.raw.some((e: any) => e.occluded));
    r.occlusionRaw = o.raw;

    await load(win, `${base}/agent/stale`);
    const s1 = await snap('');
    const before = s1.idOf('Rebuild list');
    await win.webContents.executeJavaScript(`document.body.insertBefore(Object.assign(document.createElement('button'),{textContent:'Inserted first'}), document.body.firstChild)`);
    const s2 = await snap('');
    const after = s2.idOf('Rebuild list');
    r.stableIds_sameIdAfterInsertBefore = Boolean(before) && before === after;
    r.stableIds_detail = { before, after };

    await load(win, `${base}/`);
    const h = await snap('');
    r.heading_reachesModel = h.text.includes('Project Aegis Web Arena');
    results[impl] = r;
  }

  win.destroy();
  await arena.stop();
  return { measuredAt: new Date().toISOString(), electron: process.versions.electron, results };
}
