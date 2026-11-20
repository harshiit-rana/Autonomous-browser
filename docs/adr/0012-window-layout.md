# ADR 0012: Window and layout architecture with native views

- Status: proposed (design spike, no product code changed)
- Issue: #237. The issue text names the file `0012-chrome-layout.md`; the coordinator asked for `0012-window-layout.md`, which is what exists.
- Date: 2026-11-20
- Scope of evidence: **Windows 11 only** (10.0.26300), Electron 33.4.11, display 1920x1080 at 125 % (native). DPR 1.0 and 1.5 come from Chromium's `--force-device-scale-factor`, **not** from the Windows display setting; real Windows 100 % and 150 % settings were not tested (changing the user's display scaling on a shared machine was out of bounds). macOS and Linux were not measured.

## Context

Run01 measured the current behaviour (not repeated here): DOM modals are only visible because `ViewManager.relayout` shrinks the page view to 0x0 (D12), chrome-DOM overlays are invisible above the native view (D2), the chrome overflows at 800x600 (D11), and the native view was 1060 px wide against a 1075 px DOM viewport (15 px unexplained). #237 asks for a pattern for modals and panes above native views, measured layout instead of constants, and Stage/Grid/Theatre/Compact modes.

## How it was measured

Harness: `scripts/dev/spike_layout.mjs` (+ `spike_layout_preload.cjs`, `spike_common.mjs`, `os_screenshot.ps1`, `os_click.ps1`). It is a stand-in for the product, not the product: a window with the product's titlebar settings (`titleBarStyle: 'hidden'`, overlay 38 px, min 800x600) and a chrome page that copies the structure that matters (40 px titlebar, 48 px toolbar = the 88 px constant, flex `#webview-viewport`, 5 px `#pane-resizer`, 320 px drawer), one page `WebContentsView` with the product's `webPreferences`, and a transparent "overlay UI view" holding a scrim and a dialog. Pixels come from real OS screenshots; clicks and the Esc key are real OS input (pid-guarded `os_click.ps1`), not CDP; native view geometry comes from the Win32 child windows (`os_screenshot.ps1 -Children`). The real `index.html` was not driven in this spike; the run01 numbers for it stand. Raw output: `docs/audits/evidence/spikes/layout/` (`results_native.json`, `results_dpr1.json`, `results_dpr1.5.json` for the modal and resize parts, run logs, `shots/`). One repetition each.

## Results (125 % native unless stated)

### Modal above a native page view

The dialog card (480x300 DIP, `#ffd54f`) is counted in the OS screenshot. Reference = card with the page view hidden: 216,750 px.

