# Autonomous Browser (Project Aegis)

> **Client-side autonomous AI desktop browser with dual-layer view architecture, human-kinematic stealth, and test-time planning.**

[![CI](https://github.com/harshiit-rana/Autonomous-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/harshiit-rana/Autonomous-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Current Status & Roadmap

Project Aegis is under active, rigorous development. Following a comprehensive codebase audit ([Issue #102](https://github.com/harshiit-rana/Autonomous-browser/issues/102)), we maintain full transparency regarding what is implemented, what is prototyped, and what is currently planned.

For the live reachability and integration state of all 63 source modules, see [**docs/STATUS.md**](docs/STATUS.md).

| Capability | Status | Description |
|:---|:---:|:---|
| **Dual-Layer Browser Shell** | **Works** | Frameless desktop window with custom titlebar, tabs, and unattached background `WebContentsView` architecture. |
| **Kinematic Pointer Simulation** | **Works** | Smooth cubic Bézier mouse movement with velocity curves, micro-tremors, and CDP hardware dispatch. |
| **Typing Cadence & Evasion** | **Works** | Variable WPM typing with typo self-correction, canvas noise, and WebGL fingerprint masking. |
| **Visual Agent Overlay** | **Works** | In-page glowing cursor follower (`Worker [Crawler]`), pulsing click ripples, and Set-of-Marks tags. |
| **Sanitizer & Guardrails** | **Prototype** | Token-level clean-room sanitizer and intent guard for prompt injection defense. |
| **Single-Agent Runtime Loop** | **In Progress** | Mission -> task -> step state machine with observe-plan-act loop ([Milestone M1](https://github.com/harshiit-rana/Autonomous-browser/milestone/2)). |
| **Multi-Provider Model Layer** | **In Progress** | Provider-neutral interface with streaming and tool calling ([Milestone M2](https://github.com/harshiit-rana/Autonomous-browser/milestone/3)). |
| **Parallel Agent Swarms** | **Planned** | True parallel background workers collaborating over a shared blackboard ([Milestone M4](https://github.com/harshiit-rana/Autonomous-browser/milestone/5)). |

---

## Real Technology Stack

- **Desktop Runtime:** Electron 33
- **Language:** TypeScript 5 (Strict ESM / NodeNext)
- **Frontend Bundler:** Vite 6 (Vanilla TypeScript & Modern CSS)
- **Browser Automation:** Native Chrome DevTools Protocol (`webContents.debugger`)
- **Persistence:** Local SQLite FTS5 / Encrypted Vault (AES-256-GCM)
- **Package Management:** npm

---

## Getting Started

### Prerequisites
- Node.js 20 or 22
- npm 9+
- Windows x64 (macOS / Linux support in progress: #189)

### Installation & Run

```bash
# 1. Clone the repository
git clone https://github.com/harshiit-rana/Autonomous-browser.git
cd Autonomous-browser

# 2. Install dependencies
npm ci

# 3. Typecheck and build the Vite frontend
npm run build

# 4. Launch the desktop application
npm start
```

### Development Scripts

```bash
npm run typecheck    # Run TypeScript compilation check
npm run build        # Build main process (tsc) and renderer bundle (vite)
npm run demo:smoke   # Run synthetic pipeline smoke test
npm run dist         # Package standalone portable executable via electron-builder
```

---

## Architectural Principles

1. **Dual-Layer Separation:** The user's active viewport is never hijacked. Background agent workers execute in unattached, non-visual web contents.
2. **Honest Observability:** You watch the agent navigate, click, type, and collect results with visual feedback and live telemetry.
3. **Safety by Construction:** Untrusted web text is sanitized through clean-room tokenizers before ingestion by model contexts.
4. **Local-First Privacy:** Sessions, credentials, and memory remain on your device.

---

## Known Limitations

In accordance with our honesty-first engineering principles ([Issue #218 - Completion Program Index](https://github.com/harshiit-rana/Autonomous-browser/issues/218)), the following areas are currently in development or limited:

1. **Module Reachability:** 52 of 129 modules are reachable from active application entry points; 77 orphaned or test-only modules are being systematically wired, tested, or quarantined (#221). See [docs/STATUS.md](docs/STATUS.md).
2. **Real-App E2E Testing:** Automated Playwright `_electron` end-to-end testing against the running desktop app is being established in #254/#255.
3. **Model Integration:** Model selection is currently configured via local and remote providers; silent mock fallbacks are being replaced with explicit, visibly labelled demo mode (#224).
4. **Swarm Execution:** Swarm workers are being migrated to model-driven agent loops operating on independent tab views (#227).
5. **Memory & Persistence:** The memory vector store currently uses hashed n-gram bucket projections (placeholder) pending learned embeddings (#240) and persistent database migration (#239).
6. **Security Defense:** Prompt injection defense uses token-level clean-room sanitization and intent policy checks; absolute "immunity" is never claimed, and attack-success-rate (ASR) is measured via live red-team evaluation (#249).
7. **Bot Detection:** Human-like pointer trajectories and typing cadences reduce automation tells without claiming complete evasion against advanced commercial anti-bot vendors (#250).

---

## Contributing & Security

- **Contributing Guide:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security Policy & Vulnerability Disclosure:** [SECURITY.md](SECURITY.md)
- **Specification:** [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md)
- **License:** [MIT License](LICENSE)
