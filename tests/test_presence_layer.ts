import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { PresenceEvent, PresenceMessage, LayoutRect } from '../src/ipc/contract.js';
import { IPC_CHANNELS } from '../src/ipc/contract.js';
import { overlayPoint, pointInView, overlayBounds, maskTextPreview, isSecretField, PresenceCoalescer } from '../src/main/presence_geometry.js';
import { PresenceLayer, type OverlayWindowLike, type ParentWindowLike } from '../src/main/presence_layer.js';
import { ActionExecutor, type ExecutorPresence } from '../src/core/action_executor.js';

/**
 * #233 presence layer: the mapping, coalescing, window tracking and executor emission rules, with fakes for Electron.
 * The pixels and the real click pass-through are proved in tests/e2e/presence.spec.ts, not here.
 */
const ev = (o: Partial<PresenceEvent>): PresenceEvent => ({ workerId: 'w1', seq: 0, ts: 0, kind: 'move', x: 0, y: 0, zoom: 1, ...o });

async function main() {
  // ---- mapping: view origin + (x * zoom, y * zoom), no DPR term (ADR 0011)
  const view: LayoutRect = { x: 0, y: 88, width: 460, height: 512 };
  assert.deepStrictEqual(overlayPoint(view, 120, 65, 1), { x: 120, y: 153 });
  assert.deepStrictEqual(overlayPoint(view, 120, 65, 1.5), { x: 180, y: 185.5 }, 'page zoom scales the offset inside the view');
  assert.deepStrictEqual(overlayPoint({ x: 10.5, y: 20, width: 1, height: 1 }, 2, 2, 0), { x: 12.5, y: 22 }, 'a bad zoom falls back to 1');
  assert.strictEqual(pointInView(view, 100, 100, 1), true);
  assert.strictEqual(pointInView(view, 100, 600, 1), false, 'a target below the viewport is off-screen');
  assert.strictEqual(pointInView(view, 400, 100, 1.5), false, 'zoom moves a point out of a small view');
  assert.deepStrictEqual(overlayBounds({ x: 0.4, y: 0.6, width: 1399.7, height: 861.2 }), { x: 0, y: 1, width: 1400, height: 861 });

  // ---- masking: a password is never shown, and an unreadable field is treated as a password
  assert.strictEqual(maskTextPreview('hunter2', true), '•'.repeat(7));
  assert.strictEqual(maskTextPreview('hello', false), 'hello');
  assert.strictEqual(maskTextPreview('x'.repeat(100), false).length, 40, 'the bubble keeps the last 40 characters');
  assert.strictEqual(isSecretField({ type: 'password' }), true);
  assert.strictEqual(isSecretField({ type: 'text', autocomplete: 'cc-number' }), true);
  assert.strictEqual(isSecretField({ type: 'text', autocomplete: 'one-time-code' }), true);
  assert.strictEqual(isSecretField({ type: 'text', autocomplete: 'email' }), false);
  assert.strictEqual(isSecretField(null), true, 'no focused element known -> masked');

  // ---- coalescing: 1000 moves cost one move; clicks are never dropped; order is kept; the path survives
  const c = new PresenceCoalescer();
  for (let i = 0; i < 1000; i++) c.push(ev({ kind: 'move', x: i, y: i, path: [{ x: i, y: i, t: 0 }, { x: i + 1, y: i + 1, t: 5 }] }));
  c.push(ev({ kind: 'click', x: 999, y: 999 }));
  c.push(ev({ kind: 'move', x: 5, y: 5 }));
  c.push(ev({ workerId: 'w2', kind: 'move', x: 7, y: 7 }));
  const out = c.drain();
  assert.deepStrictEqual(out.map(e => `${e.workerId}:${e.kind}`), ['w1:move', 'w1:click', 'w1:move', 'w2:move'], 'one move per worker per run, click kept between moves');
  assert.strictEqual(out[0].x, 999, 'the newest move wins');
  assert.ok((out[0].path?.length ?? 0) > 2 && (out[0].path?.length ?? 0) <= 64, 'the dispatched path is kept (bounded)');
  assert.strictEqual(c.size, 0);
  const t = new PresenceCoalescer(); t.push(ev({ kind: 'type', textPreview: 'a' })); t.push(ev({ kind: 'type', textPreview: 'ab' }));
  assert.strictEqual(t.drain().length, 2, 'type events are never merged');

  // ---- layer with fake windows
  const sent: PresenceMessage[] = [];
  class FakeOverlay implements OverlayWindowLike {
    bounds: LayoutRect | null = null; visible = false; closed = false; ready: (() => void) | null = null; boundsCalls = 0;
    setBounds(b: LayoutRect) { this.bounds = b; this.boundsCalls++; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.closed; }
    send(m: PresenceMessage) { sent.push(m); }
    onReady(cb: () => void) { this.ready = cb; }
    close() { this.closed = true; }
  }
  class FakeParent extends EventEmitter implements ParentWindowLike {
    content: LayoutRect = { x: 100, y: 50, width: 1400, height: 800 };
    minimised = false;
    shown = true;
    getContentBounds() { return { ...this.content }; }
    isMinimized() { return this.minimised; }
    isVisible() { return this.shown; }
    isDestroyed() { return false; }
  }
  const timers: Array<() => void> = [];
  const holder: { ov: FakeOverlay | null; created: number } = { ov: null, created: 0 };
  const parent = new FakeParent();
  const layer = new PresenceLayer(parent, {
    createOverlay: () => { holder.created++; holder.ov = new FakeOverlay(); return holder.ov; },
    schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {}
  });
  assert.strictEqual(holder.created, 0, 'no window is created until a page view is visible');
  layer.emit(ev({ kind: 'click' }));
  assert.strictEqual(layer.stats.dropped, 1, 'an event for a view that is not shown is dropped, nothing is drawn over a hidden page');
  layer.setViewRect('w1', { x: 0, y: 88, width: 460, height: 512 });
  assert.strictEqual(holder.created, 1);
  const ov = holder.ov!;
  assert.deepStrictEqual(ov.bounds, parent.content, 'overlay = parent content area');
  assert.strictEqual(ov.visible, true);
  // events are queued until the overlay page has loaded, then delivered in order
  layer.emit(ev({ kind: 'move', x: 1 }));
  layer.emit(ev({ kind: 'click', x: 2 }));
  timers.shift()!();
  assert.strictEqual(sent.length, 0, 'nothing is sent to a page that has not loaded');
  ov.ready!();
  assert.deepStrictEqual(sent.map(m => (m.op === 'event' ? m.event.kind : m.op)), ['rect', 'move', 'click'], 'rect first, then the events in order');
  // the parent moves / resizes / maximises: the overlay follows from the event itself
  parent.content = { x: 120, y: 60, width: 1200, height: 700 };
  parent.emit('move');
  assert.deepStrictEqual(ov.bounds, parent.content);
  parent.content = { x: 0, y: 0, width: 1920, height: 1040 };
  parent.emit('maximize');
  assert.deepStrictEqual(ov.bounds, parent.content);
  // a display change (monitor DPI / arrangement) re-fits too
  const displays = new EventEmitter();
  const p2 = new FakeParent();
  let ov2: FakeOverlay | null = null;
  const d = new PresenceLayer(p2, { createOverlay: () => (ov2 = new FakeOverlay()), displays });
  d.setViewRect('w', { x: 0, y: 0, width: 10, height: 10 });
  p2.content = { x: 1920, y: 0, width: 800, height: 600 };
  displays.emit('display-metrics-changed');
  assert.deepStrictEqual((ov2 as unknown as FakeOverlay).bounds, p2.content, 'display-metrics-changed re-fits the overlay');
  // minimise hides, restore shows, and no setBounds happens while minimised (a minimised window reports garbage bounds)
  const calls = ov.boundsCalls;
  parent.minimised = true;
  parent.content = { x: -32000, y: -32000, width: 160, height: 28 };
  parent.emit('minimize');
  assert.strictEqual(ov.visible, false);
  assert.strictEqual(ov.boundsCalls, calls);
  parent.minimised = false;
  parent.content = { x: 10, y: 10, width: 1000, height: 700 };
  parent.emit('restore');
  assert.strictEqual(ov.visible, true);
  assert.deepStrictEqual(ov.bounds, parent.content);
  parent.shown = false; parent.emit('hide');
  assert.strictEqual(ov.visible, false);
  parent.shown = true; parent.emit('show');
  assert.strictEqual(ov.visible, true);
  // the view is hidden (parked worker, DOM modal): the overlay hides and a late event is dropped
  layer.setViewRect('w1', null);
  assert.strictEqual(ov.visible, false, 'no visible page view -> overlay window hidden');
  const dropped = layer.stats.dropped;
  layer.emit(ev({ kind: 'click' }));
  assert.strictEqual(layer.stats.dropped, dropped + 1);
  // per-worker rects are independent: a second worker shows while the first stays hidden
  layer.setViewRect('w2', { x: 5, y: 5, width: 100, height: 100 });
  assert.strictEqual(ov.visible, true);
  sent.length = 0;
  layer.emit(ev({ workerId: 'w2', kind: 'click' }));
  layer.emit(ev({ workerId: 'w1', kind: 'click' }));
  layer.flush();
  const delivered = sent.filter(m => m.op === 'event').map(m => (m as { op: 'event'; event: PresenceEvent }).event.workerId);
  assert.deepStrictEqual(delivered, ['w2'], 'only the shown worker is drawn');
  layer.dispose();
  assert.strictEqual(ov.closed, true);
  layer.emit(ev({}));
  layer.setViewRect('w9', view);
  assert.strictEqual(holder.created, 1, 'after dispose nothing throws or resurrects the window');

  // no click-through window on this platform (Linux): honest no-op, never a fake
  const none = new PresenceLayer(new FakeParent(), { createOverlay: null });
  none.setViewRect('w1', view);
  none.emit(ev({}));
  assert.strictEqual(none.available, false);
  assert.strictEqual(none.overlayWindow, null);
  assert.strictEqual(none.stats.dropped, 1);

  // ---- the REAL ActionExecutor emits what it dispatched, from a fake WebContents/CDP
  const cdp: Array<[string, any]> = [];
  const js: string[] = [];
  let focused: unknown = { tag: 'INPUT', type: 'password', autocomplete: '' };
  let probeFails = false;
  const wc: any = {
    isDestroyed: () => false,
    debugger: { isAttached: () => true, attach() {}, detach() {}, on() {}, sendCommand: async (m: string, p: any) => { cdp.push([m, p]); return {}; } },
    executeJavaScript: async (code: string) => {
      js.push(code);
      if (probeFails) throw new Error('page gone');
      return /activeElement/.test(code) ? focused : null;
    }
  };
  const ex = new ActionExecutor(wc);
  const got: ExecutorPresence[] = [];
  ex.setPresenceSink(e => got.push(e));
  await ex.clickAt(300, 200);
  assert.deepStrictEqual(got.map(g => g.kind), ['move', 'click']);
  assert.strictEqual(got[1].x, 300);
  assert.strictEqual(got[1].y, 200);
  assert.deepStrictEqual(got[0].path?.map(p => [p.x, p.y]), [[100, 100], [300, 200]], 'the path starts where the pointer was and ends where it was dispatched');
  assert.ok(cdp.some(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed' && p.x === 300 && p.y === 200), 'the same coordinates went to CDP');
  got.length = 0;
  await ex.insertText('hunter2');
  assert.strictEqual(got.length, 7);
  assert.strictEqual(got[6].textPreview, '•'.repeat(7), 'password field: bullets, never the text');
  assert.ok(got.every(g => !/[a-z0-9]/i.test(g.textPreview ?? '')));
  focused = { tag: 'INPUT', type: 'text', autocomplete: 'email' };
  got.length = 0;
  await ex.insertText('ab');
  assert.strictEqual(got[1].textPreview, 'ab', 'a normal field shows the typed text');
  probeFails = true; // a failing probe means "secret"
  got.length = 0;
  await ex.insertText('zz');
  assert.strictEqual(got[1].textPreview, '••');
  ex.announceScroll('down');
  assert.deepStrictEqual([got[got.length - 1].kind, got[got.length - 1].label], ['scroll', 'down']);
  ex.setPresenceSink(() => { throw new Error('boom'); }); // a sink that throws never breaks an action
  await ex.clickAt(1, 1);
  const injected = cdp.filter(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument').length;
  assert.ok(injected <= 1, `at most the fingerprint shield is injected, got ${injected}`);
  assert.ok(!js.some(code => /__updateAgentCursor|__triggerAgentClick|__highlightElement/.test(code)), 'no cursor code runs in the page');

  // ---- source guards: the page-injected cursor is really gone, and the overlay preload uses the product channel
  const root = path.resolve(__dirname, '..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  assert.ok(!fs.existsSync(path.join(root, 'src', 'stealth', 'cursor_overlay.ts')), 'cursor_overlay.ts is deleted');
  for (const f of walk(path.join(root, 'src')).filter(x => /\.(ts|html)$/.test(x))) {
    assert.ok(!/CURSOR_OVERLAY_SCRIPT|__updateAgentCursor|__triggerAgentClick|presence-overlay/.test(fs.readFileSync(f, 'utf8')), `${path.relative(root, f)} still has page-injected or chrome-DOM presence`);
  }
  const preload = fs.readFileSync(path.join(root, 'src', 'main', 'presence_preload.ts'), 'utf8');
  assert.ok(preload.includes(`'${IPC_CHANNELS.EVENT_PRESENCE}'`), 'the overlay preload listens on presence:event');
  assert.deepStrictEqual([...preload.matchAll(/from '([^']+)'/g)].map(m => m[1]), ['electron'], 'a sandboxed preload may import only electron');
  const win = fs.readFileSync(path.join(root, 'src', 'main', 'presence_window.ts'), 'utf8');
  for (const needle of ['transparent: true', 'frame: false', 'focusable: false', 'skipTaskbar: true', 'setIgnoreMouseEvents(true, { forward: true })', 'contextIsolation: true', 'sandbox: true']) {
    assert.ok(win.includes(needle), `overlay window option ${needle}`);
  }

  console.log('test_presence_layer: all assertions passed');
}

main().catch(e => { console.error(e); process.exit(1); });