| Pattern | Card visible | Page visible behind | Click on the dialog's OK | Click on the page button behind the scrim | Esc |
|---|---|---|---|---|---|
| DOM modal in the chrome renderer, page view left as is | **0 px (0 %)** | yes | not reachable | reaches the page | n/a |
| (a) DOM modal, page view hidden (`setVisible(false)`) | 216,750 px (reference) | **no (0 orange px)** | works | n/a | works |
| (b) overlay UI view (transparent `WebContentsView`, last child, scrim + dialog) | **99.6 %** (99.5 % at 100 %, 99.4 % at 150 %) | **yes, dimmed** (13,781 dimmed px against 13,762 px of the undimmed button) | **+1** | **0 (blocked, correct for a modal)** | reaches the overlay (`['Alt','Escape']`, Alt is the helper's focus trick) |

Overlay UI view cost: cold create + load 238 ms; showing a preloaded view (addChildView + setBounds + dialog open until two rAFs in its renderer) 11.9 ms p50 / 12.3 ms p95 over 20 runs. That is renderer-side time; compositor and OS present time were not measured.

### Parking an idle overlay view (it must not eat clicks)

One real click on the page button with the overlay's dialog closed:

| Idle overlay state | Click reached the page |
|---|---|
| attached, full size, transparent | **no (0 of 1)** |
| `setVisible(false)` | yes |
| `setBounds(0,0,0,0)` | yes |
| `removeChildView` | yes |

So a transparent full-size view is not click-through (this is also what rules it out as the presence layer, ADR 0011) and must be parked with `setVisible(false)`; the view and its renderer stay alive.

### Z-order

`ViewManager.setActiveTab` calls `contentView.addChildView(tab.view)`. In the spike, re-adding the page view moved it above the overlay UI view (children bottom to top became `['overlayUI','page']`) and the dialog fell from 216,750 px to **0**; re-adding the overlay restored 216,750. Whoever adds a view last wins, so one owner must re-assert the order after every add.

### Hiding a page view, as the page sees it

For each of `setBounds(0,0,0,0)` and back, `setVisible(false)` and back, `removeChildView` and `addChildView`, and `x=-6000` and back: the page's `innerWidth x innerHeight` stayed 1075x728 throughout, the page received **0 resize events**, and its rAF stopped (0/s) while hidden. (ADR 0010 shows that a view that was never shown starts with a 0x0 viewport and that hidden or covered views freeze, so hiding is not the same as running in the background.) The 0x0 trick of run01 and `setVisible(false)` are equivalent for the page; `setVisible(false)` needs no bounds bookkeeping.

### Measured layout instead of constants

The chrome renderer reports `#webview-viewport` with a `ResizeObserver` (`ipcRenderer.send('layout:report', rect)`), and the main process applies `setBounds(round(rect))`, with the view origin equal to the report origin (chrome DOM and content area share an origin; `getBounds()` equalled `getContentBounds()`, frame delta 0x0 for `titleBarStyle:'hidden'`).

| Window (DIP) | DOM viewport rect | Measured layout: view bounds minus DOM rect | Hardcoded constants (88 px, `width - 320`): minus DOM rect |
|---|---|---|---|
| 1400x816 | 1075x728 at (0,88) | 0, 0, 0, 0 | width **+5** |
| 1000x700 | 675x612 | 0, 0, 0, 0 | width +5 |
| 800x600 | 475x512 | 0, 0, 0, 0 | width +5 |
| back to 1400x816 | 1075x728 | 0, 0, 0, 0 | width +5 |

Same result at forced DPR 1.0 and 1.5 (every size, error 0 for measured, +5 for constants). The +5 is the pane resizer's width: constants drift as soon as CSS changes. **The 15 px gap from run01 (1060 vs 1075) was not reproduced**: in the real app it comes from the product's own constants, not from window frame metrics (frame delta 0x0 here).

Timing: after `win.setSize`, the report arrived and the view matched the DOM rect in 11 to 18 ms (single steps). A 41-step drag simulation (1400 to 800 wide, 16 ms apart): `setSize` to report p50 12.1 / p95 16.1 / max 17.9 ms at 125 % (15.0 / 16.1 / 18.0 at 100 %, 14.9 / 16.1 / 20.3 at forced 150 %); the view equalled the DOM rect to within 1 px in all 41 samples at each DPR, but those samples were taken right after the report, so they show correctness, not the one-frame mismatch a user could see during a real drag. Maximise (by API): view 1211x728 equal to DOM rect, error 0.

Native HWND geometry matches the expectation `round(DIP x scale)`: at 125 % the page view's `Chrome_RenderWidgetHostHWND` was 1344x910 px for 1075x728 DIP (1343.75 rounds to 1344) and 594x640 for 475x512; at 100 % 1075x728 and 475x512; at forced 150 % 1613x1092 and 713x768 (all position and size equal to the prediction, error 0 px). Integer window DIP sizes produced integer DOM rects in every case, so **fractional DOM rects (percent-based panes, zoomed chrome, fractional window sizes) were not exercised**.

### Keyboard focus with a native page view

With the page view focused, a real Esc key press reached the page (`pageSawKeys: ['Escape']`) and the main process's `before-input-event` on the page's `webContents` (`['Escape']`), and reached the chrome renderer **0** times. With the chrome focused it reached the chrome renderer once and the page 0 times. So an Esc handler in the chrome DOM does not run while the page has focus; the main process must forward it. Tab/Shift+Tab and Ctrl+L were not exercised.

## Decision

1. **Modals, settings, plan preview and approvals live in one overlay UI view** (pattern b): a transparent `WebContentsView`, last in z-order while open, `setVisible(false)` when closed. The page stays visible, dimmed, behind a scrim. The view is created once at startup (238 ms cold) and shown in about 12 ms. Pattern (a) (hide the page) is rejected for modals; it stays available as an explicit "page hidden" state only for layouts that really replace the page.
2. **A single z-order owner, `WindowStack`, is the only code allowed to call `contentView.addChildView`/`removeChildView`.** After every add it re-asserts the order bottom to top: page/worker views, then the overlay UI view. The presence layer is a separate click-through window (ADR 0011) and is not in this stack. `ViewManager.setActiveTab` becomes a request to `WindowStack`.
3. **Layout is measured.** The chrome renderer reports the rectangles of its panes (`layout:report`: viewport rect and, in Grid, every tile rect, as `getBoundingClientRect` values in DIP relative to the content area, plus `dpr` and a sequence number) on `ResizeObserver` and on window resize; the main process applies them. `topChromeHeight`, `drawerWidth` and the `bounds.width - drawerWidth` arithmetic in `view_manager.ts relayout` are deleted. Rounding rule: `x = round(x)`, `y = round(y)`, `right = round(x + w)`, `bottom = round(y + h)`, `w = right - x`, `h = bottom - y` (the spike only saw integer rects; this rule is the contract so that adjacent panes never leave a seam at fractional scales).
4. **Modes**: Stage (one page view at the viewport rect), Grid (the worker views themselves are the tiles at the reported tile rects, ADR 0010), Theatre (Stage plus a strip of visible worker tiles), Compact (below 900 DIP wide the drawer becomes a bottom sheet). Every worker that should run is **visible**; non-visible views are parked with `setVisible(false)` and are frozen (ADR 0010); never `setBounds(0,0,0,0)` and never leave a transparent view attached.
5. **Keys:** each page view gets a `before-input-event` handler that forwards Esc, Ctrl+L, Ctrl+T/W and Tab-out to the chrome renderer (or closes the modal directly) so that shortcuts work while the page has focus. When the overlay UI view opens it takes focus (`webContents.focus()`), and returns focus to the previously focused view on close.
6. **Resizable drawer** (`#pane-resizer`) changes only CSS; no main-process constant exists to keep in sync.

### Rejected

| Option | Measured reason |
|---|---|
| Leave DOM modals in the chrome renderer | 0 % of the card visible above the page view. |
| Hide the page for every modal (pattern a, and the run01 0x0 trick) | card fully visible, but the page disappears (0 orange px) instead of dimming; run01 D12. Equivalent for the page whichever hiding call is used; only needed for modes that replace the page. |
| Keep a full-size overlay view attached when idle | swallows the user's clicks (0 of 1 reached the page). |
| Hardcoded `topChromeHeight` / `drawerWidth` | +5 px error in the harness at every size (the resizer width), 15 px in run01's real app; drifts with CSS. |
| Re-add views from several places | page re-add buried the dialog (216,750 px to 0). |

## Interface the implementation must follow

```ts
// IPC (names are the contract)
// 'layout:report'  renderer -> main : LayoutReport
export interface Rect { x: number; y: number; width: number; height: number }       // DIP, relative to the window content area
export interface LayoutReport { seq: number; dpr: number; mode: 'stage' | 'grid' | 'theatre' | 'compact'; viewport: Rect; tiles?: { workerId: string; rect: Rect }[] }
// 'overlay:set' main <-> overlay UI view : { open: boolean; dialog?: 'settings' | 'plan-preview' | 'approval'; payload?: unknown }

// src/main/window_stack.ts
export class WindowStack {
  constructor(win: BrowserWindow);
  addPageView(id: string, view: WebContentsView): void;       // always goes below the overlay UI view
  showPageView(id: string, rect: Rect | null): void;          // rect null => setVisible(false); never 0x0
  openOverlay(): void; closeOverlay(): void;                  // overlay: setBounds(contentBounds), setVisible(true) / setVisible(false); focus handling
  readonly order: () => readonly string[];                    // bottom to top, for tests: [...pages, 'overlayUI']
  applyReport(r: LayoutReport): void;                         // rounding rule above
}
```

- `LayoutReport` is sent on every `ResizeObserver` callback and window `resize`; the main process applies the latest `seq` only. On `display-metrics-changed` and `maximize/restore` the renderer re-sends.
- Invariants checked at runtime in test mode: `WindowStack.order()` ends with `overlayUI` whenever a dialog is open; no view other than the overlay has bounds that cover the whole content area while it is `visible`; a closed overlay is not attached-and-visible.

## Acceptance test (to implement in #237, real app, Windows plus one other OS)

1. Page loaded (animated or orange-button fixture). Open Settings: an OS screenshot shows at least 98 % of the dialog card's pixels (reference 216,750 px at 125 %; spike 99.4 to 99.6 %) **and** the page still visible dimmed (at least 95 % of the undimmed button's pixel count); a real OS click on the dialog's OK button is received (+1) and a click on the page button behind the scrim is not (0).
2. Real Esc key with the page focused closes the dialog (forwarded through `before-input-event`); with the dialog focused it also closes it.
3. Resize 1400x900 (clamped to the work area) to 800x600 and back, at DPR 1 and 1.5 (forced or real): after each step, within 50 ms, every page/tile view's bounds equal its reported rect within **1 px** (spike: 0 px; settle 11 to 18 ms), and the Win32 `Chrome_RenderWidgetHostHWND` rect equals `round(rect x scale)` within 2 px.
4. After `setActiveTab` while a dialog is open, the dialog is still visible (`WindowStack.order()` ends with `overlayUI`).
5. With the dialog closed, a real click on the page reaches the page (overlay is `setVisible(false)`).
6. At 800x600 the chrome has no horizontal overflow and Compact mode is active (this closes run01 D11; the spike's stand-in chrome does not test it).
7. Maximise, restore, minimise-restore keep view bounds equal to the reported rect.

## Not measured (do not infer)

Real Windows 100 % / 150 % settings and a DPI change while open (moving the window between monitors); macOS and Linux; the real `index.html` chrome (D11 overflow at 800x600, `-webkit-app-region` behaviour, maximise/restore/snap through the custom titlebar, double-click to maximise, window-controls overlay); fractional DOM rects; Tab/Shift+Tab and Ctrl+L routing; focus trap and `role="dialog"` screen-reader behaviour; HTML fullscreen and F11; RTL; devtools docked; Theatre's follow-the-action camera; Grid with many tiles (see ADR 0010); the one-frame visual mismatch during a real mouse drag of the window edge; overlay show latency measured at the compositor; more than one repetition of any cell.
