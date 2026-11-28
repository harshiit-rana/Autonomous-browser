# Aegis Motion & Frame-Budget Architecture (#234 [LIV-03])

## Design Principles
1. **Truth over theatre:** Every animation intent (`ChoreographyEngine`) is generated directly from a real dispatched runtime event (`worker:event`, `evidence:event`, `presence:event`, `mission:status`, or Motion Lab replay). No fake idle animations exist and animations never delay or block agent loops.
2. **GPU-composited properties only:** Intents only animate `transform` and `opacity` (defined via CSS custom properties in `src/renderer/tokens.css`).
3. **Frame budget & automatic degradation:** `FrameBudgetMonitor` samples `requestAnimationFrame` frame deltas in `Full` mode. If the rolling `p95` frame time exceeds **20 ms** continuously for **3,000 ms**, motion automatically downgrades to **Reduced** mode (short opacity fades only, zero transform motion).
4. **Accessible reduced-motion & photosensitivity safety:**
   - Honours `@media (prefers-reduced-motion: reduce)` immediately with zero `transform` animations.
   - User-selectable in Settings: `Motion: Full / Reduced / Off` (`AppSettings.motionMode`).
   - All periodic/pulsing states (`approval_beacon`, `error_shake`, `completion_pulse`) enforce `PHOTOSENSITIVITY_MIN_PERIOD_MS = 350 ms` (**< 3 flashes/sec** ceiling).
5. **High-rate coalescing:** Out-of-order/duplicate `seq` events are ignored, stale intermediate pointer moves are dropped if lag > 250 ms, and rapid `scroll` bursts within 120 ms collapse into a single `scroll_glide`.

## Motion Lab (`?lab=1` / `src/renderer/lab.html`)
Dev and CI inspection tool that replays recorded fixtures from `fixtures/events/*.json` (`single.json`, `swarm3.json`, `approval_error.json`) or stress-tests 10 workers at 50 events/s from `0.25x` to `8x` speed while displaying live p95 frame time.
