# ADR 0011: Agent presence layer above native views

- Status: proposed (design spike, no product code changed)
- Issue: #233 (LIV-02)
- Date: 2026-11-20
- Scope of evidence: **Windows 11 only** (10.0.26300), Electron 33.4.11. Native display 1920x1080 at 125 %; DPR 1.0 and 2.0 were produced with Chromium's `--force-device-scale-factor` (not the Windows display setting). macOS and Linux were not measured.

## Context

Run01 measured that DOM overlays in the chrome renderer are invisible above the native `WebContentsView` (a probe at z-index 2147483647 changed 0 of 2,850 pixels in the real window) and that nothing ever emits a presence event. `src/stealth/cursor_overlay.ts` injects a cursor into the page's own DOM, where page JavaScript can see it. #233 needs one mechanism that is visible to the user, unreachable from page JavaScript, absent from model screenshots, positioned from executor coordinates, and that does not break the user's clicks.

## How it was measured

Harness: `scripts/dev/spike_presence.mjs` with `scripts/dev/os_screenshot.ps1` (real OS screen copy), the new `scripts/dev/os_click.ps1` (a real OS mouse click via `SetCursorPos` + `mouse_event`, refused unless the window under the point belongs to the harness process; the cursor is restored afterwards) and `spike_common.mjs`. CDP `Input.*` and `sendInputEvent` were deliberately **not** used for pass-through, because they bypass native hit-testing. The harness is a window with the product's titlebar settings, a chrome page, one page `WebContentsView` and a static page with an orange button at CSS (300,200). Each option draws a 20x20 DIP magenta square centred on the button. Per condition it reports: magenta pixels inside the page rectangle of a real OS screenshot (expected 625 at 125 %), the centroid error against the orange button's centroid measured from a baseline OS screenshot, pixels changed outside the marker between a no-overlay and an overlay screenshot (noise between two identical captures was 0), a real OS click on the button centre (the worst case: the marker is exactly on it), page-side detection (a scan of globals, nodes with names matching aegis/agent/presence/cursor/ripple, extra nodes, MutationObserver records), magenta pixels in `capturePage()` and in CDP `Page.captureScreenshot`, and z-order after the page view is re-added. Raw output: `docs/audits/evidence/spikes/presence/` (`results_native.json` 125 %, `results_dpr1.json`, `results_dpr2.json`, run logs, OS screenshots in `shots/`). One repetition per condition; the user's real mouse cursor was moved by the click tests.

Options: **N** nothing (control), **A** DOM element in the chrome renderer at z-index max, **B** a second full-size transparent `WebContentsView` above the page view (`pointer-events:none`), **B2** a cursor-sized (48x48 DIP) transparent view moved with `setBounds`, **C** a transparent frameless child `BrowserWindow` (`focusable:false`, `setIgnoreMouseEvents(true, {forward:true})`) over the page area, **D** an element injected into the page DOM (`position:fixed; pointer-events:none`, what `cursor_overlay.ts` does), **E** CDP `Overlay.highlightRect`.

## Results

Native 125 %, zoom 1.0. "Visible px" is magenta pixels inside the page view rectangle of the OS screenshot (625 if drawn). "Click" is the page's click counter delta after one real OS click on the button centre (1 = the click reached the page). "capturePage px" is marker pixels in `webContents.capturePage()`; "CDP px" in `Page.captureScreenshot`.

