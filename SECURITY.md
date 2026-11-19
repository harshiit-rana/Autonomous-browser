# Security Policy

## Supported Versions
| Version | Supported |
|---|---|
| 0.1.x | :white_check_mark: |

## Reporting a Vulnerability
We take the security of Autonomous Browser seriously. If you discover a security vulnerability, please do not report it publicly via GitHub issues.
Instead, email **ranaharshit633@gmail.com** with details of the vulnerability, reproduction steps, and potential impact. You will receive an initial response within 24 hours.

## Supply Chain & Architectural Invariants
1. **Prompt Isolation & Zero Boundary Breakouts**: All third-party DOM text, meta tags, and scraped payloads are wrapped in cryptographically randomized XML boundaries with mandatory XML entity escaping (`&lt;`, `&gt;`, `&amp;`) to neutralize indirect prompt injections.
2. **Action Policy Engine (PDP)**:
   - Denies `javascript:`, `data:`, and local file execution schemes unconditionally.
   - Requires explicit human approval for cross-origin navigations outside the approved mission scope.
   - Enforces human confirmation for financial transactions and irreversible actions (e.g., account deletion, payments).
3. **Electron Hardening**:
   - `nodeIntegration: false` and `contextIsolation: true` across all webviews and windows.
   - Strict Content Security Policy (CSP) forbidding `'unsafe-eval'` and external remote scripts.
   - Electron Fuses locked to disable `RunAsNode` and `InspectElement`.
4. **Secret Vault**: Zero cleartext secrets in LLM context windows or DOM attributes. Sensitive credentials use tokenized placeholders (`{{secret:name}}`) resolved on authorized origins only.
