/**
 * Issue #232 [LIV-01] - FrameHub back-pressure, fallback and parked stills; Grid layout rules.
 *
 * Runs the real FrameHub / grid_layout / worker_view_registry code under plain Node with a fake CDP session, a fake
 * port and a manual clock. Real Electron behaviour (screencast frames from real pages, OS pixels, CPU) is proven by
 * scripts/dev/drive_live_grid.mjs in the running app (docs/audits/evidence/232).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  FrameHub, CdpLike, FrameSourceAdapter, HubClock, CapturedImage, jpegSize, toOwnArrayBuffer,
  RENDERER_ACK_TIMEOUT_MS, PARKED_STILL_INTERVAL_MS
} from '../src/main/frame_hub.js';
import { roundRect, isUsableTileRect, tileZoomFactor, parseLayoutReport, tilesById } from '../src/main/grid_layout.js';
import { WorkerViewRegistry } from '../src/swarm/worker_view_registry.js';
import { SwarmManager } from '../src/swarm/swarm_manager.js';
import { WorkerHost } from '../src/swarm/worker_host.js';
import { FakeElectronRuntime } from './helpers/fake_electron_runtime.js';

// ---------------------------------------------------------------- fakes
class ManualClock implements HubClock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = this.nextId++; this.timers.push({ at: this.t + ms, fn, id }); return id; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter(x => x.id !== h); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

class FakeCdp extends EventEmitter implements CdpLike {
  attached = true;
  calls: { method: string; params?: any }[] = [];
  isAttached() { return this.attached; }
  async sendCommand(method: string, params?: any) { this.calls.push({ method, params }); return {}; }
  frame(sessionId: number, bytes: Uint8Array) {
    this.emit('message', {}, 'Page.screencastFrame', { data: Buffer.from(bytes).toString('base64'), sessionId, metadata: { deviceWidth: 1, deviceHeight: 1 } });
  }
  acks() { return this.calls.filter(c => c.method === 'Page.screencastFrameAck').map(c => c.params.sessionId); }
  count(m: string) { return this.calls.filter(c => c.method === m).length; }
  detach() { this.attached = false; this.emit('detach', {}, 'target closed'); }
}

/** A minimal valid JPEG header with an SOF0 marker (w x h), plus a payload byte so frames differ. */
function jpeg(w: number, h: number, tag = 0): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 2, 3, 4, 5, 6, 7, 8, 9, tag, 0xff, 0xd9]);
}

class FakeSource implements FrameSourceAdapter {
  borrowCalls = 0;
  captureCalls = 0;
  destroyed = false;
  captureResult: () => CapturedImage | null = () => ({ jpeg: jpeg(320, 200, this.captureCalls), width: 320, height: 200 });
  constructor(public readonly id: string, public cdp: FakeCdp | null) {}
  isDestroyed() { return this.destroyed; }
  async borrowDebugger() { this.borrowCalls++; return this.cdp && this.cdp.attached ? this.cdp : null; }
  async capture() { this.captureCalls++; return this.captureResult(); }
}

class FakePort extends EventEmitter {
  posted: any[] = [];
  closed = false;
  postMessage(m: unknown) { this.posted.push(m); }
  start() {}
  close() { this.closed = true; }
  fromRenderer(data: unknown) { this.emit('message', { data }); }
  frames(id?: string) { return this.posted.filter(m => m.type === 'frame' && (!id || m.workerId === id)); }
}