| Option | Visible px | Centroid error (px) | Changed px outside marker | Click | Offset click, 60 DIP right of the marker | capturePage px / CDP px | Page can see it |
|---|---|---|---|---|---|---|---|
| N control | 0 (nothing drawn) | n/a | 0 | 1 | n/a | 0 / 0 | no |
| A chrome DOM, z-index max | **0** | n/a | 0 | 1 | n/a | 0 / 0 | no |
| B full-size overlay view | 625 | 0.53, 0.54 | 0 | **0** | **0** | 0 / 0 | no |
| B2 cursor-sized overlay view | 625 | 0.53, 0.54 | 0 | **0** (inside its 48x48) | **1** | 0 / 0 | no |
| C click-through child window | 625 | 0.53, 0.54 | 0 | **1** | n/a | 0 / 0 | no |
| D page-injected element | 625 | 0.53, 0.54 | 0 | 1 | n/a | **625 / 625** | **yes**: named node found, 1 extra node, 3 to 7 mutation records |
| E CDP `Overlay.highlightRect` | 930 (larger than the 625 requested) | **119.5, 72.0** | 0 | 1 | n/a | **930 / 930** | no node, 4 to 8 mutation records |

At 125 % and 100 % no option changed any pixel outside the marker (so the transparent overlays do not tint or hide the page; noise between two identical captures was 0). At forced DPR 2.0, zoom 1.0, D and E show 1,942 changed pixels elsewhere in the window (E drew nothing at all there); that was not investigated.

Position accuracy, centroid error of the marker against the page button, in physical pixels (dx, dy):

| Condition | B / B2 / C / D |
|---|---|
| 125 %, zoom 1.0 | 0.53, 0.54 (about 0.4 DIP) |
| 125 %, page zoom 1.5 | B -0.5, 0.06; B2 0.5, 1.06; C -0.5, 0.06; D -0.5, 0.06 |
| 100 % (forced 1.0), zoom 1.0 / 1.5 | 0.01, 0.01 / 0.02, 0.04 |
| 200 % (forced 2.0), zoom 1.0 | 0.02, 0.06 (B, B2, C, D) |
| 200 % (forced 2.0), zoom 1.5 | **invalid**: the forced-2.0 window is only 480x270 DIP, the zoomed button is clipped and all options show the same 51 px offset, a harness artefact; not counted |

Mapping used by B, B2, C, D: marker position in the page view's DIPs = page CSS px x `getZoomFactor()`, plus the view origin; no DPR term was needed. Option E was inconsistent: 119.5 px off at 125 % zoom 1.0, 0.01 px at 100 % zoom 1.0, 190 px off at 100 % zoom 1.5, not drawn at all at 200 %. It is not a usable positioning mechanism.

Other measurements:

- **Z-order (B, B2):** re-adding the page view with `contentView.addChildView(pageView)` (what `ViewManager.setActiveTab` does) moved the page to the top of `contentView.children` (order bottom to top became `['overlay','page']`) and the marker pixels fell from 625 to **0**. Re-adding the overlay view restored 625 (same at 100 % and 200 %: 400 and 1600). The overlay is only above the page for as long as nobody re-adds the page.
- **Focus:** option B moved focus into the overlay's `webContents`: the page's `document.hasFocus()` became false and it received a blur event (blurs 0 to 1); the main window itself stayed focused. Option C kept the main window focused after `showInactive()` (`mainFocusedAfterOverlayShown: true`). The page's cumulative blur/focus counters did not change when C appeared (1/1 before and after, the same as after B2), but D and E, which add no window at all, show +2/+2, so the harness's own window activation (OS screenshot and click helpers) also produces events: page-visible focus events for C are **not conclusively isolated**.
- **Option C and the parent window:** with the resize/move handlers registered before the change, the overlay followed `win.setBounds` in **20.3 ms** (2 events; the earlier run reported "not within 500 ms" because the harness registered its listener after the synchronous event had fired, kept in `run_native.log` history). The overlay was hidden while the parent was minimised and visible again after restore without code. Drag-time (continuous) tracking, maximise by double-click, snap layouts, Alt-Tab/taskbar presence of a `skipTaskbar` child, fullscreen and multi-monitor DPI change were **not measured**.
- **Cost of moving the cursor at 60 Hz for 10 s** (updates 59.9 to 60/s), CPU as percent of one core, above the same overlay idle (all about 0): B main 3.2 / GPU 7.0 / renderer 7.1; B2 (`setBounds` each tick) main **10.5** / GPU 7.5 / renderer 0.5; C main 3.8 / GPU 7.8 / renderer 7.5; D main 1.8 / GPU 6.9 / renderer 10.5. Round trip of `executeJavaScript` p50/p95: B 0.53/0.69 ms, B2 0.07/0.84 ms (`setBounds`), C 1.07/1.24 ms, D 0.58/0.79 ms. (An earlier run of the same harness gave B2 main 13.7 %, C 4.3 %.) Perceived smoothness was not evaluated.
- The page-side scan also reported `IDBCursor`/`IDBCursorWithValue` for every option including the control: the pattern `cursor` matches those standard globals. They are not overlay traces.

