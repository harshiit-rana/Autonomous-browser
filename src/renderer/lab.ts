/**
 * Motion Lab (#234 [LIV-03]): replays recorded `fixtures/events/*.json` streams and high-rate stress
 * bursts through `ChoreographyEngine` + `FrameBudgetMonitor`.
 */
import { ChoreographyEngine, FrameBudgetMonitor, type MotionInputEvent, type MotionMode } from '../ui/motion_engine.js';

interface RecordedEvent {
  seq: number;
  ts: number;
  missionId: string;
  workerId?: string;
  kind: string;
  stepId?: string;
  data?: Record<string, any>;
}

const engine = new ChoreographyEngine();
const monitor = new FrameBudgetMonitor({ budgetMs: 20, sustainMs: 3000 });
let intentCount = 0;

const fixtureEl = document.getElementById('lab-fixture') as HTMLSelectElement;
const speedEl = document.getElementById('lab-speed') as HTMLSelectElement;
const motionEl = document.getElementById('lab-motion') as HTMLSelectElement;
const modeLabel = document.getElementById('lab-active-mode') as HTMLElement;
const p95Label = document.getElementById('lab-p95') as HTMLElement;
const intentsLabel = document.getElementById('lab-intents') as HTMLElement;
const workersEl = document.getElementById('lab-workers') as HTMLElement;
const stageEl = document.getElementById('lab-stage') as HTMLElement;
const cursorEl = document.getElementById('lab-cursor') as HTMLElement;
const feedEl = document.getElementById('lab-feed') as HTMLElement;

const tiles = new Map<string, HTMLElement>();

function effectiveMode(): MotionMode {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced';
  return engine.getMotionMode();
}

function applyModeUi(m: MotionMode): void {
  engine.setMotionMode(m);
  document.documentElement.dataset.motion = m;
  modeLabel.textContent = m;
}

function mapRecordedToMotion(ev: RecordedEvent): MotionInputEvent | null {
  const d = ev.data || {};
  switch (ev.kind) {
    case 'step_started':
      return { type: 'worker_spawn', workerId: ev.workerId, seq: ev.seq, targetId: ev.workerId };
    case 'tool_call': {
      const t = d.tool;
      if (t === 'click') return { type: 'click', workerId: ev.workerId, seq: ev.seq, x: d.x ?? 180, y: d.y ?? 160 };
      if (t === 'type') return { type: 'type', workerId: ev.workerId, seq: ev.seq, text: d.text };
      if (t === 'scroll') return { type: 'scroll', workerId: ev.workerId, seq: ev.seq };
      return { type: 'move', workerId: ev.workerId, seq: ev.seq, x: d.x ?? 140, y: d.y ?? 120 };
    }
    case 'evidence':
      return { type: 'evidence', workerId: ev.workerId, seq: ev.seq, text: d.text };
    case 'approval_request':
      return { type: 'approval', workerId: ev.workerId, seq: ev.seq, text: d.targetLabel };
    case 'error':
      return { type: 'error', workerId: ev.workerId, seq: ev.seq, text: d.message };
    case 'status':
      return d.status === 'completed' ? { type: 'complete', seq: ev.seq } : null;
    default:
      return null;
  }
}

function animateElement(el: HTMLElement, keyframes: Keyframe[], durationMs: number, easing: string, usesTransform: boolean): void {
  const mode = effectiveMode();
  if (mode === 'off' || durationMs <= 0) return;
  if (mode === 'reduced' && usesTransform) {
    el.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: Math.min(durationMs, 120), easing: 'linear' });
    return;
  }
  el.animate(keyframes, { duration: durationMs, easing, fill: 'forwards' });
}

