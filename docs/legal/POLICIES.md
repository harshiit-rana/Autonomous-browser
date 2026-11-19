# Autonomous Browser: Legal, Privacy & Responsible-Use Policies (Issue #216 - [REL-02], revised #260 - [PKG-03])

> **Not legal advice. Requires counsel review.** The statements below are an engineering description of intended behaviour. Each item carries its implementation status. Anything marked **Not implemented** must not be read as a product guarantee.

Status key: **Implemented** = code exists and is wired on the live path (as far as the reachability audit shows). **Module only** = code exists but is not yet enforced on the live agent path. **Not implemented** = no code backs the statement yet.

---

## 1. Automated Access & Robots.txt Posture
Autonomous Browser intends **respectful, polite, and lawful web automation**:
1. **Robots.txt:** `src/swarm/url_frontier.ts` contains a robots.txt check (`respectRobots` defaults to `true`). **Module only:** the swarm URL frontier is not yet the enforced path for the single-agent loop (see #227, #229).
2. **Per-Origin Politeness:** `src/swarm/url_frontier.ts` caps in-flight requests per origin (default `maxConcurrentPerOrigin: 2`) and honours `Retry-After`. **Module only** (same reason as item 1). Randomised jitter is **Not implemented**.
3. **No Circumvention:** Intended policy: no automated bypass of CAPTCHAs, bot-challenge puzzles or paywalls; the agent hands control to the user instead. `src/session/tab_handoff.ts` and `src/security/bot_detection.ts` exist. **Module only:** enforcement in the live loop is tracked in #247 and #250.
4. **Third-Party Terms of Service:** Users remain responsible for actions taken with their own credentials and for complying with each site's terms. Warnings for bulk extraction on restrictive domains are **Not implemented** (see #251).

---

## 2. Privacy & Data Protection (GDPR / CCPA)
1. **Local-First Architecture:** Intended: browsing history, embeddings, flight recordings and task memories are stored only on the user's disk. **Not implemented as a guarantee:** the persistence layer and embeddings are being replaced (#239, #240); no encryption-at-rest guarantee is claimed.
2. **Telemetry:** **Implemented** as opt-in: `src/platform/telemetry.ts` initialises with `isOptedIn = false`. The statement that telemetry sends only anonymised aggregate counts with no URLs or page content is **Not verified** (the telemetry transport is tracked in #253 and #248).
3. **Data Subject Rights:**
   - **Export:** **Not implemented** for the full set of records. `src/automation/flight_recorder.ts` can export a flight log to JSON; threads and memories export is **Not implemented** (#241 to #244).
   - **Erasure:** **Not implemented** as a single "Purge All Data" action. `src/platform/telemetry.ts` only purges telemetry records. Deletion of databases, vector indices and key material is tracked in #248.
4. **PII Redaction:** **Module only.** `src/security/privacy_governor.ts` detects and tokenises credit card numbers (Luhn check), SSNs, emails, phone numbers and API keys. `src/memory/semantic_memory.ts` imports it. The governor is not yet applied to every model call or sink (#248).

### 2.1 Data sent to model providers
This table lists what the provider adapters can send. It is derived from `src/models/*.ts`. Provider retention and training terms are set by each provider and are **not verified** here.

| Provider | Adapter | Sends | Notes |
|---|---|---|---|
| Anthropic | `src/models/anthropic_provider.ts` | Text and image content blocks in the message history | Adapter supports image blocks; whether a screenshot is attached on a given turn is decided by the agent loop. |
| Google Gemini | `src/models/gemini_provider.ts` | Text and image content blocks | Same as above. |
| OpenAI (and OpenAI-compatible endpoints) | `src/models/openai_provider.ts` | Text and `image_url` content blocks | `baseURL` can be overridden, so data may go to a non-OpenAI host if the user configures one. |
| Mock | `src/models/mock_provider.ts` | Nothing (in-process) | Present in the provider factory; removal from product code is tracked in #224. |

Per-mission switches for sending screenshots, a local-only mode and retention settings are **Not implemented** (#248).

---

## 3. AI Disclosure & Content Transparency
1. **Agent Identification:** **Not implemented.** The swarm worker host (`src/swarm/worker_host.ts`) applies coherent browser profiles (user agent, locale, timezone, viewport). No transparent agent user-agent declaration is sent. Do not describe the agent as identifying itself in requests.
2. **Attribution & Provenance:** **Not implemented** for generated summaries and tables. Source citation and citation verification are tracked in #230 and #251.
3. **Human Confirmation Gates:** **Module only.** `src/security/payment_guard.ts` and `src/agent/steering_and_reversibility.ts` cover payments and irreversible actions. Confirmation for legal attestations is **Not verified**. Wiring into the live loop is tracked in #247 and #238.

---

## 4. Acceptable Use Policy (AUP)
Autonomous Browser may **not** be used for:
- Denial-of-service (DoS) or intentional server degradation.
- Unauthorized vulnerability scanning, penetration testing, or credential stuffing.
- Scraping non-public personal identifiable information (PII) without legal authorization.
- Automated generation of fraudulent reviews, artificial engagement, or deceptive communications.

The AUP is a usage restriction for users. It is not a technical control, and the software does not yet enforce it.