## Decision

**Option C is the presence layer on Windows (and macOS where `setIgnoreMouseEvents` forwarding exists): one transparent, frameless, non-focusable, click-through child `BrowserWindow` per application window, covering the content area, drawing every worker's cursor, ripple, caret bubble, highlight and beacon.** It was visible (625/625 px), accurate to about half a pixel at 100 %, 125 % and 200 %, let the user's real click through (1/1), added no node or global to the page and no pixels to `capturePage()` or to CDP screenshots (0/0), kept the main window focused, followed the parent in 20 ms and cost about 4 % of main CPU (7.8 % GPU) while animating at 60 Hz.

**Option B2 (a cursor-sized overlay view moved with `setBounds`) is the cross-platform fallback** where C cannot be used (Linux, or any platform where the click-through window is unavailable). It passes clicks outside its 48x48 square and swallows them inside it, steals page focus unless the page view is re-focused, and costs more (10.5 to 13.7 % of main at 60 Hz in two runs).

**Modals and approval UI do not use this layer**: they must capture input and live in the overlay UI view of ADR 0012 (option B in the terms above, which swallows clicks by design). Presence stays click-through.

### Rejected

| Option | Measured reason |
|---|---|
| A chrome-DOM overlay | 0 of 625 pixels visible above the page (confirms run01: 0 of 2,850). |
| B as presence (full-size overlay view) | Swallows every click and the offset click (0 of 1, 0 of 1); steals page focus (page blur, `hasFocus()` false); loses its stacking whenever the page view is re-added. Correct only for modals. |
| D page injection | Visible, but a page script finds the node by name, counts 1 extra node and 3 to 7 mutation records, and the marker is in `capturePage()` and CDP screenshots (625 and 625 px), so it would reach the model. Violates "unreachable from page JavaScript" and "never in model screenshots". |
| E CDP `Overlay.highlightRect` | Drawn into the page's own frames (930 px in `capturePage()` and CDP screenshots, so the model would see it), and its mapping was inconsistent (119.5 px, 0.01 px, 190 px error, or invisible depending on scale). The `Overlay` domain is also a DevTools tell. Not even useful as the optional element-box highlight from the issue text. |

## Interface the implementation must follow

```ts
// src/main/presence_layer.ts (owner of the click-through window; replaces ViewManager.broadcastPresence)
export type PresenceKind = 'move' | 'click' | 'type' | 'scroll' | 'think' | 'needs_you' | 'target';
export interface PresenceEvent {
  workerId: string; seq: number; ts: number; kind: PresenceKind;
  x: number; y: number;                 // CSS px, viewport-relative, top-level frame space (iframe offsets already added), PRE-zoom
  zoom: number;                         // webContents.getZoomFactor() at dispatch time
  path?: { x: number; y: number; t: number }[]; // the real dispatched mouse path, CSS px, ms since dispatch
  quadRect?: { x: number; y: number; w: number; h: number }; // target box, same space
  label?: string; textPreview?: string; // textPreview masked (bullets) for password inputs
}
export class PresenceLayer {
  constructor(window: BrowserWindow, stack: WindowStack /* ADR 0012 */);
  emit(e: PresenceEvent): void;         // coalesce: at most 60/s per worker, lag behind the action <= 250 ms
  setViewRect(workerId: string, rectDip: Rect | null): void; // from the stack: where that worker's view is, content-relative DIP
}
```

