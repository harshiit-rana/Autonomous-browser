import type { WebContents } from 'electron';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('perception');

/**
 * Single perception implementation for the agent loop (issue #225 step 0).
 *
 * Chosen over the orphaned `perception/axtree_extractor.ts` after measuring both on the same fixtures
 * (`docs/audits/evidence/225/step0/perception_compare_*.json`). This version adds what neither had:
 *   - open shadow roots (nested) and same-origin iframes are walked; cross-origin iframes are listed, not entered;
 *   - occlusion: an element whose centre is covered by another element is marked `occludedBy`;
 *   - stable refs: the same element keeps its ref across snapshots of a tab (keyed by id, else by
 *     frame chain + tag + role + name + occurrence), so inserting content above it does not renumber it;
 *   - readable text and headings, so the model can answer questions about content and not only click controls.
 * Nothing is written into the page DOM.
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One hop of an element locator: `d` = top document, `s` = into the previous node's shadowRoot, `f` = into its iframe document. */
export interface LocatorSegment {
  k: 'd' | 's' | 'f';
  p: number[];
}

export interface DiscoveredElement {
  ref: string;
  tagName: string;
  role?: string;
  type?: string;
  name: string;
  value?: string;
  bounds: BoundingBox;
  isClickable: boolean;
  isTextInput: boolean;
  /** Path to the element through shadow roots and frames; resolved again in the page at action time. */
  locator: LocatorSegment[];
  /** Human-readable context: `shadow`, `frame`, or both. */
  context?: string;
  occludedBy?: string;
  offscreen?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  options?: string[];
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: Map<string, DiscoveredElement>;
  formattedTree: string;
  /** Visible headings, `h1: text` per line. */
  headings: string[];
  /** Visible readable text of the page (main document, open shadow roots, same-origin frames), truncated. */
  pageText: string;
  /** Iframes that could not be entered (cross-origin). */
  opaqueFrames: string[];
  screenshotBase64?: string;
}

/** In-page script: resolves a locator to a DOM node (shared with the action executor). */
export const RESOLVE_LOCATOR_JS = `
function __aegisResolve(loc) {
  let ctx = document, node = null;
  for (const seg of loc) {
    if (seg.k === 's') { if (!node || !node.shadowRoot) return null; ctx = node.shadowRoot; }
    else if (seg.k === 'f') { if (!node) return null; try { ctx = node.contentDocument; } catch (e) { return null; } if (!ctx) return null; }
    node = ctx;
    for (const i of seg.p) { node = node.children[i]; if (!node) return null; }
  }
  return node && node !== document ? node : null;
}
function __aegisAbsRect(el) {
  const r = el.getBoundingClientRect();
  let x = r.x, y = r.y;
  let w = el.ownerDocument.defaultView;
  while (w && w.frameElement) {
    const fe = w.frameElement; const fr = fe.getBoundingClientRect();
    x += fr.x + fe.clientLeft; y += fr.y + fe.clientTop; w = w.parent;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(r.width), height: Math.round(r.height) };
}
`;

