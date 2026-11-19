# Project Aegis - Performance & Resource Budgets (Issue #198 - [QA-05])

This document defines performance budgets, memory thresholds, and soak-test tolerances for Autonomous Browser v1 across supported operating systems (Windows, macOS, Linux).

## Core Latency & Resource Budgets

| Metric | Target Budget | Upper Bound Threshold | Measurement Condition |
|---|---|---|---|
| **Cold Startup to Interactive** | < 800 ms | 1,500 ms | App boot to Omnibar readiness |
| **Warm Navigation Latency** | < 150 ms | 300 ms | DOM Indexer perception on standard HTML |
| **Worker Base Memory** | < 45 MB | 70 MB | Per prewarmed worker tab |
| **10 Workers Active Memory** | < 450 MB | 750 MB | Parallel swarm research mission |
| **Huge DOM Processing (100k nodes)**| < 400 ms | 1,000 ms | Full AXTree extraction & deduplication |
| **Perception Snapshot Latency** | < 80 ms | 200 ms | CDP accessibility tree capture |
| **Memory Leak Tolerance (8h Soak)**| 0% growth | < 5% RSS growth | 8 hours continuous standing watches |

## Soak & Stability Profile
- Worker instances recycled after mission execution via prewarmed worker pool.
- SQLite memory and WAL files cleared during idle periods.
- Event logs rotated based on configurable retention limits (default 14 days).