- Overlay position in the content area (DIP) = `viewRect.origin + (x * zoom, y * zoom)`. No extra DPR factor; this reproduced the target within 0.6 px at 100 %, 125 % and 200 % and within about 1 px at zoom 1.5 (125 % and 100 %).
- The overlay window: `parent: win`, `transparent: true`, `frame: false`, `focusable: false`, `skipTaskbar: true`, `hasShadow: false`, `show: false` then `showInactive()`, `setIgnoreMouseEvents(true, { forward: true })`; bounds set from `win.getContentBounds()` on every `move`, `resize`, `maximize`, `unmaximize`, `restore`, `enter/leave-full-screen` and display-metrics change, with the listener registered before the change is made (the move event fires synchronously inside `setBounds`). It loads `src/renderer/presence.html` with its own preload and a dedicated `MessagePort`; it has no network and no navigation.
- The channel `presence:event` (already in `IPC_CHANNELS`) stays the main-to-overlay event name; the old chrome-DOM `#presence-overlay` and `CURSOR_OVERLAY_SCRIPT`, `Page.addScriptToEvaluateOnNewDocument` injection and the `__aegis*` globals are deleted.
- `ActionExecutor` emits `PresenceEvent` from the coordinates it already computes, in the top-level frame's CSS pixels, and the path it actually dispatched; it does not draw anything.
- Fallback B2 implements the same `PresenceLayer` interface behind a `PresenceBackend` choice; never both at once.
- Presence never appears in `capturePage()` or CDP screenshots because it is not part of any page surface (asserted by the test below). Set-of-Marks drawing for the user uses the same layer; SoM for the model is a separate request.

## Acceptance test (to implement in #233, real app, Windows plus one other OS)

Drive with `scripts/dev/spike_presence.mjs`-style checks against the product window:

1. For DPR 1 and 2 (forced factor is acceptable) and page zoom 1.0 and 1.5: emit a `target` event at a fixture button's centre; an OS screenshot shows the marker within **3 px** of the button's centroid (spike: below 1.1 px) and at least 95 % of the expected marker pixels.
2. A real OS click (`os_click.ps1`) on that button with the marker drawn on it reaches the page (click counter +1), and 60 DIP aside as well.
3. A fixture page scans `window` and `document` for any node, global, attribute or mutation record containing `aegis`, `__agent`, `presence`, `ripple` (ignoring the standard `IDBCursor*` names) and finds none; mutation records caused by the overlay are 0.
4. `capturePage()` and CDP `Page.captureScreenshot` of the page view contain 0 marker pixels.
5. After `ViewManager.setActiveTab` re-adds a page view, the marker is still visible (the window is separate; this must hold without a re-assert).
6. The main window stays focused and the page's `document.hasFocus()` does not change when the layer appears (blur/focus counters unchanged, measured without OS-helper activations).
7. Window move and resize: overlay within 2 px of the content rect within 50 ms of the event (spike: 20.3 ms); minimise hides it, restore shows it.
8. 60 Hz cursor animation for 10 s: main CPU at most 10 % of one core (spike: 3.8 %), updates at least 59/s, lag behind real actions at most 250 ms.

## Not measured (do not infer)

macOS and Linux (transparent click-through windows behave differently; `forward:true` is not available on Linux); real Windows 100 % and 150 % settings; multi-monitor with different DPR; fullscreen video or HTML fullscreen pages (an owned window may sit above or below them); `cursor:none` pages; elements inside iframes and shadow DOM (the mapping only covers the top-level frame and a zoom factor); Alt-Tab and taskbar behaviour of the child window; snap/maximise by real titlebar gestures; drag-time tracking latency (only post-event sync was timed: 20.3 ms); touch input; screen readers; smoothness of the animation as seen by a person; 100 actions/min coalescing; whether a screen recorder or remote-desktop session captures the overlay; multiple application windows. The harness's own focus activations make page-visible focus events for C, D and E inconclusive.
