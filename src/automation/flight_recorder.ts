/**
 * Project Aegis - Flight Recorder & Replay Engine
 * Implements: Issue #143 [MCX-10] Deterministic event recording, XSS-safe HTML export,
 * JSON replay artifacts, speed multipliers, and sensitive data redaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
