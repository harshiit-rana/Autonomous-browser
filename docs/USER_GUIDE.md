# Project Aegis - User Guide & Quick Start

Welcome to Project Aegis, the next-generation autonomous browser built for high-reliability web tasks, multi-agent swarms, and injection immunity.

---

## 1. Getting Started

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/harshiit-rana/Autonomous-browser.git
   cd Autonomous-browser
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the application:
   ```bash
   npm run build
   ```
4. Launch the browser:
   ```bash
   npm start
   ```

---

## 2. Using the Smart Omnibar

The top omnibar unifies traditional web browsing, agent commands, and natural language prompts:
- **Direct Navigation:** Type any domain (`github.com`), IP address (`192.168.1.1:8080`), or local server (`localhost:3000`).
- **Search Engine Keywords:**
  - `!g <query>` - Search on Google
  - `!ddg <query>` - Search on DuckDuckGo
  - `!yt <query>` - Search on YouTube
  - `!gh <query>` - Search on GitHub
- **Autonomous Agent Commands:**
  - `/do <prompt>` - Runs an autonomous single-agent workflow
  - `/swarm <prompt>` - Spawns a parallel multi-agent swarm
  - `/research <topic>` - Conducts in-depth research across multiple sources
  - `/extract` - Extracts structured data from the current page

---

## 3. Safety, Approvals & Privacy Modes

### Trusted Confirmation Cards
When an agent encounters a payment, subscription, or irreversible action:
1. The agent pauses immediately.
2. A trusted confirmation card appears in the chrome UI showing merchant, price, and recurring status.
3. Review and approve or cancel the action. The agent will never proceed without your consent.

### Privacy Modes
Under **Settings -> Privacy**, select your desired level of privacy:
- **Standard:** Normal web operations with ad and tracker blocking enabled.
- **Careful (Default):** Disables screenshots and recording on banking and healthcare websites; redacts credit cards and PII automatically.
- **Local-Only:** Strictly zero cloud egress; only local on-device models (e.g. Ollama DeepSeek R1) are permitted.

---

## 4. Emergency Kill Switch
If at any moment an agent behaves unexpectedly:
- Click the red **Emergency Stop** button in the top chrome, or
- Run `aegis kill` in your terminal.
All active agent workers and CDP sessions will be terminated immediately.

---

## 5. Driving the Browser via CLI or Claude Code (MCP)
Project Aegis exposes a local Model Context Protocol (MCP) server:
- To inspect open tabs from CLI:
  ```bash
  aegis tabs
  ```
- To start a background task:
  ```bash
  aegis mission run "Find the best price for iPhone 16 Pro" --json
  ```
