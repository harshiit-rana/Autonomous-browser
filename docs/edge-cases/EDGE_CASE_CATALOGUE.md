# Autonomous Browser - Comprehensive Edge-Case Catalogues (A - F)

This document tracks all edge-case scenarios across perception, widgets, environment, task semantics, model failure modes, and continuous steering.

## Catalogue A: Page Structure & Rendering (#201 - [EDG-01])
- **Frames & Trees**: Same-origin iframes, cross-origin iframes (OOPIF), nested iframes (3-deep), open/closed shadow DOM, `<dialog>` top layer, `inert`, and `aria-hidden` attributes.
- **Visibility & Layout**: Scrolled containers, sticky/fixed headers covering targets, cookie/consent overlays, transparent click-catchers, `pointer-events: none`, zero-sized targets, CSS transforms, virtualized lists/tables (render-on-scroll).
- **Rendering Modes**: Canvas-only UI, SVG text, `<details>`/`<summary>` toggles, rich editors (`contenteditable`).
- **Locale & Typography**: RTL/bidi, CJK sequences, combining marks, non-breaking spaces in price tags (`$1,599`).
- **Status**: Verified in `tests/test_edge_cases.ts` and `src/perception/dom_extractor.ts`.

## Catalogue B: Interaction & Widgets (#202 - [EDG-02])
- **Pointer & Keyboard**: Hover-only menus, drag & drop, range sliders, keyboard-only roving `tabindex`, shortcuts intercepted by pages (Ctrl+S, Ctrl+F), Enter vs Submit semantics.
- **Inputs**: Native `<select>`, custom comboboxes, async autocomplete, multi-step date pickers, OTP boxes, honeypot inputs (`website_hp`).
- **Timing & State**: Debounced submit buttons, double-submit prevention, CSRF token rotation, autosave race conditions.
- **Status**: Verified in `tests/test_edge_cases.ts` and `src/automation/autonomous_forms.ts`.

## Catalogue C: Environment, Network & System (#203 - [EDG-03])
- **Network**: Offline/online transitions, captive portal interstitials, TLS errors, HTTP 429 rate-limiting with `Retry-After`, HTTP 503 outages, slow 2G high latency.
- **System**: Sleep/wake resume, clock jump / DST shifts, low RAM, disk full simulation (`ENOSPC`).
- **Process**: Worker renderer crashes, GPU process restarts, CDP connection drops.
- **Status**: Verified in `src/testing/fault_injector.ts` and `tests/test_edge_cases.ts`.

## Catalogue D: Task Semantics & User Intent (#204 - [EDG-04])
- **Goals**: Under-specified or ambiguous goals ("cheapest"), contradictory constraints, already satisfied goals, goals conflicting with security policy (refusal).
- **Information Quality**: Conflicting pricing across sources, out-of-stock items, paid/sponsored ad links, regional currency differences.
- **Transactions**: Double-submit guards, cancellation windows, 3-D Secure challenges, terms-of-service gates (never auto-agree without human confirmation).
- **Status**: Verified in `tests/test_edge_cases.ts` and `src/security/action_policy.ts`.

## Catalogue E: Model & Agent-Loop Failure Modes (#205 - [EDG-05])
- **Output Failures**: Hallucinated element refs, truncated JSON, empty content, repeated identical tool calls.
- **Control Flow**: Oscillation detection, infinite loops, runaway subagent spawning, budget caps.
- **Provider Behaviour**: Safety refusals, `max_tokens` limit truncation, circuit breaker trips.
- **Status**: Verified in `src/agent/runtime.ts` and `src/models/concurrency_governor.ts`.

## Catalogue F: Prompts, Threads, Steering & Continuous Work (#217 - [EDG-06])
- **Prompt Workspace**: Empty/whitespace prompts, binary paste, nested template delimiters, locked section tamper attempts.
- **Threads & Steering**: Priority interrupts ("Stop immediately"), mid-run steering, undo stack reversals.
- **Continuous Work**: Standing watch execution, consecutive failure auto-disabling, truthful away digest, panic kill-switch.
- **Status**: Verified in `tests/test_workspace_and_motion.ts` and `tests/test_assistant_m9.ts`.
