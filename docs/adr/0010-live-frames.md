# ADR 0010: Live worker frames (capture strategy)

- Status: proposed (design spike, no product code changed)
- Issue: #232 (LIV-01). The issue text names the file `0010-live-worker-view.md`; the coordinator asked for `0010-live-frames.md`, which is what exists.
- Date: 2026-11-20
- Scope of evidence: **Windows 11 only** (10.0.26300), Electron 33.4.11 (Chromium 130, Node 20.18), AMD Ryzen 7 7735HS, 15.6 GB RAM (0.4 to 1.6 GB free during the runs: shared machine), primary display 1920x1080 at 125% scale, **144 Hz** (the fixture's rAF ran at 143.8/s). macOS and Linux were not measured.

## Context

`ViewManager.getSwarmPreviews()` polls `capturePage()` over every tab and returns base64 data URLs. Run01 (`docs/audits/RUNNING_APP_BASELINE.md`, D1) measured that it never resolves when more than one tab exists, so Grid is blank. #232 asks for a real live view and asks this spike to choose the capture strategy, with the worker pages continuing to run normally.

## How it was measured

Harness: `scripts/dev/spike_live_view.mjs` (an Electron main script, run with the project's own Electron 33.4.11; it is not the product, `src/` is untouched). Shared helpers in `scripts/dev/spike_common.mjs`, table printer `scripts/dev/spike_live_summary.mjs`. Views use the `webPreferences` of `view_manager.ts createTab`. Deviations from the issue text:

- `fixtures/pages/visibility.html` does not exist in the repo; the same page (rAF counter, 100 ms timer counter, CSS animation, a canvas redrawn every rAF, a button, `visibilityState`) is embedded in `spike_common.mjs` and served from 127.0.0.1.
- Cells run 20 s each, after a 1.5 s warm-up. Most cells have **one** repetition; `tile-capturePage10`, `tile-screencast15` and `stage-none` have two (`results_rep1*.json` vs `results_rep2.json`). The machine was shared; one rep-1 cell (`tile-screencast15` N=5 in `results_rep1c.json`: 7.98 fps, page rAF 77.9/s) is a visible outlier that the rep-2 repeat did not reproduce (14.94 fps). Treat all numbers as indicative, not as a benchmark.
- CPU % is **percent of one core**, from Win32 `TotalProcessorTime` deltas of every Electron process over an exact window (PowerShell timestamps), split by process type: Browser (= the Electron main process), GPU, Tab (renderers). The fixture itself is expensive (a 144 Hz canvas per page), so the renderer and GPU columns include the page's own cost; compare against the `none` rows. Main-process CPU is the column the decision rule uses.
- The harness window was set always-on-top so Windows occlusion tracking could not throttle the attached cells.
- Raw output: `docs/audits/evidence/spikes/live_view/` (`results_rep1.json`, `results_rep1b.json`, `results_rep1c.json`, `results_rep2.json`, `results_sliver.json`, `results_probes.json`, run logs, OS screenshots under `shots/`). `results_rep1.json` contains an early probe section that was polluted by a stale per-host zoom (see "Surprises"); the clean probes are in `results_probes.json`. Rows named `screencast15` in `results_rep1.json` and `results_rep1b.json` were run before the ack-pacing bug in the harness was fixed (they behave like unpaced `screencast`); only `results_rep1c.json` and `results_rep2.json` contain valid paced rows.

## Options considered and measured

### 1. Where must a worker view live for the page to run?

N=6 views, capture `none`, 20 s. "rAF/s" and "timers/s" are the page's own counters (display is 144 Hz, timer is 100 ms so 10 is normal).

| Placement | rAF/s | timers/s | page viewport | Main CPU % | Total CPU % | Notes |
|---|---|---|---|---|---|---|
| visible stage (N=1) | 143.8 | 10 | 1000x700 | 0.2 to 0.9 | 33 to 44 | reference |
| visible tile 320x200 (N=1,5,6,10) | 143.8 | 10 | **320x200** | 0.1 to 0.2 | 34 / 117 / 148 / 224 | page re-lays-out at tile size |
| visible tile + `setZoomFactor(0.32)` (N=6,10) | 143.8 | 10 | 1000x625, devicePixelRatio 0.4 | 0 to 0.6 | 142 / 226 | keeps the layout viewport, but the page sees dpr 0.4 |
| never attached (current worker behaviour), N=1,6 | **0** | **1** | **0x0**, `visibilityState: hidden` | 0 to 0.5 | 0.1 / 1.2 | load finishes, page is frozen |
| never attached + `backgroundThrottling:false` | 0 | 10 | 0x0 | 0.1 | 0.7 | timers recover, rAF does not |
| attached then removed (what `setActiveTab` does to the old tab) | 0 | 1 | 1000x700 | 0.2 to 0.5 | 0.3 / 0.7 | |
| attached, `setVisible(false)` | 0 | 1 | 1000x700 | 0.2 | 0.2 | |
| attached, fully covered by an opaque native view | 0 | 1 | 1000x700 | 0.2 | 0.9 | covering a view stops it painting |
| attached, bounds at x=-6000 (outside window) | 0 | 1 | 0x0 | 0.2 | 0.3 | |
| attached 1x1 | 24 | 2.5 | 2x2 | 0.2 | 32.5 | |
| attached full size with 1 DIP column inside the window ("sliver") | 24 | 2.5 | 1000x700 | 0.2 | 36 | |

Conclusion: a page only runs normally while its view is attached **and visible and not covered** (a visible tile). Never-attached, hidden, covered, off-window, detached and 1x1 views are frozen or heavily throttled, and views that were never shown have a 0x0 viewport (CDP input at (160,120) landed 0 of 1 clicks on unattached, 1x1 and off-window views). This contradicts the assumption in `worker_host.ts` ("workers are hidden until a grid/stage shows them"): hidden workers are not "working in the background", they are paused. CDP input still lands on hidden and covered views that were visible once (1 of 1).

### 2. How to get pixels out

Visible tiles, N=6, 20 s, main = Electron main process:

| Strategy | fps per tile | frame interval p95 | capture latency p50 / p95 | Main CPU % | GPU % | Renderer % | KB/frame | WS MB (all procs) |
|---|---|---|---|---|---|---|---|---|
| `none` (tiles are just visible) | n/a | n/a | n/a | 0.2 | 46.7 | 100.9 | n/a | 1008 |
| `capturePage()` at 10 fps, resize 320, JPEG 60 (rep1 / rep2) | 9.4 / 9.55 | 112 / 111 ms | 15.0 / 19.7 and 12.6 / 16.3 ms | 9.3 / 10.7 | 53.7 / 55.0 | 100.3 / 101.8 | 3.4 | 1046 / 895 |
| CDP `Page.startScreencast` jpeg 60, 320x200, every frame, acked at once | 95.9 | 14.5 ms | n/a | **35.9** | 73.2 | 107.6 | 2.7 | 1018 |
| CDP screencast, `everyNthFrame: 10` | 9.6 | 105 ms | n/a | 13.2 | 85.5 | 116.5 | 2.8 | 935 |
| **CDP screencast, ack delayed to hold 15 fps** (rep2 / rep1c) | **15.0 / 14.3** | 76.6 / 79.9 ms | n/a | **13.7 / 17.5** | 75.7 / 72.5 | 106.7 / 109.4 | 2.7 | 859 / 980 |
| `offscreen:true` + `paint` (N=6) | **0 events received** | n/a | n/a | 0 | 14 | 16.1 | n/a | 861 |

Scaling of the chosen strategy (CDP screencast, ack-paced to 15 fps, rep2): main CPU 4.5 / 13.3 / 13.7 / 22.9 % and 15.0 / 14.9 / 15.0 / 15.0 fps per tile for N = 1 / 5 / 6 / 10. `capturePage` at 10 fps: main CPU 3.2 / 9.9 / 10.7 / 19.3 % and p50 latency 6.7 / 11.7 / 12.6 / 17.6 ms for the same N (it runs serialised on the main thread, so latency grows with N). "Frame interval p95" is the interval between frames, not glass-to-glass latency; **end-to-end latency (page change to pixels in the chrome renderer) was not measured**.

Other measured facts:

- **Screencast has no frames unless the view is visible**: 0 frames (0 distinct) on never-attached, detached, covered, hidden, off-window views, 0 to 2.5 fps on the 1 DIP sliver. Frames are only produced when the page produces frames, so an idle page gives none: the hub must keep the last frame.
- **`capturePage()` on a view that was never attached returns an empty `NativeImage`** here (1122 of 1122 attempts empty for 6 views): no hang. On a view that was attached and then removed (the real background-tab state), 60 of 60 calls in 20 s timed out, which is the Grid hang run01 saw. On covered and hidden (still attached) views it works (9.2 fps) but forces a paint: main CPU 55 to 57 % and p50/p95 43.6/61 ms at N=6, about ten times the cost of capturing a visible tile.
- **Back-pressure works through the ack.** Delaying `Page.screencastFrameAck` held the stream at 15.0 fps and cut main CPU from 35.9 % to 13.7 % at N=6 (frame size 2.7 KB, binary base64 inside the CDP message, no data URL, no resize in the main process).
- **WebContentsView + `offscreen:true` never emits `paint`** in 33.4.11 (0 events in 3 s even after `startPainting()`), although the page's rAF ran at 60/s. A `BrowserWindow({show:false, offscreen:true})` does emit (301 events in 5 s) but it is a window, not a view, so it cannot be promoted to the Stage. Attached to `contentView`, the offscreen view drew 0 of the fixture's pixels in a real OS screenshot (`shots/os_osr-attached-1.png`). Rejected.
- **One CDP session.** `webContents.debugger.attach()` a second time throws `Debugger is already attached to the target`; `Runtime.evaluate` and the screencast share the one session; when one consumer calls `detach()` the other's screencast stops at once (0 frames after the detach). `ActionExecutor` already owns the attach (`action_executor.ts`), so the hub must borrow that session and never detach it.
- **Focus.** `Page.bringToFront` from a view while another application's window had focus took the OS foreground from it (before: other window focused, after: main window focused, `view.webContents.isFocused()` true). `Emulation.setFocusEmulationEnabled` made `document.hasFocus()` true without moving OS focus, and a CDP click with it enabled left the other window focused. Screencast and `capturePage` never touch focus. Rule: never call `Page.bringToFront`; use focus emulation if a worker page needs `hasFocus()`.
- **Window minimised:** screencast 0 fps, rAF 0, timers 1/s, `visibilityState: hidden`; after restore 95.9 fps and rAF 143.9/s with no code: capture resumes cleanly, so "minimised: pause" needs no special handling beyond not counting it as a failure.
- **OS pixels:** six zoomed visible tiles each showed about 1005 of the fixture's animated-block pixels in a real OS screenshot (`shots/os_tilezoom-6.png`); a covered view showed only the cover (1,018,723 cover pixels); hidden, off-window, 1x1 and offscreen-attached views showed none. (The un-zoomed 320x200 tile row in that probe is inconclusive: the fixture's animated block sits at y=200, below the 200 px viewport.)

### 3. Surprises that change the design

- **Zoom is per host and persists.** `setZoomFactor` is stored by Chromium per host (in the profile, across launches) and shared by same-host views of the same session. An early run showed a stale 0.32 zoom from a previous launch turning a stage view into dpr 0.4 (`results_rep1.json` probe section). Workers have their own partitions, so zoom would not leak between workers, but it would leak to a user tab on the same host in a shared partition, and it survives a crash of the app. The harness now uses a throw-away profile.
- The default window is clamped by the work area: 1400x900 was requested and the window was 1400x816 DIP on this display.

## Decision

1. **Workers are always attached to the window, and a worker only runs while its view is visible and uncovered.** `WorkerHost` creates its view attached (`attachToWindow: true`), with `backgroundThrottling: false`, and the window stack (ADR 0012) owns visibility. A parked worker (not shown anywhere) is frozen by Chromium; that is acceptable only for the short periods the scheduler decides, and the UI must say "paused (not on screen)" instead of showing a live-looking tile.
2. **Live Grid/Stage tiles are the worker views themselves**, placed at tile bounds (ADR 0012), because a visible view costs ~0.2 % of main CPU and runs at the display rate, an order of magnitude cheaper than any capture. To keep the page's layout viewport (the agent reasons about it) tiles use `setZoomFactor(tileWidth / workerViewportWidth)` on the worker's own partition. This is **unverified for perception**: model screenshots under zoom, `Emulation.setDeviceMetricsOverride` as an alternative that avoids the page seeing dpr 0.4 (a detectable tell, #250), and coordinate mapping beyond the one CDP click that landed were not measured. The implementation issue must run that check before relying on zoom; if it fails, tiles fall back to canvas frames (below) with the view kept at Stage size and visible elsewhere (e.g. a 1 DIP-clipped region is not enough: sliver measured 24 rAF/s).
3. **FrameHub uses CDP `Page.startScreencast` on the executor's existing debugger session, paced by delaying the ack**, for every consumer that needs pixels in the chrome renderer: a worker's DOM thumbnail while its view is visible but small, the last-frame cache, pop-out previews, flight recorder (#236), the "crashed or navigating: last frame plus badge" state. Measured: 15.0 fps per tile at N=1..10, main CPU 13.7 % at 6 tiles (17.5 % in the noisier run), 22.9 % at 10.
4. **Parked workers get a refreshed still, not a stream:** round-robin `capturePage()` at most 5 captures/s in total (each costs about 1 % of main CPU per capture per second on a covered/hidden view), every parked worker at least once every 10 s while the grid is open; a never-attached view returns an empty image, so an empty image is treated as "no frame", never as a frame. Because parked views are frozen anyway, a still is the truthful representation.
5. **`capturePage` polling at 10 fps is the fallback**, used only if screencast cannot be attached (debugger conflict) on a visible view: it also met the rule (9.55 fps, 10.7 % main CPU at N=6) but its cost grows with N on the main thread (17.6 ms p50 at N=10).

The decision rule from the issue (at least 8 fps per tile at 6 tiles, main process under 60 % of one core, pages keep running, no focus steal) is met by (1)+(3): 15.0 fps, 13.7 %, 143.8 rAF/s, no focus call.

## Rejected

| Option | Measured reason |
|---|---|
| Keep workers unattached | rAF 0, timers 1/s, viewport 0x0, no clicks land, screencast 0 frames, `capturePage` empty. The page does not work. |
| `backgroundThrottling:false` alone | timers recover to 10/s, rAF stays 0, viewport stays 0x0, still no frames. |
| Park views 1x1 / off-window / behind an opaque view / `setVisible(false)` / 1 DIP sliver | rAF 0 or 24/s; 2x2, 0x0 or sliver viewport; 0 to 2.5 screencast fps; the only way to get frames out is `capturePage`, at 55 % main CPU for 6 tiles. |
| Unpaced screencast (ack immediately) | 96 fps per tile, 35.9 % (N=6) and 57.5 % (N=10) of main. Paced is 2.6 times cheaper for the same visible result. |
| `offscreen:true` WebContentsView | no `paint` events in 33.4.11, draws nothing when attached, cannot be promoted to Stage. |
| `capturePage` polling as the primary path | works on visible tiles (9.55 fps, 10.7 % at N=6) but serialised on the main thread, hangs on detached views, forces a paint on parked ones, no back-pressure. Kept as fallback and for parked stills. |
| `Page.bringToFront` | takes OS focus from other applications. |

## Interface the implementation must follow

```ts
// src/main/frame_hub.ts
export interface FrameSubscription { workerId: string; maxFps: number /* <= 15 */; maxWidth: number /* default 320 */; quality: number /* default 60 */ }
export interface WorkerFrame { workerId: string; seq: number; ts: number; width: number; height: number; jpeg: ArrayBuffer; source: 'screencast' | 'capturePage' | 'cached' }
export type WorkerPresentation = 'visible' | 'parked' | 'minimised';
export class FrameHub {
  subscribe(sub: FrameSubscription): void;
  unsubscribe(workerId: string): void;
  setPresentation(workerId: string, p: WorkerPresentation): void; // visible: screencast, parked: <=1 still/10 s, minimised: nothing
  lastFrame(workerId: string): WorkerFrame | undefined;            // never a grey box: crash/navigation keep this
}
```

- Frames travel over a dedicated `MessagePortMain` (`MessageChannelMain`, posted once as `frames:port`) as `{workerId, seq, ts, width, height, jpeg: ArrayBuffer}`; no base64 string, no data URL, no `swarm:previews` IPC (delete it with `getSwarmPreviews`). Renderer acks each frame; the hub withholds the CDP ack until the renderer ack **and** the `1/maxFps` interval have passed.
- The hub never calls `debugger.attach` or `debugger.detach` itself; it asks the worker's `ActionExecutor` for the shared session and adds a listener. If the executor detaches, the hub moves that worker to `capturePage` fallback and flags `source`.
- No `Page.bringToFront`. Empty `NativeImage` is never forwarded. Frames are not persisted or sent to a model (policy #248).
- Idle page: no frames arrive, which is normal; the tile shows `lastFrame()` and an age, not "Rendering...".
- `layout:report` / `WorkerPresentation` source of truth is ADR 0012; the hub subscribes to presentation changes, it does not decide visibility.

## Acceptance test (to implement in #232, run in the real app, Windows plus one other OS)

1. 5 fixture workers on an animated page (the `VISIBILITY_HTML` page or a fixture equivalent), Grid mode. `window.__tileStats` (test mode) shows every tile with at least 5 frames in the first 2 s (expected about 25 at 15 fps) and at least 3 distinct frame hashes; the OS screenshot (`scripts/dev/os_screenshot.ps1`) regions of each tile differ between two samples 1 s apart.
2. Budget, from `scripts/dev/spike_live_view.mjs --only tile-screencast15,tile-capturePage10,stage-none --reps 1`: at N=6, at least 14 fps per tile and main-process CPU at most 25 % of one core (measured 13.7 to 17.5), at N=10 at most 35 % (measured 22.9); page rAF at least 90 % of the stage reference.
3. A worker whose view is parked shows a still younger than 10 s and the "paused" badge; navigating or crashed worker keeps its last frame with a badge.
4. `grep -rn "getSwarmPreviews\|swarm:previews" src` is empty; Grid with 3 tabs renders (the run01 D1 repro).
5. Minimise the window and restore it: tiles resume without reload.

## Not measured (do not infer)

macOS and Linux; real Windows 100 % / 150 % display settings (this machine is at 125 %; the Chromium forced factor was not used for this spike); 20+ workers (N=10 is the maximum measured, 1.3 to 1.4 GB total working set); video, WebGL, fullscreen pages; GPU process crash; sleep/wake; true glass-to-glass latency; screenshots for the model under zoom; `Emulation.setDeviceMetricsOverride` as a zoom substitute; other applications occluding the window (the harness was always-on-top); more than two repetitions of any cell; energy use.