const EXTRACTOR_SCRIPT = `
(() => {
  const MAX_ELEMENTS = 200, MAX_TEXT = 6000;
  const SEL = 'button,input,select,textarea,a[href],summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],' +
    '[role=menuitem],[role=option],[role=combobox],[role=listbox],[role=switch],[role=slider],[role=textbox],[role=searchbox],' +
    '[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[draggable="true"],[aria-haspopup]:not([aria-haspopup="false"])';
  const elements = [], headings = [], texts = [], opaqueFrames = [];
  const vw = window.innerWidth, vh = window.innerHeight;

  function pathFrom(root, el) {
    const p = []; let c = el;
    while (c && c !== root) { const parent = c.parentNode; if (!parent) return null; p.unshift(Array.prototype.indexOf.call(parent.children, c)); c = parent; }
    return p;
  }
  function describe(el) {
    if (!el || !el.tagName) return 'unknown';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '');
  }
  function textOf(el, doc) {
    let t = el.getAttribute('aria-label') || '';
    if (!t && el.getAttribute('aria-labelledby')) {
      t = el.getAttribute('aria-labelledby').split(/\\s+/).map(id => { const n = (el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : doc.getElementById(id)); return n ? n.textContent : ''; }).join(' ');
    }
    if (!t && el.labels && el.labels.length) t = el.labels[0].innerText || el.labels[0].textContent || '';
    if (!t) t = el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
    if (!t) t = el.innerText || el.textContent || '';
    if (!t && el.tagName === 'INPUT') t = el.getAttribute('value') || '';
    return t.replace(/\\s+/g, ' ').trim().slice(0, 100);
  }
  function visible(el, view) {
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function walk(root, chain, offX, offY, ctxLabel) {
    const doc = root.ownerDocument || root;
    const view = doc.defaultView || window;
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el = tw.nextNode();
    while (el) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag) && visible(el, view)) {
        const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) headings.push(tag + ': ' + t.slice(0, 160));
      }
      if (elements.length < MAX_ELEMENTS && el.matches(SEL) && visible(el, view)) {
        const r = el.getBoundingClientRect();
        const x = Math.round(r.x + offX), y = Math.round(r.y + offY);
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        let occludedBy, offscreen = false;
        if (x + r.width < 0 || y + r.height < 0 || x > vw || y > vh) offscreen = true;
        else {
          const hitRoot = root.elementFromPoint ? root : doc;
          const hit = hitRoot.elementFromPoint(cx, cy);
          if (hit && hit !== el && !el.contains(hit) && !(hit.shadowRoot && hit.shadowRoot.contains(el)) &&
              !(el.labels && Array.prototype.some.call(el.labels, l => l === hit || l.contains(hit)))) {
            occludedBy = describe(hit);
          }
        }
        const type = el.getAttribute('type') || undefined;
        const role = el.getAttribute('role') || undefined;
        const isTextInput = tag === 'textarea' || el.isContentEditable || role === 'textbox' || role === 'searchbox' ||
          (tag === 'input' && (!type || ['text', 'search', 'email', 'password', 'url', 'number', 'tel'].includes(type)));
        const p = pathFrom(root, el);
        if (p) {
          const item = {
            tagName: tag, role, type, name: textOf(el, doc),
            bounds: { x, y, width: Math.round(r.width), height: Math.round(r.height) },
            isClickable: !isTextInput, isTextInput,
            locator: chain.concat([{ k: chain.length ? 'x' : 'd', p }]),
            context: ctxLabel || undefined, occludedBy, offscreen: offscreen || undefined,
            id: el.id || undefined
          };
          if (isTextInput && 'value' in el && type !== 'password') item.value = String(el.value).slice(0, 60);
          if (type === 'checkbox' || type === 'radio') item.checked = !!el.checked;
          if (el.getAttribute('aria-checked')) item.checked = el.getAttribute('aria-checked') === 'true';
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
          if (el.getAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded') === 'true';
          if (el.getAttribute('aria-selected')) item.selected = el.getAttribute('aria-selected') === 'true';
          if (tag === 'select') {
            item.options = Array.from(el.options).slice(0, 25).map(o => (o.selected ? '*' : '') + (o.label || o.text).trim());
            item.value = el.value;
          }
          if (tag === 'a') item.href = el.href;
          elements.push(item);
        }
      }
      if (el.shadowRoot) {
        const p = pathFrom(root, el);
        if (p) walk(el.shadowRoot, chain.concat([{ k: chain.length ? 'x' : 'd', p }, { k: 's', p: [] }]), offX, offY, (ctxLabel ? ctxLabel + '>' : '') + 'shadow');
        try { const t = Array.from(el.shadowRoot.children).map(c => c.innerText || '').join(' ').trim(); if (t) texts.push(t); } catch (e) {}
      }
      if ((tag === 'iframe' || tag === 'frame') && visible(el, view)) {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        const fr = el.getBoundingClientRect();
        if (inner && inner.documentElement) {
          const p = pathFrom(root, el);
          if (p) {
            walk(inner, chain.concat([{ k: chain.length ? 'x' : 'd', p }, { k: 'f', p: [] }]), offX + fr.x + el.clientLeft, offY + fr.y + el.clientTop, (ctxLabel ? ctxLabel + '>' : '') + 'frame');
            try { const t = (inner.body && inner.body.innerText || '').trim(); if (t) texts.push('[frame] ' + t); } catch (e) {}
          }
        } else {
          opaqueFrames.push((el.getAttribute('src') || el.src || 'about:blank') + (el.id ? ' (#' + el.id + ')' : ''));
        }
      }
      el = tw.nextNode();
    }
  }
  walk(document, [], 0, 0, '');
  const main = (document.body && document.body.innerText) || '';
  const pageText = [main].concat(texts).join('\\n').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, MAX_TEXT);
  return { url: location.href, title: document.title, elements, headings: headings.slice(0, 40), pageText, opaqueFrames };
})()
`;

/**
 * Locators are built as a flat list in the page: a segment with `k:'x'` continues inside the context opened by the
 * previous `s`/`f` marker. Normalise to the documented form: `[d p] [s|f with p of the next hop] ...`.
 */
