# ADR-005: Platform Automation via Model Context Protocol (MCP) and Isolated Distribution

## Context
External developers and AI agents (such as Claude Code, terminal scripts, and CI runners) require a standardized, bi-directional interface to command the autonomous browser, inspect tabs, extract structured data, and trigger multi-agent swarms.
Historically, automation APIs either used raw HTTP REST servers without authentication or spawned child processes that inherited the parent process's environment wholesale, leaking API keys and tokens. Furthermore, remote automation tools frequently risk bypassing user safety confirmation gates (such as authorizing financial purchases or logins remotely without human consent).

## Decision
1. **Model Context Protocol (MCP) Server:** Implement an internal MCP server listening over stdio and loopback HTTP with required Bearer token authentication. Expose standard tools: `start_mission`, `get_mission_status`, `list_tabs`, `navigate_tab`, `extract_data`, `take_screenshot`, `approve_action`.
2. **Remote Financial Action Denial:** Remote tool calls cannot approve financial or irreversible actions (`approve_action` fails with a policy error for financial confirmation cards) unless explicitly configured by the local human operator.
3. **MCP Client Child Process Isolation:** Sanitized environment inheritance: child processes never inherit the entire `process.env` map. Only an allowlisted set of system variables (`PATH`, `HOME`, `TEMP`) is passed, eliminating token leakage.
4. **Data Tainting:** All web data returned from the browser (DOM extracts, screenshots) is explicitly tagged as `isTaintedData: true`, requiring structural prompt isolation before ingestion by consuming LLMs.

## Consequences
- Full compatibility with Claude Code, Cursor, and custom agent scripts.
- Eliminates credential leakage into child MCP tools.
- Preserves the human-in-the-loop safety boundary for critical purchases and irreversible tasks.