function renderRecordedEvent(ev: RecordedEvent): void {
  const motionInput = mapRecordedToMotion(ev);
  const intent = motionInput ? engine.enqueue(motionInput) : null;
  if (intent) {
    intentCount += 1;
    intentsLabel.textContent = String(intentCount);
  }

  if (ev.workerId && !tiles.has(ev.workerId)) {
    const tile = document.createElement('div');
    tile.className = 'lab-tile';
    tile.dataset.workerId = ev.workerId;
    tile.style.borderColor = ev.data?.color || 'var(--accent)';
    tile.textContent = `${ev.data?.glyph ? `[${ev.data.glyph}] ` : ''}${ev.data?.name || ev.workerId}`;
    workersEl.appendChild(tile);
    tiles.set(ev.workerId, tile);
    animateElement(tile, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], intent?.durationMs ?? 180, intent?.easing ?? 'ease-out', true);
  }

  const tile = ev.workerId ? tiles.get(ev.workerId) : undefined;
  if (intent?.type === 'click_ripple') {
    const x = intent.targetX ?? 160;
    const y = intent.targetY ?? 150;
    animateElement(cursorEl, [{ opacity: 0.9, transform: `translate(${x}px, ${y}px)` }], intent.durationMs, intent.easing, true);
    const rip = document.createElement('div');
    rip.className = 'lab-ripple';
    rip.style.left = `${x}px`;
    rip.style.top = `${y}px`;
    stageEl.appendChild(rip);
    animateElement(rip, [{ opacity: 0.85, transform: 'scale(0.5)' }, { opacity: 0, transform: 'scale(2)' }], intent.durationMs, intent.easing, true);
    setTimeout(() => rip.remove(), Math.max(50, intent.durationMs));
  } else if (intent?.type === 'error_shake' && tile) {
    tile.style.borderColor = 'var(--danger)';
    animateElement(tile, [{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], intent.durationMs, intent.easing, true);
  } else if (intent?.type === 'approval_beacon' && tile) {
    tile.style.borderColor = 'var(--warning)';
    animateElement(tile, [{ opacity: 0.55 }, { opacity: 1 }], Math.max(450, intent.durationMs), intent.easing, false);
  }

  const row = document.createElement('div');
  row.className = 'lab-ev';
  row.textContent = `#${ev.seq} [${ev.kind}] ${ev.workerId ?? 'mission'} ${JSON.stringify(ev.data ?? {})}`;
  feedEl.prepend(row);
  while (feedEl.children.length > 60) {
    feedEl.lastElementChild?.remove();
  }
  if (intent?.type === 'evidence_fly') {
    animateElement(row, [{ opacity: 0.2, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'translateX(0)' }], intent.durationMs, intent.easing, true);
  }
}

let lastRaf = performance.now();
function tickRaf(now: number): void {
  const delta = now - lastRaf;
  lastRaf = now;
  const sample = monitor.recordFrame(delta, now);
  p95Label.textContent = `${sample.p95Ms.toFixed(1)} ms`;
  if (sample.degraded && engine.getMotionMode() === 'full') {
    applyModeUi('reduced');
    motionEl.value = 'reduced';
  }
  requestAnimationFrame(tickRaf);
}
requestAnimationFrame(tickRaf);

async function replayFixture(name: string): Promise<void> {
  workersEl.replaceChildren();
  feedEl.replaceChildren();
  tiles.clear();
  intentCount = 0;
  intentsLabel.textContent = '0';

  const res = await fetch(`../fixtures/events/${name}.json`);
  const events: RecordedEvent[] = await res.json();
  const speed = Number(speedEl.value) || 1;
  engine.setSpeedMultiplier(speed);
  const t0 = events[0]?.ts ?? 0;

  for (let i = 0; i < events.length; i++) {
    const prevTs = i === 0 ? t0 : events[i - 1].ts;
    const waitMs = Math.max(0, Math.round((events[i].ts - prevTs) / speed));
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    renderRecordedEvent(events[i]);
  }
}

