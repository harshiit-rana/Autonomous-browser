# Architectural Reachability Audit & Historical Traceability Map

## Executive Summary
This document records the historical remediation initiated in Issue #102 and points to the live, programmatically-generated status ledger.

For the live reachability status of all modules in `src/`, consult:
- **Live Status Document:** [docs/STATUS.md](../STATUS.md) (generated automatically via `npm run docs:status`)
- **Machine-Readable Audit:** [docs/reachability_audit.json](../reachability_audit.json) (generated via `node scripts/audit_reachability.mjs`)
- **Active Completion Program:** [Issue #218 - Completion Program Index](https://github.com/harshiit-rana/Autonomous-browser/issues/218)

---

## 1. Inventory of Audited Defects & Historical Resolutions

| Defect ID | Description | Issue | Resolution | Verification Test |
|---|---|---|---|---|
| **D-01** | Preload invoked `agent:action`; main registered separate channels | #105 | Unified IPC contract in `ipc/contract.ts` | `tests/test_agent_runtime.ts` |
| **D-02** | Renderer tab ID mismatch (`tab_` vs integer ID) | #106 | Unified UUID tab ID generation in `view_manager.ts` | `tests/regression_suite.ts` |
| **D-03** | `innerHTML` raw injection into privileged chrome | #107 | Replaced with strict `textContent` and element builders; CSP forbids unsafe-eval | `tests/regression_suite.ts` |
| **D-04** | `userData` path forced under `process.cwd()` | #108 | Path abstraction in `infrastructure/paths.ts` honoring OS conventions | `tests/test_platform_m7.ts` |
| **D-05** | DOM indexer produced duplicate `data-agent-id`s | #119 | Monotonic counter and persistent cache in `perception/dom_extractor.ts` | `tests/regression_suite.ts` |
| **D-06** | Model responses simulated locally with static strings | #123 | Live provider architecture (`gemini_provider.ts`, `anthropic_provider.ts`) | `tests/test_anthropic_provider.ts` |
| **D-07** | Blackboard keys collision in concurrent swarm runs | #146 | Namespaced keys with lease acquisition in `swarm/blackboard.ts` | `tests/test_swarm_m3.ts` |
| **D-08** | Unsafe regex in prompt sanitization | #156 | Stateless streaming scanner in `security/prompt_isolation.ts` | `tests/test_security_m4.ts` |
| **D-09** | Unauthenticated local WebSocket server | #185 | HMAC token auth and origin validation in `platform/mcp_server.ts` | `tests/test_platform_m7.ts` |
| **D-10** | Hardcoded loopback in audio streaming | #192 | Quarantined legacy orphaned audio module to `attic/` under ADR-006 | `attic/README.md` |
