/**
 * TEST-ONLY Electron stand-in used to run the real WorkerHost / SwarmManager code under plain Node.
 * It records what WorkerHost does to the view and session so tests can assert ordering and cleanup.
 * The behaviour of real Electron is covered by scripts/e2e_worker_isolation.mjs, not by this file.
 */

import { EventEmitter } from 'node:events';
import type { WorkerRuntime } from '../../src/swarm/worker_host.js';

let nextId = 1000;

export class FakeSession extends EventEmitter {
  public permissionRequestHandler: ((wc: unknown, permission: string, cb: (allow: boolean) => void) => void) | null = null;
  public permissionCheckHandler: (() => boolean) | null = null;
  public userAgent = '';
  public clearedStorage = 0;
  public clearedCache = 0;
  public webRequestHandlers: Record<string, unknown> = {};
  public readonly webRequest = {
    onBeforeRequest: (h: unknown) => { this.webRequestHandlers.before = h; },
    onCompleted: (h: unknown) => { this.webRequestHandlers.completed = h; },
    onErrorOccurred: (h: unknown) => { this.webRequestHandlers.error = h; }
  };
  constructor(public readonly partition: string) { super(); }
  setPermissionRequestHandler(h: FakeSession['permissionRequestHandler']) { this.permissionRequestHandler = h; }
  setPermissionCheckHandler(h: FakeSession['permissionCheckHandler']) { this.permissionCheckHandler = h; }
  setUserAgent(ua: string) { this.userAgent = ua; }
  setSpellCheckerLanguages() { /* not needed */ }
  async clearStorageData() { this.clearedStorage++; }
  async clearCache() { this.clearedCache++; }
}

export class FakeWebContents extends EventEmitter {
  public readonly id = nextId++;
  public destroyed = false;
  public loading = false;
  public loadedUrls: string[] = [];
  public closeCalls = 0;
  public stopCalls = 0;
  public windowOpenHandler: ((d: { url: string }) => { action: string }) | null = null;
  constructor(public readonly session: FakeSession) { super(); }

  setWindowOpenHandler(h: FakeWebContents['windowOpenHandler']) { this.windowOpenHandler = h; }
  isDestroyed() { return this.destroyed; }
  isLoading() { return this.loading; }
  stop() { this.stopCalls++; }
  getURL() { return this.loadedUrls[this.loadedUrls.length - 1] || ''; }
  getTitle() { return 'fake'; }
  async loadURL(url: string) { this.loadedUrls.push(url); }
  async executeJavaScript() { return { settled: true, reason: 'quiescence_achieved' }; }
  close() {
    this.closeCalls++;
    setImmediate(() => { this.destroyed = true; this.emit('destroyed'); });
  }
  get debugger() { return { isAttached: () => false }; }
}

export class FakeView {
  public bounds: unknown = null;
  constructor(public readonly webContents: FakeWebContents) {}
  setBounds(b: unknown) { this.bounds = b; }
}

export class FakeWindow extends EventEmitter {
  public children: FakeView[] = [];
  public destroyed = false;
  public readonly contentView = {
    addChildView: (v: FakeView) => { this.children.push(v); },
    removeChildView: (v: FakeView) => { this.children = this.children.filter(c => c !== v); }
  };
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit('closed'); }
}

export class FakeElectronRuntime {
  public readonly sessions = new Map<string, FakeSession>();
  public readonly views: FakeView[] = [];
  public readonly defaultSessionObj = new FakeSession('');
  public readonly runtime: WorkerRuntime;

  constructor() {
    this.runtime = {
      createView: (partition) => {
        const sess = partition ? this.fromPartition(partition) : this.defaultSessionObj;
        const view = new FakeView(new FakeWebContents(sess));
        this.views.push(view);
        return view as never;
      },
      sessionFor: (partition) => this.fromPartition(partition) as never,
      defaultSession: () => this.defaultSessionObj as never
    };
  }

  private fromPartition(name: string): FakeSession {
    let s = this.sessions.get(name);
    if (!s) { s = new FakeSession(name); this.sessions.set(name, s); }
    return s;
  }
}
