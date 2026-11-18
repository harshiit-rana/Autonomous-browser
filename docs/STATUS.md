# Project Aegis - Component Status & Reachability Ledger

> **Last Updated:** 2026-11-18  
> **Audited Modules:** 63 total in `src/`  
> **Reachable from Application Entry Points:** 11 (17%)  
> **Orphaned (Stand-alone / Test-only):** 52 (83%)  
> **Governing Roadmap:** [Milestone Issue #102](https://github.com/harshiit-rana/Autonomous-browser/issues/102)

---

## 1. Executive Summary

This document serves as the truthful source of truth for the codebase status. Following the comprehensive system audit ([Issue #102](https://github.com/harshiit-rana/Autonomous-browser/issues/102)), building blocks previously developed in isolation are systematically triaged:
- **Keep & Hardened:** Core browser shell, view management, input kinematics, and preload bridge.
- **Rewire & Integrate:** Swarm runtime, real LLM calling, perception pipeline, and memory vault.
- **Attic / Triage:** Unused protocols (e.g. `binary_ipc`), non-functional stubs, or features out of scope for v1.

---

## 2. Module Inventory & Disposition Matrix

| Subsystem | Module File | Reachable | Disposition | Owning Issue | Notes |
|:---|:---|:---:|:---:|:---:|:---|
| **Main** | `src/main/index.ts` | Yes | Keep & Harden | #101, #108 | App lifecycle, window creation, IPC registry. |
| **Main** | `src/main/preload.ts` | Yes | Keep & Harden | #105 | ContextBridge security boundary. |
| **Main** | `src/main/view_manager.ts` | Yes | Rewrite | #106 | Tab & WebContentsView coordinator. |
| **Renderer** | `src/renderer/app.ts` | Yes | Keep & Harden | #106, #107 | Chrome controller, sanitized DOM updates. |
| **Core** | `src/core/action_executor.ts` | Yes | Keep & Expand | #120 | CDP pointer & keyboard action execution. |
| **Core** | `src/core/dom_indexer.ts` | Yes | Rewrite | #119 | Shadow DOM traversal & element indexing. |
| **Stealth** | `src/stealth/cursor_overlay.ts` | Yes | Keep | #144 | Visual glowing cursor overlay. |
| **Stealth** | `src/stealth/fingerprint_shield.ts`| Yes | Keep | #166 | Evasion & fingerprint protection. |
| **Stealth** | `src/stealth/keyboard_typer.ts` | Yes | Keep | #120 | Human-like typing cadence. |
| **Stealth** | `src/stealth/mouse_trajectory.ts` | Yes | Keep | #120 | Cubic Bézier trajectory generation. |
| **UI** | `src/ui/omnibar_parser.ts` | Yes | Keep | #133 | Command and URL intent parser. |
| **Planning** | `src/planning/mcts_planner.ts` | No | Rewire | #122 | MCTS decision & lookahead engine. |
| **Planning** | `src/planning/state_snapshot.ts` | No | Rewire | #127 | Page state snapshotting & rollback. |
| **Perception**| `src/perception/axtree_extractor.ts` | No | Rewire | #118 | Accessibility tree pruner. |
| **Perception**| `src/perception/dom_settle_detector.ts`| No | Rewire | #121 | Network/mutation settling engine. |
| **Perception**| `src/perception/som_overlay.ts` | No | Rewire | #118 | Set-of-Marks visual overlay. |
| **Perception**| `src/perception/spatial_reasoner.ts` | No | Rewire | #118 | 2D geometric reasoning & occlusion. |
| **Swarm** | `src/swarm/barrier.ts` | No | Rewire | #147 | CountDownLatch & sync barriers. |
| **Swarm** | `src/swarm/blackboard.ts` | No | Rewire | #146 | Shared evidence ledger. |
| **Swarm** | `src/swarm/coordinator.ts` | No | Rewire | #145 | Task decomposition coordinator. |
| **Swarm** | `src/swarm/health_daemon.ts` | No | Rewire | #153 | Worker heartbeat & recovery watchdog. |
| **Swarm** | `src/swarm/resource_throttler.ts` | No | Rewire | #154 | Tab memory & CPU governor. |
| **Swarm** | `src/swarm/swarm_manager.ts` | No | Rewire | #145 | Background worker pool allocator. |
| **Swarm** | `src/swarm/swarm_worker.ts` | No | Rewire | #145 | Worker unit controller. |
| **Swarm** | `src/swarm/work_stealing_queue.ts`| No | Rewire | #145 | Work-stealing task distributor. |
| **Security** | `src/security/clean_room.ts` | No | Rewire | #156 | Token-level injection sanitizer. |
| **Security** | `src/security/intent_guard.ts` | No | Rewire | #157 | Irreversible action policy gate. |
| **Security** | `src/security/origin_guard.ts` | No | Rewire | #158 | Origin boundary & session isolation. |
| **Security** | `src/security/payment_gate.ts` | No | Rewire | #159 | Transaction interceptor modal. |
| **Security** | `src/security/red_team_suite.ts` | No | Test-only | #200 | Attack vector test battery. |
| **Security** | `src/security/vault.ts` | No | Rewire | #160 | AES-256-GCM credential vault. |
| **Models** | `src/models/model_hub.ts` | No | Rewrite | #128, #129 | Provider-neutral model interface. |
| **Memory** | `src/memory/memory_store.ts` | No | Rewrite | #110, #178 | SQLite FTS5 vector store (Node vs Electron). |
| **Data** | `src/data/clean_room.ts` | No | Deduplicate| #156 | Merge into `src/security/clean_room.ts`. |
| **Data** | `src/data/clipboard_hub.ts` | No | Triage/Attic | #192 | Clipboard hub (non-core). |
| **Data** | `src/data/pagination_crawler.ts` | No | Rewire | #181 | Next-page heuristic crawler. |
| **Data** | `src/data/report_synthesizer.ts` | No | Rewire | #182 | Markdown report generator. |
| **Data** | `src/data/scraping_diff.ts` | No | Rewire | #181 | Page state diffing engine. |
| **Data** | `src/data/table_extractor.ts` | No | Rewire | #181 | HTML table parser to CSV/JSON. |
| **Automation**| `src/automation/alert_bridge.ts` | No | Rewire | #183 | Event alert dispatcher. |
| **Automation**| `src/automation/batch_runner.ts` | No | Rewire | #184 | Parameterized batch execution. |
| **Automation**| `src/automation/flight_recorder.ts`| No | Rewire | #143 | Session recording & replay. |
| **Automation**| `src/automation/form_filler.ts` | No | Rewire | #184 | Semantic form filler. |
| **Automation**| `src/automation/research_agent.ts`| No | Rewire | #115 | Research agent loop. |
| **Automation**| `src/automation/task_scheduler.ts` | No | Rewire | #183 | Cron & recurring mission runner. |
| **Enterprise**| `src/enterprise/binary_ipc.ts` | No | Remove | #105 | Redundant custom binary protocol. |
| **Enterprise**| `src/enterprise/eval_harness.ts` | No | Rewire | #196 | Benchmark evaluation runner. |
| **Enterprise**| `src/enterprise/page_translator.ts`| No | Triage/Attic| #193 | Translation helper. |
| **Enterprise**| `src/enterprise/rbac.ts` | No | Triage/Attic| #193 | Enterprise RBAC (v2 non-goal). |
| **Native** | `src/native/binary_ipc.ts` | No | Remove | #105 | Redundant custom binary protocol. |

---

## 3. Policy & Verification
- No new module may be committed without an active import from a reachable app entry point or declared test.
- Verified via `scripts/audit_reachability.mjs`.
