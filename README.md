# Autonomous Browser: Master Architecture & Issue Tracker

> Complete engineering breakdown and specification for **Autonomous Browser** on GitHub: [harshiit-rana/Autonomous-browser](https://github.com/harshiit-rana/Autonomous-browser).

---

## 🗺️ Master Directory of All 60 Detailed Engineering Issues

### Milestone 1: Core Shell & Window Architecture
* **[#1: M1.1: Project Scaffolding, TypeScript Config, and Hardened Electron Packaging](https://github.com/harshiit-rana/Autonomous-browser/issues/1)**
* **[#2: M1.2: Dual-Layer Window Architecture (Shell Chrome + WebContentsView)](https://github.com/harshiit-rana/Autonomous-browser/issues/2)**
* **[#16: CORE-01: Low-Latency Binary IPC Protocol (Dendrite-Lite) for Main-Renderer Communication](https://github.com/harshiit-rana/Autonomous-browser/issues/16)**
* **[#17: CORE-02: CDP Session Pool & Multi-Target Lifecycle Manager](https://github.com/harshiit-rana/Autonomous-browser/issues/17)**
* **[#18: CORE-03: CDP Network Interception, Request Spoofing, and Mocking Engine](https://github.com/harshiit-rana/Autonomous-browser/issues/18)**
* **[#19: CORE-04: JavaScript Dialog Interception Bridge (Alert, Confirm, Prompt, BeforeUnload)](https://github.com/harshiit-rana/Autonomous-browser/issues/19)**
* **[#20: CORE-05: Native File Chooser Interception & Autonomous Upload Manager](https://github.com/harshiit-rana/Autonomous-browser/issues/20)**
* **[#24: CORE-09: Robust Frame Tree Navigation & Cross-Origin Shadow DOM Traversal](https://github.com/harshiit-rana/Autonomous-browser/issues/24)**
* **[#25: CORE-10: Viewport Adaptation, Device Emulation, and Dynamic Zoom Handling](https://github.com/harshiit-rana/Autonomous-browser/issues/25)**

---

### Milestone 2: Perception, DOM Indexing & Stealth Input
* **[#3: M2.1: Semantic DOM Tree Indexer & Persistent Handle Assignment](https://github.com/harshiit-rana/Autonomous-browser/issues/3)**
* **[#4: M2.2: Dual-Mode Execution Engine (Physical CDP Pointer Simulation + DOM Direct)](https://github.com/harshiit-rana/Autonomous-browser/issues/4)**
* **[#21: CORE-06: Human-Realistic Bezier Curve Mouse Trajectory Simulator](https://github.com/harshiit-rana/Autonomous-browser/issues/21)**
* **[#22: CORE-07: Human Cadence Keyboard Typer with Realistic Keystroke Latency & Typo Simulation](https://github.com/harshiit-rana/Autonomous-browser/issues/22)**
* **[#23: CORE-08: Cross-Platform Anti-Bot Evasion & Navigator Fingerprint Masking](https://github.com/harshiit-rana/Autonomous-browser/issues/23)**
* **[#26: PERC-01: Accessibility Tree (AXTree) Extraction & Semantic Pruning](https://github.com/harshiit-rana/Autonomous-browser/issues/26)**
* **[#27: PERC-02: Visual 'Set-of-Mark' (SoM) Dynamic Overlay Generator](https://github.com/harshiit-rana/Autonomous-browser/issues/27)**
* **[#28: PERC-03: Real-Time DOM Mutation Observer & Visual Settle Detector](https://github.com/harshiit-rana/Autonomous-browser/issues/28)**
* **[#29: PERC-04: Spatial Relationship & Visual Hierarchy Reasoning Engine](https://github.com/harshiit-rana/Autonomous-browser/issues/29)**
* **[#30: PERC-05: Dynamic OCR & Canvas/SVG Text Extraction Fallback](https://github.com/harshiit-rana/Autonomous-browser/issues/30)**

---

### Milestone 3: Elastic Swarm Orchestration & Parallel Workers
* **[#5: M3.1: Elastic Swarm Orchestrator & Background Worker Tab Pool](https://github.com/harshiit-rana/Autonomous-browser/issues/5)**
* **[#6: M3.2: Hierarchical Task Decomposition & Swarm Coordinator](https://github.com/harshiit-rana/Autonomous-browser/issues/6)**
* **[#31: SWARM-01: Worker Tab Memory & Resource Throttler](https://github.com/harshiit-rana/Autonomous-browser/issues/31)**
* **[#32: SWARM-02: Shared Blackboard State & Distributed Evidence Store](https://github.com/harshiit-rana/Autonomous-browser/issues/32)**
* **[#33: SWARM-03: Dynamic Work-Stealing Queue for Parallel Web Crawling & Research](https://github.com/harshiit-rana/Autonomous-browser/issues/33)**
* **[#34: SWARM-04: Swarm Synchronization & Barrier Primitives for Multi-Stage Tasks](https://github.com/harshiit-rana/Autonomous-browser/issues/34)**
* **[#35: SWARM-05: Worker Telemetry, Heartbeats, and Auto-Recovery Daemon](https://github.com/harshiit-rana/Autonomous-browser/issues/35)**

---

### Milestone 4: Test-Time Compute, MCTS & Backtracking Planning
* **[#7: M4.1: Test-Time Compute & MCTS Planning Engine for Complex Workflows](https://github.com/harshiit-rana/Autonomous-browser/issues/7)**
* **[#8: M4.2: Web State Snapshotting, Speculative Backtracking & Safety Rollbacks](https://github.com/harshiit-rana/Autonomous-browser/issues/8)**
* **[#36: PLAN-01: Web Action Space Formalization & Pruning Heuristics](https://github.com/harshiit-rana/Autonomous-browser/issues/36)**
* **[#37: PLAN-02: LLM Critic & State Value Function for MCTS Node Evaluation](https://github.com/harshiit-rana/Autonomous-browser/issues/37)**
* **[#38: PLAN-03: Upper Confidence Bounds for Trees (UCT) Selection Policy](https://github.com/harshiit-rana/Autonomous-browser/issues/38)**
* **[#39: PLAN-04: Speculative Parallel Rollouts via Headless Clone Tabs](https://github.com/harshiit-rana/Autonomous-browser/issues/39)**
* **[#40: PLAN-05: Hierarchical High-Level Plan Space (Plan-MCTS)](https://github.com/harshiit-rana/Autonomous-browser/issues/40)**

---

### Milestone 5: Indirect Prompt Injection Defense & Dual-Model Security
* **[#9: M5.1: Indirect Prompt Injection Defense: Untrusted Content Isolation Layer](https://github.com/harshiit-rana/Autonomous-browser/issues/9)**
* **[#10: M5.2: Dual-Model Intent Guard & Agent Origin Boundary Enforcement](https://github.com/harshiit-rana/Autonomous-browser/issues/10)**
* **[#41: SEC-01: Strict Content Security Policy (CSP) & Script Sandboxing for Agent Chrome](https://github.com/harshiit-rana/Autonomous-browser/issues/41)**
* **[#42: SEC-02: Agent Origin Scope Locker (Per-Task Domain Whitelisting)](https://github.com/harshiit-rana/Autonomous-browser/issues/42)**
* **[#43: SEC-03: Dual-Model Intent Alignment Verifier (Pre-Action Gate)](https://github.com/harshiit-rana/Autonomous-browser/issues/43)**
* **[#44: SEC-04: Credential Masking & Sensitive Input Redaction Filter](https://github.com/harshiit-rana/Autonomous-browser/issues/44)**
* **[#45: SEC-05: Automated Indirect Prompt Injection Red-Teaming Suite](https://github.com/harshiit-rana/Autonomous-browser/issues/45)**

---

### Milestone 6: Universal MCP & Local-First Vector Memory
* **[#11: M6.1: Universal Model Context Protocol (MCP) Hub & Client Integration](https://github.com/harshiit-rana/Autonomous-browser/issues/11)**
* **[#12: M6.2: Local Privacy-First Semantic Vector Memory & Browsing Recall (DuckDB/SQLite)](https://github.com/harshiit-rana/Autonomous-browser/issues/12)**
* **[#46: MEM-01: SQLite FTS5 Full-Text Search Engine for Visited Page Content](https://github.com/harshiit-rana/Autonomous-browser/issues/46)**
* **[#47: MEM-02: On-Device Local Embedding Generation Pipeline](https://github.com/harshiit-rana/Autonomous-browser/issues/47)**
* **[#48: MEM-03: Vector Similarity Search & Hybrid RAG Retrieval Engine](https://github.com/harshiit-rana/Autonomous-browser/issues/48)**
* **[#49: MEM-04: Automated Daily Browsing Activity Summarizer (OptMem Parity)](https://github.com/harshiit-rana/Autonomous-browser/issues/49)**
* **[#50: MEM-05: Secure Encrypted Vault for User Credentials, API Keys, and Cookies](https://github.com/harshiit-rana/Autonomous-browser/issues/50)**

---

### Milestone 7: Modern Browser UI, Swarm Drawer & Multi-Model Hub
* **[#13: M7.1: Universal Smart Omnibar (Hybrid URL Navigation + Swarm Prompting)](https://github.com/harshiit-rana/Autonomous-browser/issues/13)**
* **[#14: M7.2: Swarm Activity Drawer & Live Streaming Execution Dashboard](https://github.com/harshiit-rana/Autonomous-browser/issues/14)**
* **[#15: M7.3: Pluggable Multi-Model Hub (Claude, Gemini, OpenAI, and Local Ollama)](https://github.com/harshiit-rana/Autonomous-browser/issues/15)**
* **[#51: UI-01: Modern Glassmorphic Window Frame with Custom Titlebar & Window Controls](https://github.com/harshiit-rana/Autonomous-browser/issues/51)**
* **[#52: UI-02: Dynamic Tab Strip with Workspace & Profile Isolation](https://github.com/harshiit-rana/Autonomous-browser/issues/52)**
* **[#53: UI-03: Real-Time Swarm Progress Sidebar with Live Worker Stream Cards](https://github.com/harshiit-rana/Autonomous-browser/issues/53)**
* **[#54: UI-04: Floating Quick-Action Companion Pill (Voice & Global Shortcuts)](https://github.com/harshiit-rana/Autonomous-browser/issues/54)**
* **[#55: UI-05: Interactive Manual Takeover & Agent Debugger Inspector](https://github.com/harshiit-rana/Autonomous-browser/issues/55)**

---

### Milestone 8: Audio, Chrome Extensions & Benchmarking
* **[#56: EXT-01: Chrome Extension Runtime & Manifest V3 Compatibility Subsystem](https://github.com/harshiit-rana/Autonomous-browser/issues/56)**
* **[#57: AUDIO-01: Windows WASAPI Audio Loopback Capture & Meeting Transcription Pipeline](https://github.com/harshiit-rana/Autonomous-browser/issues/57)**
* **[#58: BENCH-01: End-to-End WebArena & Mind2Web Benchmark Evaluation Suite](https://github.com/harshiit-rana/Autonomous-browser/issues/58)**
* **[#59: INFRA-01: Automated Multi-Platform CI/CD Pipeline & GitHub Release Packager](https://github.com/harshiit-rana/Autonomous-browser/issues/59)**
* **[#60: INFRA-02: Comprehensive Documentation, Developer Guide, and Architecture Specs](https://github.com/harshiit-rana/Autonomous-browser/issues/60)**
