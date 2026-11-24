import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolDefinition } from '../models/types.js';
import type { TabView } from '../main/view_manager.js';
import { PageSnapshot, DiscoveredElement, RESOLVE_LOCATOR_JS } from './perception.js';
import { drawMarks, Mark } from './som_bitmap.js';
import { ActionRiskClass } from '../security/action_policy.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('tools');

/**
 * Tools exposed to the model (issue #225). Each has a JSON schema here, an executor below (page input goes through
 * `core/action_executor.ts`), and a risk class used by the policy engine (`TOOL_RISK`).
 */
export const BROWSER_TOOLS: ToolDefinition[] = [
  { name: 'navigate', description: 'Navigate the current tab to a URL', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL (e.g. https://example.com)' } }, required: ['url'] } },
  { name: 'click', description: 'Click an element by its ref from the page snapshot (e.g. "e1")', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref' }, button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button' } }, required: ['ref'] } },
  { name: 'type', description: 'Type text into an input, textarea or contenteditable element', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref' }, text: { type: 'string', description: 'Text to type' }, clear: { type: 'boolean', description: 'Clear existing text first' }, pressEnter: { type: 'boolean', description: 'Press Enter after typing' } }, required: ['ref', 'text'] } },
  { name: 'press_key', description: 'Press a keyboard key (Enter, Escape, Tab, ArrowDown, PageDown, ...)', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Key name' } }, required: ['key'] } },
  { name: 'scroll', description: 'Scroll the page up or down', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'], description: 'Direction' }, amount: { type: 'number', description: 'Pixels (default 350)' } }, required: ['direction'] } },
  { name: 'wait', description: 'Wait for content to load or settle', parameters: { type: 'object', properties: { ms: { type: 'number', description: 'Milliseconds (100-5000)' } } } },
  { name: 'select_option', description: 'Choose an option in a native <select> or an ARIA combobox/listbox, by option value or visible label', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Ref of the select or combobox' }, value: { type: 'string', description: 'Option value' }, label: { type: 'string', description: 'Visible option label' } }, required: ['ref'] } },
  { name: 'hover', description: 'Move the mouse over an element (opens hover menus and tooltips)', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref' } }, required: ['ref'] } },
  { name: 'drag', description: 'Drag one element onto another', parameters: { type: 'object', properties: { fromRef: { type: 'string', description: 'Ref of the element to drag' }, toRef: { type: 'string', description: 'Ref of the drop target' } }, required: ['fromRef', 'toRef'] } },
  { name: 'go_back', description: 'Go back one page in the current tab history', parameters: { type: 'object', properties: {} } },
  { name: 'go_forward', description: 'Go forward one page in the current tab history', parameters: { type: 'object', properties: {} } },
  { name: 'open_tab', description: 'Open a URL in a new tab owned by this mission and switch to it', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to open' } }, required: ['url'] } },
  { name: 'switch_tab', description: 'Switch to another tab of this mission (ids are listed in the observation)', parameters: { type: 'object', properties: { tabId: { type: 'string', description: 'Tab id' } }, required: ['tabId'] } },
  { name: 'close_tab', description: 'Close a tab this mission opened', parameters: { type: 'object', properties: { tabId: { type: 'string', description: 'Tab id' } }, required: ['tabId'] } },
  { name: 'extract', description: 'Read the text, tables and lists of the page (or of one element) to fill a JSON schema. Then call record_extraction with the filled data and an exact quote for every value.', parameters: { type: 'object', properties: { schema: { type: 'object', description: 'JSON schema of the data you want' }, scope: { type: 'string', description: 'Optional element ref or CSS selector limiting the region' } }, required: ['schema'] } },
  { name: 'record_extraction', description: 'Submit data for an earlier extract. quotes maps every field path (e.g. "rows[0].revenue") to an exact quote from the extracted text that contains the value. Values without a matching quote are rejected.', parameters: { type: 'object', properties: { extractionId: { type: 'string', description: 'id returned by extract' }, data: { type: 'object', description: 'Data matching the schema' }, quotes: { type: 'object', description: 'field path -> exact quote' } }, required: ['extractionId', 'data', 'quotes'] } },
  { name: 'find_text', description: 'Find text on the page (including shadow roots and same-origin frames); scrolls the first match into view', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to find (case-insensitive)' } }, required: ['query'] } },
  { name: 'screenshot', description: 'Capture the visible page as an image; withMarks draws each element ref on the image', parameters: { type: 'object', properties: { withMarks: { type: 'boolean', description: 'Draw element refs on the image' } } } },
  { name: 'upload_file', description: 'Set a file on an <input type=file>. The path must be inside the mission folder.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Ref of the file input' }, path: { type: 'string', description: 'File path relative to the mission folder' } }, required: ['ref', 'path'] } },
  { name: 'ask_user', description: 'Ask the human a question and wait for the answer (e.g. a choice, a missing detail, 2FA)', parameters: { type: 'object', properties: { question: { type: 'string', description: 'The question' }, options: { type: 'array', description: 'Optional answer choices', items: { type: 'string' } } }, required: ['question'] } },
  { name: 'done', description: 'Finish the mission with the final answer. An independent check compares it with the page before the mission is marked complete.', parameters: { type: 'object', properties: { result: { type: 'string', description: 'Final answer' }, evidence: { type: 'array', description: 'Facts from the page supporting the answer', items: { type: 'string' } } }, required: ['result'] } },
  { name: 'fail', description: 'Report that the mission cannot be completed', parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Why' } }, required: ['reason'] } }
];

/** Policy risk class of each tool when the target facts do not say more (the policy engine refines click/type). */
export const TOOL_RISK: Record<string, ActionRiskClass> = {
  navigate: 'navigate-in-scope', click: 'read', type: 'write-reversible', press_key: 'write-reversible', scroll: 'read',
  wait: 'read', select_option: 'write-reversible', hover: 'read', drag: 'write-reversible', go_back: 'read',
  go_forward: 'read', open_tab: 'navigate-in-scope', switch_tab: 'read', close_tab: 'read', extract: 'read',
  record_extraction: 'read', find_text: 'read', screenshot: 'read', upload_file: 'file-egress', ask_user: 'read',
  done: 'read', fail: 'read'
};

/** Validates arguments against the tool's JSON schema (required fields, primitive types, enums). Returns an error or null. */
export function validateToolArgs(name: string, args: unknown): string | null {
  const def = BROWSER_TOOLS.find(t => t.name === name);
  if (!def) return `Unknown tool "${name}". Available: ${BROWSER_TOOLS.map(t => t.name).join(', ')}`;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be a JSON object.';
  const a = args as Record<string, any>;
  if (a._parseError) return `Arguments were not valid JSON: ${String(a._raw ?? '').slice(0, 120)}`;
  for (const req of def.parameters.required || []) {
    if (a[req] === undefined || a[req] === null || a[req] === '') return `Missing required argument "${req}".`;
  }
  for (const [k, v] of Object.entries(a)) {
    const prop = def.parameters.properties[k];
    if (!prop || v === undefined || v === null) continue;
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (prop.type !== actual) return `Argument "${k}" must be ${prop.type}, got ${actual}.`;
    if (prop.enum && !prop.enum.includes(v)) return `Argument "${k}" must be one of ${prop.enum.join(', ')}.`;
  }
  if (name === 'select_option' && !a.value && !a.label) return 'select_option needs "value" or "label".';
  return null;
}

/** What the tools need from the browser beyond the current tab (implemented by ViewManager in the app). */
export interface AgentTabHost {
  open(url: string, owner: string): TabView;
  activate(id: string): void;
  close(id: string): void;
  list(): TabView[];
}

export interface ExtractionRecord {
  id: string;
  schema: Record<string, any>;
  text: string;
}

export interface ToolExecutionContext {
  tab: TabView;
  snapshot: PageSnapshot;
  tabs?: AgentTabHost;
  /** `agent:<missionId>`: tab tools may only touch tabs with this owner (plus `startTabId`). */
  owner?: string;
  startTabId?: string;
  /** Files for upload_file must be inside this folder. */
  missionDir?: string;
  extractions?: Map<string, ExtractionRecord>;
}

export interface ToolExecutionResult {
  ok: boolean;
  effect?: Record<string, any>;
  output: string;
  error?: string;
  isTerminal?: boolean;
  isDone?: boolean;
  requiresUser?: boolean;
  image?: { mimeType: string; base64: string };
  /** The loop should continue in this tab (open_tab, switch_tab, close_tab). */
  switchToTabId?: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function staleRef(ref: string, why = 'not in the current snapshot'): ToolExecutionResult {
  return {
    ok: false,
    error: 'stale_ref',
    output: `Element ${ref} is ${why}. The page will be observed again; pick a ref from the new snapshot instead of retrying this one.`
  };
}

/** Collects `path -> leaf value` for every primitive in data. */
function leaves(value: any, prefix = '', out: Array<[string, any]> = []): Array<[string, any]> {
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out));
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  else if (value !== null && value !== undefined && value !== '') out.push([prefix, value]);
  return out;
}

/** Quote rules for record_extraction: the quote must occur in the extracted text and contain the value. */
export function checkExtraction(rec: ExtractionRecord, data: any, quotes: Record<string, any>): { ok: boolean; problems: string[]; accepted: Array<{ path: string; value: any; quote: string }> } {
  const problems: string[] = [];
  const accepted: Array<{ path: string; value: any; quote: string }> = [];
  const source = norm(rec.text);
  for (const req of (rec.schema?.required as string[] | undefined) || []) {
    if (data?.[req] === undefined) problems.push(`required field "${req}" is missing`);
  }
  const ls = leaves(data);
  if (ls.length === 0) problems.push('data has no values');
  for (const [p, v] of ls) {
    const q = quotes?.[p];
    if (typeof q !== 'string' || !q.trim()) { problems.push(`${p}: no quote`); continue; }
    if (!source.includes(norm(q))) { problems.push(`${p}: quote "${q.slice(0, 60)}" does not occur in the extracted text`); continue; }
    const vs = norm(String(v));
    const digits = (s: string) => s.replace(/[^0-9.]/g, '');
    const contains = typeof v === 'number' ? digits(norm(q)).includes(digits(vs).replace(/\.0+$/, '')) : norm(q).includes(vs);
    if (!contains) { problems.push(`${p}: quote does not contain the value "${String(v).slice(0, 40)}"`); continue; }
    accepted.push({ path: p, value: v, quote: q });
  }
  return { ok: problems.length === 0, problems, accepted };
}

async function locateRef(ctx: ToolExecutionContext, ref: string): Promise<{ el: DiscoveredElement; at: { x: number; y: number; width: number; height: number } } | ToolExecutionResult> {
  const el = ctx.snapshot.elements.get(String(ref || ''));
  if (!el) return staleRef(ref);
  const at = await ctx.tab.executor.locate(el.locator, el.tagName);
  if (!at) return staleRef(ref, 'no longer on the page (the DOM changed since the snapshot)');
  if (at.width === 0 && at.height === 0) return staleRef(ref, 'no longer visible');
  return { el, at };
}

export class ToolExecutor {
  public static async execute(name: string, args: Record<string, any>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    logger.info('Executing tool', { name, args: name === 'type' ? { ref: args.ref } : args });
    const { tab } = context;
    const wc = tab.view.webContents;
    const ex = tab.executor;

    try {
      switch (name) {
        case 'navigate': {
          let url = String(args.url || '').trim();
          if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
          await wc.loadURL(url).catch(err => { if (!/ERR_ABORTED/.test(String(err?.message))) throw err; });
          return { ok: true, effect: { navigated: url }, output: `Navigated to ${url}` };
        }

        case 'click': {
          const r = await locateRef(context, args.ref);
          if ('ok' in r) return r;
          if (r.el.occludedBy) {
            // Re-check: the cover may have gone since the snapshot.
            const hit = await wc.executeJavaScript(`(() => { const e = document.elementFromPoint(${r.at.x}, ${r.at.y}); return e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') : null; })()`);
            if (hit && hit === r.el.occludedBy) {
              return { ok: false, error: 'occluded', output: `Element ${args.ref} is covered by ${hit}; a click would hit the cover. Close or scroll past the covering element first.` };
            }
          }
          await ex.clickAt(Math.round(r.at.x), Math.round(r.at.y), args.button === 'right' ? 'right' : 'left');
          return { ok: true, effect: { clicked: args.ref }, output: `Clicked [${args.ref}] "${r.el.name}"` };
        }

        case 'type': {
          const r = await locateRef(context, args.ref);
          if ('ok' in r) return r;
          await ex.clickAt(Math.round(r.at.x), Math.round(r.at.y));
          if (args.clear) {
            await wc.executeJavaScript(`(() => { ${RESOLVE_LOCATOR_JS} const el = __aegisResolve(${JSON.stringify(r.el.locator)}); if (!el) return; if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) el.textContent = ''; })()`);
          }
          const text = String(args.text ?? '');
          await ex.insertText(text);
          if (args.pressEnter) await ex.pressKey('Enter');
          return { ok: true, effect: { typed: text.length, ref: args.ref }, output: `Typed ${text.length} characters into [${args.ref}]${args.pressEnter ? ' and pressed Enter' : ''}` };
        }

        case 'press_key': {
          await ex.pressKey(String(args.key || 'Enter'));
          return { ok: true, output: `Pressed key: ${args.key}` };
        }

        case 'scroll': {
          const dir = args.direction === 'up' ? -1 : 1;
          const px = Math.min(Math.max(Number(args.amount) || 350, 20), 5000);
          await wc.executeJavaScript(`window.scrollBy({ top: ${dir * px}, behavior: 'instant' })`);
          ex.announceScroll(dir < 0 ? 'up' : 'down');
          return { ok: true, output: `Scrolled ${args.direction} by ${px}px` };
        }

        case 'wait': {
          const duration = Math.min(Math.max(Number(args.ms) || 1000, 100), 5000);
          await sleep(duration);
          return { ok: true, output: `Waited ${duration}ms` };
        }

        case 'select_option': {
          const r = await locateRef(context, args.ref);
          if ('ok' in r) return r;
          const want = { value: args.value != null ? String(args.value) : null, label: args.label != null ? String(args.label) : null };
          if (r.el.tagName === 'select') {
            const res = await wc.executeJavaScript(`(() => { ${RESOLVE_LOCATOR_JS}
              const el = __aegisResolve(${JSON.stringify(r.el.locator)}); if (!el) return { err: 'gone' };
              const want = ${JSON.stringify(want)}; const n = s => String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
              const opt = Array.from(el.options).find(o => (want.value !== null && o.value === want.value) || (want.label !== null && n(o.label || o.text) === n(want.label)));
              if (!opt) return { err: 'no option', options: Array.from(el.options).map(o => (o.label || o.text).trim()) };
              if (opt.disabled) return { err: 'disabled option' };
              el.focus(); el.value = opt.value;
              el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
              return { chosen: (opt.label || opt.text).trim(), value: opt.value };
            })()`);
            if (res.err) return { ok: false, error: 'select_failed', output: `select_option failed on [${args.ref}]: ${res.err}${res.options ? `. Options: ${res.options.join(' | ')}` : ''}` };
            return { ok: true, effect: { selected: res.value }, output: `Selected "${res.chosen}" (value "${res.value}") in [${args.ref}]` };
          }
          // ARIA combobox/listbox: open it with a real click, then click the matching role=option.
          if (r.el.role !== 'listbox') await ex.clickAt(Math.round(r.at.x), Math.round(r.at.y));
          // The list may open after an animation or a microtask: poll for a visible option instead of a fixed wait.
          const findOption = () => wc.executeJavaScript(`(() => { ${RESOLVE_LOCATOR_JS}
            const el = __aegisResolve(${JSON.stringify(r.el.locator)}); if (!el) return { err: 'gone' };
            const want = ${JSON.stringify(want)}; const n = s => String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
            const root = el.getRootNode();
            const ids = ((el.getAttribute('aria-controls') || '') + ' ' + (el.getAttribute('aria-owns') || '')).trim().split(/\\s+/).filter(Boolean);
            let scopes = ids.map(id => root.getElementById ? root.getElementById(id) : document.getElementById(id)).filter(Boolean);
            if (el.getAttribute('role') === 'listbox') scopes.push(el);
            if (!scopes.length) scopes = Array.from(el.querySelectorAll('[role=listbox]'));
            if (!scopes.length) scopes = [root.querySelector ? root : document];
            const options = scopes.flatMap(s => Array.from(s.querySelectorAll('[role=option]')));
            const o = options.find(o => (want.value !== null && (o.getAttribute('data-value') === want.value || o.id === want.value || n(o.textContent) === n(want.value))) || (want.label !== null && n(o.textContent) === n(want.label)));
            if (!o) return { err: 'no option', options: options.map(o => o.textContent.trim()) };
            o.scrollIntoView({ block: 'nearest' });
            const r = __aegisAbsRect(o);
            if (!r.width || !r.height) return { err: 'option not visible after opening the list' };
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: o.textContent.trim() };
          })()`);
          let opt: any = { err: 'gone' };
          let reopened = r.el.role === 'listbox'; // a bare listbox has no opener to click again
          for (let i = 0; i < 20; i++) {
            await sleep(100);
            opt = await findOption();
            if (!opt.err || opt.err === 'gone') break;
            // A real click can be lost (first input after the view is shown, headless CI): the list never opened.
            // After ~0.6 s without a visible option, read the opener's CURRENT rect and click it once more, unless
            // the page already says it is expanded.
            if (!reopened && i === 5) {
              reopened = true;
              const opener: any = await wc.executeJavaScript(`(() => { ${RESOLVE_LOCATOR_JS}
                const el = __aegisResolve(${JSON.stringify(r.el.locator)}); if (!el) return null;
                if (el.getAttribute('aria-expanded') === 'true') return null;
                const q = __aegisAbsRect(el); if (!q.width || !q.height) return null;
                return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
              })()`);
              if (opener) await ex.clickAt(Math.round(opener.x), Math.round(opener.y));
            }
          }
          if (opt.err === 'option not visible after opening the list') opt.err = 'the list did not open (no visible option after clicking the control twice)';
          if (opt.err) return { ok: false, error: 'select_failed', output: `select_option failed on [${args.ref}]: ${opt.err}${opt.options ? `. Options: ${opt.options.join(' | ')}` : ''}` };
          await ex.clickAt(Math.round(opt.x), Math.round(opt.y));
          return { ok: true, effect: { selected: opt.label }, output: `Selected "${opt.label}" in listbox [${args.ref}]` };
        }

        case 'hover': {
          const r = await locateRef(context, args.ref);
          if ('ok' in r) return r;
          await ex.mouseMove(Math.round(r.at.x), Math.round(r.at.y));
          return { ok: true, effect: { hovered: args.ref }, output: `Mouse is over [${args.ref}] "${r.el.name}"` };
        }

        case 'drag': {
          const a = await locateRef(context, args.fromRef);
          if ('ok' in a) return a;
          const b = await locateRef(context, args.toRef);
          if ('ok' in b) return b;
          // Locating the target may have scrolled the source; locate the source again.
          const from = await ex.locate(a.el.locator, a.el.tagName);
          if (!from) return staleRef(args.fromRef, 'no longer on the page');
          const mode = await ex.dragBetween({ x: Math.round(from.x), y: Math.round(from.y) }, { x: Math.round(b.at.x), y: Math.round(b.at.y) });
          return { ok: true, effect: { dragged: args.fromRef, to: args.toRef, mode }, output: `Dragged [${args.fromRef}] onto [${args.toRef}] (${mode} drag)` };
        }

        case 'go_back':
        case 'go_forward': {
          const h = wc.navigationHistory;
          const can = name === 'go_back' ? h.canGoBack() : h.canGoForward();
          if (!can) return { ok: false, error: 'no_history', output: `Cannot ${name === 'go_back' ? 'go back' : 'go forward'}: no history entry in that direction.` };
          const done = new Promise<void>(resolve => {
            const t = setTimeout(resolve, 8000);
            wc.once('did-stop-loading', () => { clearTimeout(t); resolve(); });
          });
          if (name === 'go_back') h.goBack(); else h.goForward();
          await done;
          return { ok: true, output: `${name === 'go_back' ? 'Went back' : 'Went forward'} to ${wc.getURL()}` };
        }

        case 'open_tab': {
          if (!context.tabs || !context.owner) return { ok: false, error: 'no_tab_host', output: 'Tabs are not available in this mission.' };
          let url = String(args.url || '').trim();
          if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
          const t = context.tabs.open(url, context.owner);
          return { ok: true, effect: { openedTab: t.id }, switchToTabId: t.id, output: `Opened tab ${t.id} at ${url} and switched to it` };
        }

        case 'switch_tab':
        case 'close_tab': {
          if (!context.tabs || !context.owner) return { ok: false, error: 'no_tab_host', output: 'Tabs are not available in this mission.' };
          const id = String(args.tabId);
          const target = context.tabs.list().find(t => t.id === id);
          const ownedByMission = target && target.state.owner === context.owner;
          if (!target || !(ownedByMission || id === context.startTabId)) {
            return { ok: false, error: 'not_agent_tab', output: `Tab ${id} is not a tab of this mission. Mission tabs: ${context.tabs.list().filter(t => t.state.owner === context.owner || t.id === context.startTabId).map(t => t.id).join(', ')}` };
          }
          if (name === 'switch_tab') {
            context.tabs.activate(id);
            return { ok: true, switchToTabId: id, output: `Switched to tab ${id} (${target.state.url})` };
          }
          if (!ownedByMission) return { ok: false, error: 'not_agent_tab', output: `Tab ${id} was not opened by this mission and will not be closed.` };
          const remaining = context.tabs.list().filter(t => t.id !== id && (t.state.owner === context.owner || t.id === context.startTabId));
          if (remaining.length === 0) return { ok: false, error: 'last_tab', output: 'Refusing to close the last tab of the mission.' };
          context.tabs.close(id);
          const next = id === tab.id ? remaining[remaining.length - 1].id : tab.id;
          if (next !== tab.id) context.tabs.activate(next);
          return { ok: true, switchToTabId: next, output: `Closed tab ${id}; current tab is ${next}` };
        }

        case 'extract': {
          let scopeLocator: unknown = null;
          let selector: string | null = null;
          if (args.scope) {
            const el = context.snapshot.elements.get(String(args.scope));
            if (el) scopeLocator = el.locator; else selector = String(args.scope);
          }
          const res = await wc.executeJavaScript(`(() => { ${RESOLVE_LOCATOR_JS}
            const loc = ${JSON.stringify(scopeLocator)}; const sel = ${JSON.stringify(selector)};
            let root = document.body;
            if (loc) root = __aegisResolve(loc); else if (sel) { try { root = document.querySelector(sel); } catch (e) { return { err: 'bad selector' }; } }
            if (!root) return { err: 'scope not found' };
            const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
            const tables = Array.from(root.querySelectorAll('table')).slice(0, 5).map(t => {
              const headers = Array.from(t.querySelectorAll('thead th, tr:first-child th')).map(h => clean(h.innerText));
              const rows = Array.from(t.querySelectorAll('tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => clean(td.innerText))).filter(r => r.length).slice(0, 50);
              return { headers, rows };
            });
            const lists = Array.from(root.querySelectorAll('ul,ol')).slice(0, 10).map(l => Array.from(l.children).filter(c => c.tagName === 'LI').map(li => clean(li.innerText)).slice(0, 40)).filter(l => l.length);
            return { text: (root.innerText || '').slice(0, 12000), tables, lists };
          })()`);
          if (res.err) return { ok: false, error: 'extract_failed', output: `extract failed: ${res.err}` };
          const id = `x${(context.extractions?.size || 0) + 1}`;
          context.extractions?.set(id, { id, schema: args.schema, text: [res.text, ...res.tables.flatMap((t: any) => [t.headers.join(' | '), ...t.rows.map((r: string[]) => r.join(' | '))]), ...res.lists.flat()].join('\n') });
          return {
            ok: true,
            effect: { extractionId: id },
            output: `extractionId=${id}\n<extracted_data source="page" trust="untrusted">\nTEXT:\n${res.text.slice(0, 6000)}\nTABLES: ${JSON.stringify(res.tables).slice(0, 4000)}\nLISTS: ${JSON.stringify(res.lists).slice(0, 2000)}\n</extracted_data>\n` +
              `Now call record_extraction with extractionId="${id}", data matching the schema, and quotes: one exact quote from the text above per field path.`
          };
        }

        case 'record_extraction': {
          const rec = context.extractions?.get(String(args.extractionId));
          if (!rec) return { ok: false, error: 'unknown_extraction', output: `No extraction with id "${args.extractionId}". Call extract first.` };
          const check = checkExtraction(rec, args.data, args.quotes || {});
          if (!check.ok) return { ok: false, error: 'quote_rejected', output: `Extraction rejected: ${check.problems.join('; ')}. Every value needs an exact quote from the extracted text.` };
          return {
            ok: true,
            effect: { extraction: args.data, evidence: check.accepted.map(a => `${a.path} = ${JSON.stringify(a.value)} — "${a.quote}"`) },
            output: `Extraction ${rec.id} accepted (${check.accepted.length} quoted values).`
          };
        }

        case 'find_text': {
          const q = String(args.query || '');
          const res = await wc.executeJavaScript(`(() => {
            const q = ${JSON.stringify(q.toLowerCase())}; const hits = [];
            function scan(root, label) {
              const doc = root.ownerDocument || root;
              const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
              let n = tw.nextNode();
              while (n && hits.length < 10) {
                if (n.nodeType === 3) {
                  const t = n.textContent; const i = t.toLowerCase().indexOf(q);
                  if (i >= 0 && n.parentElement && n.parentElement.getClientRects().length) hits.push({ node: n.parentElement, context: t.slice(Math.max(0, i - 60), i + q.length + 60).replace(/\\s+/g, ' ').trim(), where: label });
                } else {
                  if (n.shadowRoot) scan(n.shadowRoot, label + 'shadow ');
                  if (n.tagName === 'IFRAME') { try { if (n.contentDocument) scan(n.contentDocument, label + 'frame '); } catch (e) {} }
                }
                n = tw.nextNode();
              }
            }
            scan(document, '');
            if (hits[0]) hits[0].node.scrollIntoView({ block: 'center', behavior: 'instant' });
            return hits.map(h => ({ context: h.context, where: h.where.trim() || 'page' }));
          })()`);
          if (!res.length) return { ok: true, effect: { matches: 0 }, output: `No match for "${q}" on this page.` };
          return { ok: true, effect: { matches: res.length }, output: `${res.length} match(es) for "${q}"; the first is scrolled into view:\n` + res.map((h: any, i: number) => `${i + 1}. [${h.where}] …${h.context}…`).join('\n') };
        }

        case 'screenshot': {
          const image = await wc.capturePage();
          if (image.isEmpty()) return { ok: false, error: 'capture_failed', output: 'The page could not be captured (view not visible).' };
          const size = image.getSize();
          let png: Buffer;
          let drawn: Mark[] = [];
          if (args.withMarks) {
            const cssWidth: number = await wc.executeJavaScript('window.innerWidth');
            const scale = cssWidth > 0 ? size.width / cssWidth : 1;
            const bmp = Buffer.from(image.toBitmap());
            const marks: Mark[] = Array.from(context.snapshot.elements.values())
              .filter(e => !e.offscreen && e.bounds.width > 0)
              .map(e => ({ label: e.ref.replace(/^e/, ''), x: e.bounds.x, y: e.bounds.y, width: e.bounds.width, height: e.bounds.height }));
            drawn = drawMarks(bmp, size.width, size.height, marks, scale);
            const { nativeImage } = await import('electron');
            png = nativeImage.createFromBitmap(bmp, { width: size.width, height: size.height }).toPNG();
          } else {
            png = image.toPNG();
          }
          return {
            ok: true,
            effect: { width: size.width, height: size.height, marks: drawn.length },
            image: { mimeType: 'image/png', base64: png.toString('base64') },
            output: `Screenshot ${size.width}x${size.height}${args.withMarks ? ` with ${drawn.length} marks (number n = ref en)` : ''} attached.`
          };
        }

        case 'upload_file': {
          if (!context.missionDir) return { ok: false, error: 'no_mission_dir', output: 'This mission has no file folder.' };
          const base = path.resolve(context.missionDir);
          const target = path.resolve(base, String(args.path));
          if (target !== base && !target.startsWith(base + path.sep)) {
            return { ok: false, error: 'path_outside_mission', output: `Refused: ${args.path} is outside the mission folder.` };
          }
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, error: 'no_such_file', output: `No file ${args.path} in the mission folder.` };
          const r = await locateRef(context, args.ref);
          if ('ok' in r) return r;
          if (r.el.tagName !== 'input' || r.el.type !== 'file') return { ok: false, error: 'not_file_input', output: `[${args.ref}] is not a file input.` };
          const ok = await ex.setInputFiles(r.el.locator, [target]);
          if (!ok) return staleRef(args.ref, 'no longer on the page');
          return { ok: true, effect: { uploaded: path.basename(target) }, output: `Set file ${path.basename(target)} on [${args.ref}]` };
        }

        case 'ask_user':
          return { ok: true, requiresUser: true, output: String(args.question || ''), effect: { options: Array.isArray(args.options) ? args.options.map(String) : undefined } };

        case 'done':
          return { ok: true, output: String(args.result || ''), isTerminal: true, isDone: true, effect: { evidence: Array.isArray(args.evidence) ? args.evidence.map(String) : [] } };

        case 'fail':
          return { ok: false, output: String(args.reason || 'Mission failed'), error: String(args.reason || 'Failed'), isTerminal: true, isDone: false };

        default:
          return { ok: false, output: `Unknown tool "${name}"`, error: 'unknown_tool' };
      }
    } catch (err: any) {
      logger.error('Tool execution error', err);
      return { ok: false, output: `Error executing tool ${name}: ${err.message}`, error: err.message };
    }
  }
}