function normaliseLocator(raw: Array<{ k: string; p: number[] }>): LocatorSegment[] {
  const out: LocatorSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i];
    if (seg.k === 'd') out.push({ k: 'd', p: seg.p });
    else if (seg.k === 's' || seg.k === 'f') {
      const next = raw[i + 1];
      out.push({ k: seg.k, p: next ? next.p : [] });
      i++;
    }
  }
  return out;
}

/** Keeps refs stable per tab: the same element keeps its `eN` across snapshots. */
export class RefRegistry {
  private byKey = new Map<string, string>();
  private counter = 0;

  public refFor(key: string): string {
    let ref = this.byKey.get(key);
    if (!ref) {
      ref = `e${++this.counter}`;
      this.byKey.set(key, ref);
    }
    return ref;
  }
}

const registries = new WeakMap<object, RefRegistry>();

export function registryFor(webContents: object): RefRegistry {
  let r = registries.get(webContents);
  if (!r) {
    r = new RefRegistry();
    registries.set(webContents, r);
  }
  return r;
}

function formatElement(el: DiscoveredElement): string {
  const tag = el.type ? `${el.tagName}[type="${el.type}"]` : el.tagName;
  const parts = [`[${el.ref}]`, el.role ? `${tag} role=${el.role}` : tag];
  if (el.name) parts.push(`"${el.name}"`);
  if (el.value !== undefined && el.value !== '') parts.push(`(value="${el.value}")`);
  if (el.options) parts.push(`options=[${el.options.join(' | ')}]`);
  if (el.checked !== undefined) parts.push(el.checked ? '(checked)' : '(unchecked)');
  if (el.selected) parts.push('(selected)');
  if (el.expanded !== undefined) parts.push(el.expanded ? '(expanded)' : '(collapsed)');
  if (el.disabled) parts.push('(disabled)');
  if (el.context) parts.push(`{in ${el.context}}`);
  if (el.occludedBy) parts.push(`(occluded by ${el.occludedBy})`);
  if (el.offscreen) parts.push('(offscreen)');
  return parts.join(' ');
}

export class PerceptionEngine {
  public static async captureSnapshot(webContents: WebContents, captureScreenshot: boolean = false): Promise<PageSnapshot> {
    try {
      if (webContents.isDestroyed()) {
        throw new Error('WebContents is destroyed');
      }

      const raw = await webContents.executeJavaScript(EXTRACTOR_SCRIPT) as {
        url: string;
        title: string;
        elements: Array<Omit<DiscoveredElement, 'ref' | 'locator'> & { locator: Array<{ k: string; p: number[] }>; id?: string }>;
        headings: string[];
        pageText: string;
        opaqueFrames: string[];
      };

      const registry = registryFor(webContents);
      const elementMap = new Map<string, DiscoveredElement>();
      const occurrences = new Map<string, number>();
      const treeLines: string[] = [];

      for (const r of raw.elements) {
        const locator = normaliseLocator(r.locator);
        const frameChain = locator.slice(0, -1).map(s => s.k).join('');
        const base = r.id
          ? `${frameChain}|id:${r.id}`
          : `${frameChain}|${r.tagName}|${r.role || ''}|${r.type || ''}|${r.name}`;
        const n = (occurrences.get(base) || 0) + 1;
        occurrences.set(base, n);
        const ref = registry.refFor(`${base}#${n}`);
        const { id: _id, locator: _loc, ...rest } = r;
        const el: DiscoveredElement = { ...rest, ref, locator };
        elementMap.set(ref, el);
        treeLines.push(formatElement(el));
      }

      let screenshotBase64: string | undefined;
      if (captureScreenshot) {
        try {
          const image = await webContents.capturePage();
          screenshotBase64 = image.toJPEG(75).toString('base64');
        } catch (err: any) {
          logger.warn('Screenshot capture failed', { error: err.message });
        }
      }

      return {
        url: raw.url || webContents.getURL(),
        title: raw.title || webContents.getTitle(),
        elements: elementMap,
        formattedTree: treeLines.length > 0 ? treeLines.join('\n') : '(No interactive elements found on page)',
        headings: raw.headings || [],
        pageText: raw.pageText || '',
        opaqueFrames: raw.opaqueFrames || [],
        screenshotBase64
      };
    } catch (err: any) {
      logger.error('Failed to capture page snapshot', err);
      return {
        url: webContents.isDestroyed() ? '' : webContents.getURL() || '',
        title: webContents.isDestroyed() ? '' : webContents.getTitle() || '',
        elements: new Map(),
        formattedTree: `(Error taking page snapshot: ${err.message})`,
        headings: [],
        pageText: '',
        opaqueFrames: []
      };
    }
  }
}
