/**
 * Project Aegis - Flight Recorder Blackbox (Step-by-Step Replay Engine)
 * 
 * Implements:
 * - Issue #89: AUTO-05 Flight Recorder Blackbox (Step-by-Step Execution Video Replay)
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
}

export interface FlightLog {
  id: string;
  goal: string;
  startTime: number;
  endTime?: number;
  frames: FlightFrame[];
}

export class FlightRecorder {
  private currentLog: FlightLog | null = null;

  public startRecording(id: string, goal: string): FlightLog {
    this.currentLog = {
      id,
      goal,
      startTime: Date.now(),
      frames: []
    };
    return this.currentLog;
  }

  public recordFrame(frame: Omit<FlightFrame, 'step' | 'timestamp'>): void {
    if (!this.currentLog) return;
    this.currentLog.frames.push({
      ...frame,
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

  /**
   * Generates a self-contained, standalone HTML replay viewer file.
   */
  public static exportReplayHTML(log: FlightLog, outputPath: string): string {
    const framesJson = JSON.stringify(log.frames);

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Aegis Flight Recorder - ${encodeURIComponent(log.goal)}</title>
  <style>
    body { margin: 0; background: #0B0F19; color: #E2E8F0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; height: 100vh; overflow: hidden; }
    #main { flex: 1; display: flex; flex-direction: column; padding: 16px; box-sizing: border-box; }
    #header { margin-bottom: 12px; }
    #viewport-container { flex: 1; background: #1E293B; border-radius: 8px; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    #screen-img { max-width: 100%; max-height: 100%; object-fit: contain; }
    #pointer { width: 14px; height: 14px; background: #EF4444; border: 2px solid #FFF; border-radius: 50%; position: absolute; pointer-events: none; transform: translate(-50%, -50%); transition: left 0.1s linear, top 0.1s linear; display: none; }
    #controls { height: 60px; display: flex; align-items: center; gap: 16px; }
    #timeline { flex: 1; }
    #sidebar { width: 360px; background: #0F172A; border-left: 1px solid #334155; padding: 16px; box-sizing: border-box; overflow-y: auto; }
    .card { background: #1E293B; border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 13px; }
    .btn { background: #3B82F6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: 600; }
  </style>
</head>
<body>
  <div id="main">
    <div id="header">
      <h2 style="margin:0 0 4px 0;">Flight Recorder Blackbox</h2>
      <div style="font-size:13px;color:#94A3B8;">Goal: ${log.goal}</div>
    </div>
    <div id="viewport-container">
      <img id="screen-img" src="" alt="Execution frame">
      <div id="pointer"></div>
    </div>
    <div id="controls">
      <button id="play-btn" class="btn">Play</button>
      <input type="range" id="timeline" min="1" max="${log.frames.length}" value="1">
      <span id="step-lbl">Step 1 / ${log.frames.length}</span>
    </div>
  </div>
  <div id="sidebar">
    <h3>Step Telemetry</h3>
    <div class="card">
      <strong>Action:</strong> <span id="info-action">-</span><br>
      <strong>URL:</strong> <span id="info-url" style="word-break:break-all;">-</span>
    </div>
    <div class="card">
      <strong>Agent Chain-of-Thought:</strong>
      <p id="info-thinking" style="color:#CBD5E1;margin:8px 0 0 0;line-height:1.5;">-</p>
    </div>
  </div>

  <script>
    const frames = ${framesJson};
    let currentStep = 1;
    let isPlaying = false;
    let timer = null;

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
      stepLbl.innerText = 'Step ' + step + ' / ' + frames.length;

      const f = frames[step - 1];
      if (f.screenshotBase64) {
        img.src = 'data:image/png;base64,' + f.screenshotBase64;
      }
      infoAction.innerText = f.action || '-';
      infoUrl.innerText = f.url || '-';
      infoThinking.innerText = f.thinking || 'No reasoning trace logged.';

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
      playBtn.innerText = isPlaying ? 'Pause' : 'Play';
      if (isPlaying) {
        timer = setInterval(() => {
          if (currentStep >= frames.length) {
            isPlaying = false;
            playBtn.innerText = 'Play';
            clearInterval(timer);
            return;
          }
          renderFrame(currentStep + 1);
        }, 1000);
      } else {
        clearInterval(timer);
      }
    });

    if (frames.length > 0) renderFrame(1);
  </script>
</body>
</html>
    `.trim();

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');
    return outputPath;
  }
}