async function runStressBurst(workers = 10, eventsPerSec = 50, durationMs = 2000): Promise<void> {
  workersEl.replaceChildren();
  tiles.clear();
  monitor.reset();
  lastRaf = performance.now();
  let seq = 1;
  const intervalMs = Math.max(10, Math.round(1000 / eventsPerSec));
  const endAt = performance.now() + durationMs;
  while (performance.now() < endAt) {
    const wIdx = (seq % workers) + 1;
    renderRecordedEvent({
      seq: seq++,
      ts: Math.round(performance.now()),
      missionId: 'stress',
      workerId: `worker_${wIdx}`,
      kind: seq % 5 === 0 ? 'evidence' : 'tool_call',
      data: { tool: seq % 2 === 0 ? 'scroll' : 'click', x: 80 + wIdx * 20, y: 120, text: `Sample ${seq}` }
    });
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

motionEl.addEventListener('change', () => applyModeUi(motionEl.value as MotionMode));
document.getElementById('lab-replay-btn')?.addEventListener('click', () => { void replayFixture(fixtureEl.value); });
document.getElementById('lab-stress-btn')?.addEventListener('click', () => { void runStressBurst(10, 50, 2000); });

// Mission Replay (#236 [LIV-05]) reusing Motion Lab renderer & ChoreographyEngine
const replayMissionInput = document.getElementById('replay-mission-input') as HTMLInputElement | null;
const replayScrubber = document.getElementById('replay-scrubber') as HTMLInputElement | null;
const replayStepLabel = document.getElementById('replay-step-label') as HTMLElement | null;
const replayFrameImg = document.getElementById('replay-frame-img') as HTMLImageElement | null;
const replayPlayBtn = document.getElementById('replay-play-btn') as HTMLButtonElement | null;

let loadedReplay: { missionId: string; events: RecordedEvent[]; frames: Array<{ index: number; seq?: number; ts: number; sha256: string; dataUrl?: string }> } | null = null;
let replayTimer: number | null = null;

function scrubToStep(idx: number): void {
  if (!loadedReplay || loadedReplay.events.length === 0) return;
  const clamped = Math.max(0, Math.min(loadedReplay.events.length - 1, idx));
  if (replayScrubber) replayScrubber.value = String(clamped);
  if (replayStepLabel) replayStepLabel.textContent = `${clamped + 1} / ${loadedReplay.events.length}`;

  workersEl.replaceChildren();
  feedEl.replaceChildren();
  tiles.clear();
  for (let i = 0; i <= clamped; i++) {
    renderRecordedEvent(loadedReplay.events[i]);
  }
  const ev = loadedReplay.events[clamped];
  const frame = loadedReplay.frames.find(f => f.seq === ev.seq)
    || loadedReplay.frames[Math.min(loadedReplay.frames.length - 1, Math.floor((clamped / Math.max(1, loadedReplay.events.length - 1)) * Math.max(0, loadedReplay.frames.length - 1)))];
  if (replayFrameImg) {
    if (frame?.dataUrl) {
      replayFrameImg.style.display = 'block';
      replayFrameImg.src = frame.dataUrl;
      replayFrameImg.dataset.frameHash = frame.sha256;
    } else {
      replayFrameImg.style.display = 'none';
      replayFrameImg.dataset.frameHash = frame?.sha256 || '';
    }
  }
}

async function loadMissionReplay(missionId: string): Promise<any> {
  const aegis = (window as any).aegis;
  if (!aegis?.loadReplay) throw new Error('Replay bridge unavailable');
  const res = await aegis.loadReplay(missionId);
  const data = res?.data || res;
  loadedReplay = data;
  if (replayMissionInput) replayMissionInput.value = missionId;
  const maxIdx = Math.max(0, (data?.events?.length || 1) - 1);
  if (replayScrubber) {
    replayScrubber.min = '0';
    replayScrubber.max = String(maxIdx);
    replayScrubber.value = '0';
  }
  scrubToStep(0);
  return data;
}

document.getElementById('replay-load-btn')?.addEventListener('click', () => {
  const id = replayMissionInput?.value.trim();
  if (id) void loadMissionReplay(id);
});
replayScrubber?.addEventListener('input', () => scrubToStep(Number(replayScrubber.value) || 0));
replayPlayBtn?.addEventListener('click', () => {
  if (replayTimer !== null) {
    clearInterval(replayTimer);
    replayTimer = null;
    if (replayPlayBtn) replayPlayBtn.textContent = 'Play Replay';
    return;
  }
  if (!loadedReplay || loadedReplay.events.length === 0) return;
  if (replayPlayBtn) replayPlayBtn.textContent = 'Pause Replay';
  const speed = Number(speedEl.value) || 1;
  replayTimer = window.setInterval(() => {
    const next = (Number(replayScrubber?.value) || 0) + 1;
    if (!loadedReplay || next >= loadedReplay.events.length) {
      if (replayTimer !== null) clearInterval(replayTimer);
      replayTimer = null;
      if (replayPlayBtn) replayPlayBtn.textContent = 'Play Replay';
      return;
    }
    scrubToStep(next);
  }, Math.max(40, Math.round(400 / speed)));
});
document.getElementById('replay-export-btn')?.addEventListener('click', async () => {
  if (!loadedReplay?.missionId) return;
  await (window as any).aegis?.exportReplay?.(loadedReplay.missionId);
});

// Expose deterministic stats for E2E verification (#234, #236)
(window as any).__motionLab = {
  replayFixture,
  runStressBurst,
  loadMissionReplay,
  scrubToStep,
  stats: () => ({
    ...monitor.snapshot(),
    mode: effectiveMode(),
    intents: intentCount,
    replayEvents: loadedReplay?.events?.length ?? 0,
    replayFrames: loadedReplay?.frames?.length ?? 0,
    activeFrameHash: replayFrameImg?.dataset.frameHash || ''
  })
};

const qsMission = new URLSearchParams(window.location.search).get('missionId');
if (qsMission) {
  void loadMissionReplay(qsMission);
}

const initialMode = effectiveMode();
applyModeUi(initialMode);
motionEl.value = initialMode;
