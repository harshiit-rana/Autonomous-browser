/**
 * Project Aegis - Flight Recorder & Replay Engine
 * Implements: Issue #143 [MCX-10] Deterministic event recording, XSS-safe HTML export,
 * JSON replay artifacts, speed multipliers, and sensitive data redaction.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MissionEvent } from '../ipc/contract.js';
import { sanitizeEventData } from '../agent/event_log.js';

export const FLIGHT_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_MISSION_BYTES = 200 * 1024 * 1024; // 200 MB cap per mission

export interface FlightFrame {
  step: number;
  timestamp: number;
  url: string;
  action: string;
  thinking?: string;
  mousePosition?: { x: number; y: number };
  screenshotBase64?: string;
  evidence?: string[];
}

export interface FlightLog {
  id: string;
  goal: string;
  startTime: number;
  endTime?: number;
  frames: FlightFrame[];
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export class FlightRecorder {
  private currentLog: FlightLog | null = null;

  public startRecording(id: string, goal: string): FlightLog {
    this.currentLog = {
      id,
      goal: this.redactSensitive(goal),
      startTime: Date.now(),
      frames: []
    };
    return this.currentLog;
  }

  public recordFrame(frame: Omit<FlightFrame, 'step' | 'timestamp'>): void {
    if (!this.currentLog) return;
    this.currentLog.frames.push({
      ...frame,
      action: this.redactSensitive(frame.action),
      thinking: frame.thinking ? this.redactSensitive(frame.thinking) : undefined,
      step: this.currentLog.frames.length + 1,
      timestamp: Date.now()
    });
  }

  public stopRecording(): FlightLog | null {
    if (!this.currentLog) return null;
    this.currentLog.endTime = Date.now();
    const log = this.currentLog;
    this.currentLog = null;
    return log;
  }

  public exportJSON(log: FlightLog, outputPath: string): string {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(log, null, 2), 'utf-8');
    return outputPath;
  }

  private redactSensitive(text: string): string {
    if (!text) return '';
    // Redact credit cards, common auth tokens, passwords
    return text
      .replace(/\b(?:\d[ -]*?){13,16}\b/g, '[REDACTED_CARD]')
      .replace(/password\s*[:=]\s*[^\s,]+/gi, 'password=[REDACTED]')
      .replace(/api[_-]?key\s*[:=]\s*[^\s,]+/gi, 'api_key=[REDACTED]');
  }

  /**
   * Generates a self-contained, XSS-hardened standalone HTML replay viewer file.
   */
  public static exportReplayHTML(log: FlightLog, outputPath: string): string {
    // XSS mitigation: escape < and > inside script tag JSON
    const safeFramesJson = JSON.stringify(log.frames)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    const escapedGoal = escapeHtml(log.goal);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
  <title>Aegis Flight Recorder - ${escapedGoal}</title>
  <style>
    body { margin: 0; background: #0B0F19; color: #E2E8F0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; height: 100vh; overflow: hidden; }
    #main { flex: 1; display: flex; flex-direction: column; padding: 16px; box-sizing: border-box; }
    #header { margin-bottom: 12px; }
    #viewport-container { flex: 1; background: #131B2E; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    #screen-img { max-width: 100%; max-height: 100%; object-fit: contain; }
    #pointer { width: 16px; height: 16px; background: radial-gradient(circle, #ec4899 0%, #8b5cf6 100%); border: 2px solid #FFF; border-radius: 50%; box-shadow: 0 0 10px rgba(236, 72, 153, 0.9); position: absolute; pointer-events: none; transform: translate(-50%, -50%); transition: left 0.1s linear, top 0.1s linear; display: none; }
    #controls { height: 60px; display: flex; align-items: center; gap: 14px; }
    #timeline { flex: 1; accent-color: #3B82F6; }
    #sidebar { width: 360px; background: #0F172A; border-left: 1px solid rgba(255,255,255,0.08); padding: 16px; box-sizing: border-box; overflow-y: auto; }
    .card { background: #1E293B; border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 13px; border: 1px solid rgba(255,255,255,0.05); }
    .btn { background: #3B82F6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; }
    .speed-btn { background: rgba(255,255,255,0.08); color: #94A3B8; border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
    .speed-btn.active { background: #3B82F6; color: #FFF; }
  </style>
</head>
<body>
  <div id="main">
    <div id="header">
      <h2 style="margin:0 0 4px 0; font-size: 16px;">Flight Recorder Blackbox Replay</h2>
      <div style="font-size:13px;color:#94A3B8;">Goal: <span id="log-goal"></span></div>
    </div>
    <div id="viewport-container">
      <img id="screen-img" src="" alt="Frame snapshot">
      <div id="pointer"></div>
    </div>
    <div id="controls">
      <button id="play-btn" class="btn">Play</button>
      <input type="range" id="timeline" min="1" max="${log.frames.length || 1}" value="1">
      <span id="step-lbl" style="font-size:12px; min-width:80px;">Step 1 / ${log.frames.length}</span>
      <button class="speed-btn active" data-speed="1">1x</button>
      <button class="speed-btn" data-speed="2">2x</button>
      <button class="speed-btn" data-speed="4">4x</button>
    </div>
  </div>
  <div id="sidebar">
    <h3 style="font-size:14px; margin-top:0;">Step Inspector</h3>
    <div class="card">
      <strong>Action:</strong> <span id="info-action">-</span><br>
      <strong style="margin-top:4px; display:inline-block;">URL:</strong> <span id="info-url" style="word-break:break-all;">-</span>
    </div>
    <div class="card">
      <strong>Agent Reasoning:</strong>
      <p id="info-thinking" style="color:#CBD5E1;margin:8px 0 0 0;line-height:1.5;">-</p>
    </div>
  </div>

  <script>
    const rawGoal = "${escapedGoal}";
    document.getElementById('log-goal').textContent = rawGoal;

    const frames = ${safeFramesJson};
    let currentStep = 1;
    let isPlaying = false;
    let timer = null;
    let speed = 1;

    const img = document.getElementById('screen-img');
    const pointer = document.getElementById('pointer');
    const slider = document.getElementById('timeline');
    const stepLbl = document.getElementById('step-lbl');
    const playBtn = document.getElementById('play-btn');
    const infoAction = document.getElementById('info-action');
    const infoUrl = document.getElementById('info-url');
    const infoThinking = document.getElementById('info-thinking');

    function renderFrame(step) {
      if (step < 1 || step > frames.length) return;
      currentStep = step;
      slider.value = step;
      stepLbl.textContent = 'Step ' + step + ' / ' + frames.length;

      const f = frames[step - 1];
      if (f.screenshotBase64) {
        img.src = f.screenshotBase64.startsWith('data:') ? f.screenshotBase64 : 'data:image/png;base64,' + f.screenshotBase64;
      }
      infoAction.textContent = f.action || '-';
      infoUrl.textContent = f.url || '-';
      infoThinking.textContent = f.thinking || 'No reasoning trace logged.';

      if (f.mousePosition) {
        pointer.style.display = 'block';
        pointer.style.left = f.mousePosition.x + 'px';
        pointer.style.top = f.mousePosition.y + 'px';
      } else {
        pointer.style.display = 'none';
      }
    }

    slider.addEventListener('input', (e) => {
      renderFrame(parseInt(e.target.value, 10));
    });

    playBtn.addEventListener('click', () => {
      isPlaying = !isPlaying;
      playBtn.textContent = isPlaying ? 'Pause' : 'Play';
      if (isPlaying) {
        startPlayTimer();
      } else {
        clearInterval(timer);
      }
    });

    function startPlayTimer() {
      clearInterval(timer);
      timer = setInterval(() => {
        if (currentStep >= frames.length) {
          isPlaying = false;
          playBtn.textContent = 'Play';
          clearInterval(timer);
          return;
        }
        renderFrame(currentStep + 1);
      }, Math.round(1000 / speed));
    }

    document.querySelectorAll('.speed-btn').forEach(b => {
      b.addEventListener('click', (e) => {
        document.querySelectorAll('.speed-btn').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        speed = parseFloat(e.target.dataset.speed);
        if (isPlaying) startPlayTimer();
      });
    });

    if (frames.length > 0) renderFrame(1);
  </script>
</body>
</html>`;

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');
    return outputPath;
  }
}

export interface RecordedFrameMeta {
  index: number;
  file: string;
  ts: number;
  seq?: number;
  sha256: string;
  byteLength: number;
  isSensitive?: boolean;
  dataUrl?: string;
}

export interface LoadedMissionReplay {
  missionId: string;
  schemaVersion: number;
  events: MissionEvent[];
  frames: RecordedFrameMeta[];
  truncatedLines: number;
}

/**
 * Durable disk-backed mission flight recorder (#236 [LIV-05]):
 * - Writes `<userData>/missions/<id>/events.ndjson` (append-only, fsynced per step)
 * - Stores low-rate JPEG frames `frames/NNNN.jpg` when enabled, with 200 MB eviction cap
 * - Tolerates crash-truncated trailing NDJSON lines and migrates older schemas
 * - Exports self-contained redacted replay bundles
 */
export class MissionFlightRecorder {
  public readonly missionDir: string;
  public readonly eventsPath: string;
  public readonly framesDir: string;
  public readonly manifestPath: string;
  private readonly recordFrames: boolean;
  private readonly maxMissionBytes: number;
  private frameIndex = 0;

  constructor(missionDir: string, opts: { recordFrames?: boolean; maxMissionBytes?: number } = {}) {
    this.missionDir = missionDir;
    this.eventsPath = path.join(missionDir, 'events.ndjson');
    this.framesDir = path.join(missionDir, 'frames');
    this.manifestPath = path.join(missionDir, 'flight_manifest.json');
    this.recordFrames = opts.recordFrames ?? false;
    this.maxMissionBytes = opts.maxMissionBytes ?? DEFAULT_MAX_MISSION_BYTES;
    fs.mkdirSync(this.missionDir, { recursive: true });
    if (this.recordFrames) fs.mkdirSync(this.framesDir, { recursive: true });
    if (!fs.existsSync(this.manifestPath)) {
      fs.writeFileSync(
        this.manifestPath,
        JSON.stringify({ schemaVersion: FLIGHT_SCHEMA_VERSION, recordFrames: this.recordFrames, frames: [] }, null, 2),
        'utf8'
      );
    } else if (fs.existsSync(this.framesDir)) {
      this.frameIndex = fs.readdirSync(this.framesDir).filter(f => f.endsWith('.jpg')).length;
    }
  }

  public appendEvent(ev: MissionEvent): void {
    const clean = {
      schemaVersion: FLIGHT_SCHEMA_VERSION,
      ...ev,
      data: sanitizeEventData(ev.data) as Record<string, any>
    };
    const line = JSON.stringify(clean) + '\n';
    const fd = fs.openSync(this.eventsPath, 'a');
    try {
      fs.writeSync(fd, line, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  public recordJpegFrame(
    jpegBytes: Buffer,
    opts: { ts?: number; seq?: number; isSensitive?: boolean; force?: boolean } = {}
  ): RecordedFrameMeta | null {
    if (!this.recordFrames && !opts.force) return null;
    if (opts.isSensitive) return null;
    fs.mkdirSync(this.framesDir, { recursive: true });
    this.frameIndex += 1;
    const fileName = `${String(this.frameIndex).padStart(4, '0')}.jpg`;
    const fullPath = path.join(this.framesDir, fileName);
    const sha256 = crypto.createHash('sha256').update(jpegBytes).digest('hex');

    const fd = fs.openSync(fullPath, 'w');
    try {
      fs.writeSync(fd, jpegBytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    const meta: RecordedFrameMeta = {
      index: this.frameIndex,
      file: `frames/${fileName}`,
      ts: opts.ts ?? Date.now(),
      seq: opts.seq,
      sha256,
      byteLength: jpegBytes.byteLength
    };
    this.updateManifestFrame(meta);
    this.enforceSizeCap();
    return meta;
  }

  private updateManifestFrame(meta: RecordedFrameMeta): void {
    try {
      const m = fs.existsSync(this.manifestPath)
        ? JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'))
        : { schemaVersion: FLIGHT_SCHEMA_VERSION, frames: [] };
      if (!Array.isArray(m.frames)) m.frames = [];
      m.frames.push(meta);
      fs.writeFileSync(this.manifestPath, JSON.stringify(m, null, 2), 'utf8');
    } catch {
      // Best effort manifest update
    }
  }

  private enforceSizeCap(): void {
    if (!fs.existsSync(this.framesDir)) return;
    const calcSize = (dir: string): number => {
      if (!fs.existsSync(dir)) return 0;
      let total = 0;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        total += st.isDirectory() ? calcSize(p) : st.size;
      }
      return total;
    };
    let total = calcSize(this.missionDir);
    if (total <= this.maxMissionBytes) return;

    const frameFiles = fs.readdirSync(this.framesDir).filter(f => f.endsWith('.jpg')).sort();
    for (const f of frameFiles) {
      if (total <= this.maxMissionBytes) break;
      const full = path.join(this.framesDir, f);
      try {
        const sz = fs.statSync(full).size;
        fs.unlinkSync(full);
        total -= sz;
      } catch {
        // ignore
      }
    }
  }

  public static load(missionDir: string, opts: { includeFrameDataUrls?: boolean } = {}): LoadedMissionReplay {
    const eventsPath = path.join(missionDir, 'events.ndjson');
    const framesDir = path.join(missionDir, 'frames');
    const manifestPath = path.join(missionDir, 'flight_manifest.json');
    const missionId = path.basename(missionDir);

    let schemaVersion = FLIGHT_SCHEMA_VERSION;
    let manifestFrames: RecordedFrameMeta[] = [];
    if (fs.existsSync(manifestPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        schemaVersion = typeof m.schemaVersion === 'number' ? m.schemaVersion : 0;
        if (Array.isArray(m.frames)) manifestFrames = m.frames;
      } catch {
        // corrupt manifest tolerated
      }
    }

    const events: MissionEvent[] = [];
    let truncatedLines = 0;
    if (fs.existsSync(eventsPath)) {
      const raw = fs.readFileSync(eventsPath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as any;
          // Migrate legacy schema (v0 -> v1)
          const ev: MissionEvent = {
            seq: typeof parsed.seq === 'number' ? parsed.seq : events.length + 1,
            ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
            missionId: typeof parsed.missionId === 'string' ? parsed.missionId : missionId,
            ...(parsed.workerId ? { workerId: String(parsed.workerId) } : {}),
            kind: parsed.kind || 'status',
            ...(parsed.stepId ? { stepId: String(parsed.stepId) } : {}),
            data: parsed.data && typeof parsed.data === 'object' ? parsed.data : { text: String(parsed.text || '') }
          };
          events.push(ev);
        } catch {
          truncatedLines += 1;
        }
      }
    }

    const frames: RecordedFrameMeta[] = [];
    if (fs.existsSync(framesDir)) {
      const jpgs = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      for (let i = 0; i < jpgs.length; i++) {
        const file = jpgs[i];
        const full = path.join(framesDir, file);
        const bytes = fs.readFileSync(full);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const mMeta = manifestFrames.find(f => f.file === `frames/${file}`);
        frames.push({
          index: mMeta?.index ?? i + 1,
          file: `frames/${file}`,
          ts: mMeta?.ts ?? fs.statSync(full).mtimeMs,
          seq: mMeta?.seq,
          sha256,
          byteLength: bytes.byteLength,
          ...(opts.includeFrameDataUrls ? { dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` } : {})
        });
      }
    }

    return {
      missionId,
      schemaVersion: Math.max(FLIGHT_SCHEMA_VERSION, schemaVersion),
      events,
      frames,
      truncatedLines
    };
  }

  public static exportReplayBundle(
    missionDir: string,
    outputDir: string,
    opts: { blurSensitiveFrames?: boolean } = {}
  ): { htmlPath: string; jsonPath: string; eventCount: number; frameCount: number } {
    const loaded = MissionFlightRecorder.load(missionDir, { includeFrameDataUrls: true });
    const redactedEvents = loaded.events.map(ev => ({
      ...ev,
      data: sanitizeEventData(ev.data, { privacyMode: 'Careful' }) as Record<string, any>
    }));

    const sensitiveSeqs = new Set<number>(
      redactedEvents
        .filter(e => e.kind === 'tool_call' && (e.data?.text === '[REDACTED_INPUT]' || /password|secret|pin|otp/i.test(String(e.data?.targetLabel || ''))))
        .map(e => e.seq)
    );

    const legacyFrames: FlightFrame[] = loaded.frames.map((f, idx) => {
      const isSensitive = (f.seq !== undefined && sensitiveSeqs.has(f.seq)) || Boolean(f.isSensitive);
      return {
        step: idx + 1,
        timestamp: f.ts,
        url: '',
        action: `Frame ${f.index} (${f.sha256.slice(0, 10)})`,
        screenshotBase64: isSensitive && opts.blurSensitiveFrames !== false ? undefined : f.dataUrl
      };
    });

    fs.mkdirSync(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, 'recording.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ ...loaded, events: redactedEvents }, null, 2), 'utf8');
    const htmlPath = path.join(outputDir, 'index.html');
    FlightRecorder.exportReplayHTML(
      { id: loaded.missionId, goal: `Mission ${loaded.missionId}`, startTime: loaded.events[0]?.ts ?? Date.now(), frames: legacyFrames },
      htmlPath
    );
    return { htmlPath, jsonPath, eventCount: redactedEvents.length, frameCount: legacyFrames.length };
  }
}
