# Autonomous Browser v1: Product Specification (Issue #103 - [CMP-01])

## Vision
An autonomous desktop AI browser where users state high-level goals in plain language and **autonomous multi-agent swarms execute them visibly, safely, and in parallel**. Users observe worker tabs navigate, click, type, and extract structured data in real-time with full human-in-the-loop control (instant pause, manual takeover, approval gates, and flight recorder replays).

---

## 1. Personas & Core Jobs-to-be-Done (JTBD)

### 1. Power Researcher & Market Analyst
- **Job:** "Compare RTX 4090 pricing, stock, and return policies across 10 e-commerce sites simultaneously."
- **Autonomy Mode:** Parallel read-only swarm.
- **Output:** Truthful, source-cited markdown report with CSV formula-safe exports.

### 2. Operator & Personal Executive Assistant
- **Job:** "Fill out vendor onboarding form, handle multi-step wizard, and submit when ready."
- **Autonomy Mode:** Autonomous safe writes with explicit human confirmation for financial/destructive actions.
- **Output:** Verified form submission with audit trail and change summary.

### 3. Continuous Background Monitor
- **Job:** "Check product availability every 60 minutes during business hours; notify me only when stock changes."
- **Autonomy Mode:** Standing task ("watch") with hard daily budget caps, quiet hours, and truthful away digests.
- **Output:** Activity inbox notifications with evidence links.

### 4. QA Automation Engineer & Developer
- **Job:** "Drive browser flows programmatically via Model Context Protocol (MCP) or CLI runner."
- **Autonomy Mode:** Scriptable / API driven.
- **Output:** Deterministic execution traces, CDP timelines, and oracle assertions.

---

## 2. Measurable Targets & Exit Thresholds

| Dimension | Metric | v1 Target | Verification Method |
|---|---|---|---|
| **Capability** | Web Arena Fixture Task Success Rate | >= 90% | `tests/test_quality_m8.ts` (#194, #196) |
| **Speed** | Time to First Visible Agent Action | < 1,200 ms | `tests/perf_soak_suite.ts` (#198) |
| **Speedup** | Swarm Parallel Execution (5 workers) | >= 3.5x faster than serial | `tests/test_swarm_m3.ts` (#147) |
| **Safety** | Injection Attack Success Rate (ASR) | < 5% (Target) / Measured live in #249 | Clean-room tokenization & live red-team (#249) |
| **Safety** | Unapproved Irreversible Actions | **0** (Zero tolerance) | `tests/regression_suite.ts` (#158) |
| **Autonomy** | Tasks Needing Zero Human Interventions (Read-only) | >= 85% | `src/evaluation/agent_benchmarks.ts` (#196) |
| **Cost** | Average Cost per Research Task | < $0.05 USD | `src/models/pricing.ts` (#132) |
| **Reliability**| 8-Hour Multi-Mission Soak Heap Growth | < 15 MB RSS | `tests/perf_soak_suite.ts` (#198) |

---

## 3. Core Differentiators vs. Legacy & Competitors
1. **Elastic Swarm Architecture**: Real parallel worker tabs operating independently with work-stealing, barriers, and consensus adjudication (#147–#155).
2. **Safety by Construction (Project Aegis)**: Cryptographic XML boundary isolation, origin ACL enforcement, tokenized secrets vault, and Policy Decision Point (PDP) action gating (#156–#167).
3. **Hybrid Perception**: AXTree accessibility tree pruning, Set-of-Marks visual overlay, and spatial OCR fallback (#118).
4. **Transparent Mission Control**: Live tile grid, live agent cursors, flight recorder replays, and mid-run steering (#134–#146).
5. **Continuous Assistant**: Budget-capped standing watches, unified activity inbox, and truthful away digest (#212).

---

## 4. Explicit Non-Goals (v1 Scope)
The following capabilities are deliberately excluded from v1 and tracked for future iterations:
- **Mobile companion app:** Excluded due to local LAN approval security risks (#167, #192).
- **Enterprise multi-tenant RBAC / SSO:** Excluded until single-user workstation product is finalized (#193).
- **Audio loopback / meeting transcription:** Excluded due to wiretapping / consent legal liabilities (#192).
- **Cloud-hosted fleet orchestration:** Focus is 100% on local, private, on-device workstation execution.
