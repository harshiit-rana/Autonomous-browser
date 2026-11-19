# Autonomous Browser: Legal, Privacy & Responsible-Use Policies (Issue #216 - [REL-02])

## 1. Automated Access & Robots.txt Posture
Autonomous Browser operates under the principle of **respectful, polite, and lawful web automation**:
1. **Robots.txt & Meta Directives:** The URL Frontier (`src/swarm/url_frontier.ts`) parses and respects `robots.txt` disallow rules for automated crawling by default.
2. **Per-Origin Politeness:** Pacing controls enforce concurrency limits (default max 2 concurrent requests per eTLD+1 domain) with randomized jitter delays to avoid overloading target servers.
3. **No Circumvention:** The browser strictly forbids automated bypassing of CAPTCHAs, Cloudflare Turnstiles, bot-challenge puzzles, or paywalls. In encounters with access control barriers, the agent halts and initiates manual takeover handoff to the human user.
4. **Third-Party Terms of Service:** Users remain responsible for actions initiated through their personal credentials. The software provides policy warnings when user goals target automated bulk extraction on restrictive domains.

---

## 2. Privacy & Data Protection (GDPR / CCPA)
1. **Local-First Architecture:** Browsing history, vector embeddings, flight recordings, and task memories reside strictly on the user's local disk in standard application directories.
2. **Opt-In Telemetry Only:** Telemetry collection (`src/platform/telemetry.ts`) is strictly disabled by default. If enabled, telemetry transmits only anonymized aggregate counts (tokens, latency, error codes) with zero URLs, page content, or PII.
3. **Data Subject Rights (Export & Erasure):**
   - **Export:** Users can export all session records, thread histories, and memories to open formats (JSON, Markdown) via Settings.
   - **Right to be Forgotten:** A one-click "Purge All Data" button permanently deletes local SQLite databases, vector indices, and encryption keys.
4. **PII Redaction:** The Privacy Governor (`src/security/privacy_governor.ts`) automatically strips SSNs, credit card numbers, and API tokens before indexing into semantic memory.

---

## 3. AI Disclosure & Content Transparency
1. **Agent Identification:** The browser transmits a transparent user-agent declaration when operating in autonomous mode.
2. **Attribution & Provenance:** Generated summaries and extracted tables cite source URLs and timestamps. The software prohibits the fabrication of citations or synthetic benchmark scores.
3. **Human Confirmation Gates:**
   - Financial transactions (payments, subscriptions, checkout).
   - Irreversible destructive actions (account deletion, database drops).
   - Legal attestations ("I agree to terms", "I certify under penalty of perjury").

---

## 4. Acceptable Use Policy (AUP)
Autonomous Browser may **not** be used for:
- Denial-of-service (DoS) or intentional server degradation.
- Unauthorized vulnerability scanning, penetration testing, or credential stuffing.
- Scraping non-public personal identifiable information (PII) without legal authorization.
- Automated generation of fraudulent reviews, artificial engagement, or deceptive communications.
