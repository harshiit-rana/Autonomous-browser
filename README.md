# Autonomous Browser (Project Codename: Aegis)

> **Next-Generation Autonomous Multi-Agent AI Browser with Elastic Swarms, Test-Time Tree Search, and Indirect Injection Immunity.**

---

## 🌟 Overview

The **Autonomous Browser** is a production-grade, open-source AI desktop browser engineered from the ground up to solve the fundamental limitations of single-agent and brittle screen-clicking systems (such as Strawberry Browser). 

Instead of chaining users to a single tab with slow, token-heavy screenshot loops, Autonomous Browser introduces:
1. **Elastic Chromium Swarms**: True parallel agent execution across 1 to 10+ background tabs without screen hijacking.
2. **Test-Time Tree Search (MCTS / Best-First Planning)**: Exploration, state backtracking, and dead-end recovery over complex workflows.
3. **Dual-Mode Precision Execution**: Physical pointer simulation (`CDP Input.dispatchMouseEvent`) and instantaneous semantic DOM node targeting (`data-agent-id`).
4. **Architectural Indirect Prompt Injection Defense**: Untrusted content isolation layers, Agent Origin Sets, and dual-model validation protecting user data and credentials.
5. **Universal Model Context Protocol (MCP)**: Native hub to connect external tools, filesystem access, local CLI tools, and databases.
6. **Local-First Privacy & Semantic Memory**: Embedded vector memory (DuckDB/SQLite FTS5) with 100% offline local LLM compatibility (Ollama, LM Studio) alongside cloud providers (Claude 3.7/3.5, Gemini 2.0, OpenAI).

---

## 🏗️ Architecture

```mermaid
flowchart TD
    User(["User (Prompt / Voice / URL)"]) --> UI["Modern Browser Chrome (Electron / Svelte 5 / React)"]
    
    subgraph BrowserProcess ["Browser Shell & Orchestrator"]
        Omnibar["Universal Smart Omnibar (Browse + Swarm Prompts)"]
        Coordinator["Autonomous Swarm Coordinator (Task Decomposer)"]
        TreePlanner["MCTS / Test-Time Search Planner & State Graph"]
        SecurityShield["Indirect Injection Shield & Origin Boundary Guard"]
        MCPHub["Model Context Protocol (MCP) Hub"]
        MemoryDB["Local Vector Memory (SQLite FTS5 / DuckDB)"]
    end

    subgraph ElasticSwarm ["Elastic Multi-Agent Swarm (Background Isolated Tabs)"]
        Tab1["Agent Worker 1 (CDP / DOM Indexer)"]
        Tab2["Agent Worker 2 (CDP / DOM Indexer)"]
        Tab3["Agent Worker 3 (CDP / DOM Indexer)"]
        TabN["Agent Worker N (Elastic Scale)"]
    end

    subgraph ContentSurfaces ["Content Presentation"]
        MainTab["Active User Browsing Surface (WebContentsView)"]
        Sidebar["Agent Drawer (Live Progress & Streamed Evidence)"]
    end

    UI --> Omnibar
    Omnibar --> Coordinator
    Coordinator --> TreePlanner
    TreePlanner <--> SecurityShield
    TreePlanner -->|"Elastic Spawn"| ElasticSwarm
    ElasticSwarm -->|"Structured Evidence"| Coordinator
    Coordinator --> Sidebar
    Coordinator <--> MemoryDB
    Coordinator <--> MCPHub
    UI --> MainTab
```

---

## 🗺️ Master Roadmap & GitHub Issue Tracker

The complete architectural plan has been mapped out and published to GitHub Issues with exhaustive implementation criteria:

| Milestone / Issue | Category | Description |
| :--- | :--- | :--- |
| **[#1](https://github.com/harshiit-rana/Autonomous-browser/issues/1)** | `core-engine` | **M1.1: Project Scaffolding, TypeScript Config, and Hardened Electron Packaging** |
| **[#2](https://github.com/harshiit-rana/Autonomous-browser/issues/2)** | `core-engine`, `ui-ux` | **M1.2: Dual-Layer Window Architecture (Shell Chrome + WebContentsView)** |
| **[#3](https://github.com/harshiit-rana/Autonomous-browser/issues/3)** | `core-engine`, `algorithm` | **M2.1: Semantic DOM Tree Indexer & Persistent Handle Assignment** |
| **[#4](https://github.com/harshiit-rana/Autonomous-browser/issues/4)** | `core-engine` | **M2.2: Dual-Mode Execution Engine (Physical CDP Pointer Simulation + DOM Direct)** |
| **[#5](https://github.com/harshiit-rana/Autonomous-browser/issues/5)** | `core-engine`, `swarm` | **M3.1: Elastic Swarm Orchestrator & Background Worker Tab Pool** |
| **[#6](https://github.com/harshiit-rana/Autonomous-browser/issues/6)** | `swarm`, `algorithm` | **M3.2: Hierarchical Task Decomposition & Swarm Coordinator** |
| **[#7](https://github.com/harshiit-rana/Autonomous-browser/issues/7)** | `core-engine`, `algorithm` | **M4.1: Test-Time Compute & MCTS Planning Engine for Complex Workflows** |
| **[#8](https://github.com/harshiit-rana/Autonomous-browser/issues/8)** | `security`, `algorithm` | **M4.2: Web State Snapshotting, Speculative Backtracking & Safety Rollbacks** |
| **[#9](https://github.com/harshiit-rana/Autonomous-browser/issues/9)** | `security` | **M5.1: Indirect Prompt Injection Defense: Untrusted Content Isolation Layer** |
| **[#10](https://github.com/harshiit-rana/Autonomous-browser/issues/10)** | `security`, `algorithm` | **M5.2: Dual-Model Intent Guard & Agent Origin Boundary Enforcement** |
| **[#11](https://github.com/harshiit-rana/Autonomous-browser/issues/11)** | `core-engine` | **M6.1: Universal Model Context Protocol (MCP) Hub & Client Integration** |
| **[#12](https://github.com/harshiit-rana/Autonomous-browser/issues/12)** | `core-engine`, `memory` | **M6.2: Local Privacy-First Semantic Vector Memory & Browsing Recall (DuckDB/SQLite)** |
| **[#13](https://github.com/harshiit-rana/Autonomous-browser/issues/13)** | `ui-ux` | **M7.1: Universal Smart Omnibar (Hybrid URL Navigation + Swarm Prompting)** |
| **[#14](https://github.com/harshiit-rana/Autonomous-browser/issues/14)** | `swarm`, `ui-ux` | **M7.2: Swarm Activity Drawer & Live Streaming Execution Dashboard** |
| **[#15](https://github.com/harshiit-rana/Autonomous-browser/issues/15)** | `core-engine` | **M7.3: Pluggable Multi-Model Hub (Claude, Gemini, OpenAI, and Local Ollama)** |

---

## 🛠️ Tech Stack

- **Runtime / Shell**: Electron 33+, Node.js 22+, TypeScript
- **Frontend Chrome**: Svelte 5 (or React 19) + Tailwind CSS + Lucide Icons
- **Browser Automation Core**: Chromium DevTools Protocol (CDP) + Playwright Core
- **Database / Memory**: `better-sqlite3` + FTS5, Vector Embeddings
- **Protocol**: Model Context Protocol (MCP) SDK
- **LLM Integrations**: Claude (ACP/Anthropic), Gemini (Google GenAI), OpenAI, Ollama / Local OpenAI-compatible APIs

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