async function main() {
  // ---------------------------------------------------------------- jpeg + buffers
  console.log('[232] jpegSize reads the SOF marker; own ArrayBuffer is not the pooled slab');
  assert.deepEqual(jpegSize(jpeg(409, 257)), { width: 409, height: 257 });
  assert.equal(jpegSize(new Uint8Array([1, 2, 3, 4, 5])), null);
  const small = Buffer.from('abc');
  const ab = toOwnArrayBuffer(small);
  assert.equal(ab.byteLength, 3);
  assert.ok(small.buffer.byteLength > 3, 'precondition: small Buffers live in a larger pool');

  // ---------------------------------------------------------------- screencast pacing
  console.log('[232] Screencast: CDP ack withheld until renderer ack AND 1/maxFps; frames dropped while an ack is outstanding');
  {
    const clock = new ManualClock();
    const hub = new FrameHub({ clock });
    const port = new FakePort();
    hub.attachPort(port as any);
    const cdp = new FakeCdp();
    const src = new FakeSource('w1', cdp);
    hub.addSource(src);
    hub.subscribe({ workerId: 'w1', maxFps: 10, maxWidth: 320, quality: 60 });
    await flush();
    assert.equal(cdp.count('Page.startScreencast'), 0, 'parked: no screencast');
    hub.setPresentation('w1', 'visible');
    await flush();
    assert.equal(cdp.count('Page.startScreencast'), 1);
    assert.equal(cdp.calls.find(c => c.method === 'Page.startScreencast')!.params.format, 'jpeg');

    cdp.frame(1, jpeg(320, 200, 1));
    assert.equal(port.frames('w1').length, 1);
    const f1 = port.frames('w1')[0];
    assert.ok(f1.jpeg instanceof ArrayBuffer && f1.width === 320 && f1.height === 200 && f1.source === 'screencast' && f1.seq === 1);
    assert.equal(typeof f1.jpeg, 'object', 'binary, no base64 string');
    await clock.advance(150);
    assert.deepEqual(cdp.acks(), [], 'interval passed but renderer has not acked: CDP ack withheld');
    port.fromRenderer({ type: 'ack', workerId: 'w1', seq: 1 });
    await flush();
    assert.deepEqual(cdp.acks(), [1], 'both conditions met -> ack');

    cdp.frame(2, jpeg(320, 200, 2));
    port.fromRenderer({ type: 'ack', workerId: 'w1', seq: 2 });
    await flush();
    assert.deepEqual(cdp.acks(), [1], 'renderer acked at once but 1/maxFps (100 ms) not yet passed');
    await clock.advance(99);
    assert.deepEqual(cdp.acks(), [1]);
    await clock.advance(2);
    assert.deepEqual(cdp.acks(), [1, 2], 'ack sent when the interval elapsed');

    // Renderer never acks: after the timeout the stream is not stalled, the next frame is dropped while pending
    cdp.frame(3, jpeg(320, 200, 3));
    await clock.advance(RENDERER_ACK_TIMEOUT_MS + 5);
    assert.deepEqual(cdp.acks(), [1, 2, 3], 'lost renderer ack does not stall the CDP stream forever');
    assert.equal(hub.stats('w1')!.framesDropped, 0);
    cdp.frame(4, jpeg(320, 200, 4));
    assert.equal(port.frames('w1').length, 4, 'after the timeout the renderer gets frames again');
    cdp.frame(5, jpeg(320, 200, 5)); // arrives while seq 4 is unacked (only possible if CDP was acked early)
    assert.equal(port.frames('w1').length, 4, 'frame dropped while a renderer ack is outstanding');
    assert.equal(hub.stats('w1')!.framesDropped, 1);
    assert.equal(hub.lastFrame('w1')!.seq, 5, 'but kept as the last frame');

    // Never attach/detach/bringToFront
    for (const m of ['Page.bringToFront']) assert.equal(cdp.count(m), 0);
    // Unsubscribe stops the screencast and removes the hub's listeners
    hub.unsubscribe('w1');
    await flush();
    assert.equal(cdp.count('Page.stopScreencast'), 1);
    assert.equal(cdp.listenerCount('message'), 0);
    assert.equal(cdp.listenerCount('detach'), 0);
    assert.equal(cdp.attached, true, 'the hub never detaches the shared session');
    hub.dispose();
  }

  // ---------------------------------------------------------------- detach -> capturePage fallback
  console.log('[232] Executor detach -> capturePage fallback flagged in source; empty images never forwarded');
  {
    const clock = new ManualClock();
    const hub = new FrameHub({ clock });
    const port = new FakePort();
    hub.attachPort(port as any);
    const cdp = new FakeCdp();
    const src = new FakeSource('w2', cdp);
    hub.addSource(src);
    hub.subscribe({ workerId: 'w2', maxFps: 15 });
    hub.setPresentation('w2', 'visible');
    await flush();
    assert.equal(hub.stats('w2')!.mode, 'screencast');
    cdp.detach();
    await flush();
    assert.equal(hub.stats('w2')!.mode, 'capturePage');
    await clock.advance(5);
    const fb = port.frames('w2');
    assert.ok(fb.length >= 1 && fb[fb.length - 1].source === 'capturePage');
    port.fromRenderer({ type: 'ack', workerId: 'w2', seq: fb[fb.length - 1].seq });
    // Polling rate <= 10 fps in fallback
    const before = src.captureCalls;
    await clock.advance(1000);
    assert.ok(src.captureCalls - before <= 10 && src.captureCalls - before >= 8, `fallback captures/s = ${src.captureCalls - before}`);
    // Empty image -> nothing forwarded
    src.captureResult = () => null;
    const n = port.frames('w2').length;
    for (const f of port.frames('w2')) port.fromRenderer({ type: 'ack', workerId: 'w2', seq: f.seq });
    await clock.advance(500);
    assert.equal(port.frames('w2').length, n, 'empty capture is "no frame"');
    assert.ok(hub.stats('w2')!.emptyCaptures >= 3);
    // Visible again after being parked: the shared session is tried again
    hub.setPresentation('w2', 'parked');
    cdp.attached = true;
    hub.setPresentation('w2', 'visible');
    await flush();
    assert.equal(hub.stats('w2')!.mode, 'screencast');
    hub.dispose();
  }

  // ---------------------------------------------------------------- parked stills, minimise, cached frame, port reload
  console.log('[232] Parked stills <= 5/s total and <= 1 per source per 10 s; minimised captures nothing');
  {
    const clock = new ManualClock();
    const hub = new FrameHub({ clock });
    const port = new FakePort();
    hub.attachPort(port as any);
    const srcs = Array.from({ length: 8 }, (_, i) => new FakeSource(`p${i}`, new FakeCdp()));
    for (const s of srcs) { hub.addSource(s); hub.subscribe({ workerId: s.id, maxFps: 1 }); }
    await clock.advance(1000);
    const total1 = srcs.reduce((a, s) => a + s.captureCalls, 0);
    assert.ok(total1 <= 5 && total1 >= 4, `<= 5 captures in the first second, got ${total1}`);
    await clock.advance(PARKED_STILL_INTERVAL_MS);
    for (const s of srcs) assert.ok(s.captureCalls >= 1 && s.captureCalls <= 2, `${s.id}: ${s.captureCalls} stills in 11 s`);
    for (const s of srcs) assert.equal(s.cdp!.count('Page.startScreencast'), 0, 'parked sources never screencast');
    hub.setWindowMinimised(true);
    const frozen = srcs.reduce((a, s) => a + s.captureCalls, 0);
    await clock.advance(20_000);
    assert.equal(srcs.reduce((a, s) => a + s.captureCalls, 0), frozen, 'minimised: nothing captured');
    hub.setWindowMinimised(false);
    hub.setPresentation('p0', 'visible');
    await flush();
    assert.equal(srcs[0].cdp!.count('Page.startScreencast'), 1, 'restore resumes streaming');

    // A new subscriber gets the cached last frame at once (never a grey box)
    const last = hub.lastFrame('p1')!;
    assert.ok(last);
    hub.unsubscribe('p1');
    port.posted = [];
    hub.subscribe({ workerId: 'p1', maxFps: 15 });
    assert.equal(port.frames('p1')[0]?.source, 'cached');
    assert.equal(port.frames('p1')[0]?.seq, last.seq);

    // Renderer reload: new port, old closed, subscriptions reset until the renderer subscribes again
    const port2 = new FakePort();
    hub.attachPort(port2 as any);
    await flush();
    assert.equal(port.closed, true);
    assert.equal(srcs[0].cdp!.count('Page.stopScreencast'), 1, 'stream stops until the new renderer subscribes');
    port2.fromRenderer({ type: 'subscribe', workerId: 'p0', maxFps: 15, maxWidth: 400 });
    await flush();
    assert.equal(srcs[0].cdp!.count('Page.startScreencast'), 2);
    assert.equal(srcs[0].cdp!.calls.filter(c => c.method === 'Page.startScreencast')[1].params.maxWidth, 400);

    // Removing a source (worker retired / tab closed) stops it and forgets the last frame
    hub.removeSource('p0');
    assert.equal(srcs[0].cdp!.count('Page.stopScreencast'), 2);
    assert.equal(hub.lastFrame('p0'), undefined);
    hub.dispose();
  }

  // ---------------------------------------------------------------- layout rules
  console.log('[232] Layout: ADR 0012 rounding, usable rects, zoom, newest seq only, no overlapping tiles');
  assert.deepEqual(roundRect({ x: 10.4, y: 20.6, width: 100.3, height: 50.5 }), { x: 10, y: 21, width: 101, height: 50 });
  const a = roundRect({ x: 0.5, y: 0, width: 100.4, height: 10 });
  const b = roundRect({ x: 100.9, y: 0, width: 100, height: 10 });
  assert.equal(a.x + a.width, b.x, 'adjacent fractional tiles share an edge: no seam');
  const content = { width: 1400, height: 900 };
  assert.equal(isUsableTileRect({ x: 10, y: 10, width: 300, height: 200 }, content), true);
  assert.equal(isUsableTileRect({ x: 1300, y: 10, width: 300, height: 200 }, content), false, 'outside the window');
  assert.equal(isUsableTileRect({ x: 10, y: 10, width: 0, height: 200 }, content), false);
  assert.equal(isUsableTileRect({ x: NaN, y: 10, width: 10, height: 200 } as any, content), false);
  assert.equal(tileZoomFactor(320, 1280), 0.25);
  assert.equal(tileZoomFactor(200, 1280), 0.25, 'clamped at Chromium minimum');
  assert.equal(tileZoomFactor(2000, 1280), 1, 'never zoom in');
  assert.equal(parseLayoutReport({ seq: 3, mode: 'grid', dpr: 1.25, viewport: { x: 0, y: 0, width: 1, height: 1 } }, 3), null, 'stale seq ignored');
  assert.equal(parseLayoutReport({ seq: 4, mode: 'bogus' }, 3), null);
  const rep = parseLayoutReport({ seq: 4, mode: 'grid', dpr: 1, viewport: { x: 0, y: 0, width: 1, height: 1 }, tiles: [
    { workerId: 'a', rect: { x: 0, y: 0, width: 300, height: 200 } },
    { workerId: 'b', rect: { x: 100, y: 100, width: 300, height: 200 } },
    { workerId: 'a', rect: { x: 500, y: 0, width: 300, height: 200 } },
    { workerId: 'c', rect: { x: 310, y: 0, width: 300, height: 200 } }
  ] }, 3)!;
  const m = tilesById(rep, content);
  assert.deepEqual([...m.keys()], ['a', 'c'], 'overlapping tile b and duplicate a dropped');

  // ---------------------------------------------------------------- worker view registry via the real SwarmManager
  console.log('[232] SwarmManager announces real worker views and withdraws them BEFORE teardown');
  {
    const fake = new FakeElectronRuntime();
    const reg = new WorkerViewRegistry();
    const order: string[] = [];
    const swarm = new SwarmManager({
      missionId: 'm232', viewRegistry: reg,
      workerFactory: o => {
        const w = new WorkerHost({ ...o, runtime: fake.runtime });
        const td = w.teardown.bind(w);
        (w as any).teardown = () => { order.push(`teardown:${w.id}`); return td(); };
        return w;
      }
    });
    reg.on('added', w => order.push(`added:${w.id}`));
    reg.on('removed', w => order.push(`removed:${w.id}`));
    const [w1, w2] = await swarm.spawnSwarm(2, 'r');
    assert.deepEqual(reg.list().map(w => w.id), [w1.id, w2.id]);
    await swarm.retireWorker(w1.id);
    assert.ok(order.indexOf(`removed:${w1.id}`) < order.indexOf(`teardown:${w1.id}`), order.join(' '));
    await swarm.shutdown();
    assert.equal(reg.list().length, 0);
    assert.ok(order.indexOf(`removed:${w2.id}`) < order.indexOf(`teardown:${w2.id}`));
    assert.equal(reg.add({ id: 'no-view' } as any), false, 'workers without a real view are not shown');
  }

  // ---------------------------------------------------------------- dead path removed
  console.log('[232] The polling path is gone from src (getSwarmPreviews / swarm:previews)');
  const hits: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|html)$/.test(e.name) && /getSwarmPreviews|swarm:previews/.test(fs.readFileSync(p, 'utf8'))) hits.push(p); } };
  walk(path.resolve(import.meta.dirname, '..', 'src'));
  assert.deepEqual(hits, []);

  console.log('All FrameHub / live Grid tests passed');
}

main().catch(err => { console.error(err); process.exit(1); });
