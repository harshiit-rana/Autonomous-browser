# Project Aegis Attic: Quarantined & Decommissioned Code

This directory contains legacy or un-architected modules removed from active production builds for security, reliability, or architectural non-conformance.

## Quarantined & Triaged Modules

### 1. `mobile_sync.ts` (Quarantined in Milestone M4, Issue #167)
- **Vulnerability:** Bound an unauthenticated HTTP server to all network interfaces (`0.0.0.0`) without TLS. The `/api/approve` endpoint accepted arbitrary approval requests without authentication or pairing checks, allowing any attacker on the local LAN to approve high-risk browser actions.
- **Status:** Permanently decommissioned from production imports.
- **Restoration Criteria:** Mutual TLS (mTLS), strict cryptographic pairing (e.g., Noise protocol or QR-code based key exchange), origin pinning, and out-of-band approval challenge.

### 2. `audio_loopback.ts` (Triaged in Milestone M9, Issue #192)
- **Findings:** Claimed "WASAPI loopback capture & meeting transcription" (`AUDIO-01`), but only toggled a boolean and logged the count of `<audio>`/`<video>` elements. No real audio capture, circular buffer, or transcription pipeline existed. Audio capture of system/browser sound without explicit user consent UI introduces grave privacy and compliance liabilities.
- **Status:** Quarantined to attic.
- **Restoration Criteria:** Complete product specification, OS-level loopback stream permissions, explicit active recording banner and consent indicator, and on-device offline transcription (e.g., Whisper.cpp via WASM/native addon) with zero remote audio egress.

### 3. `synchronized_tester.ts` (Triaged in Milestone M9, Issue #192)
- **Findings:** A prototype multi-tab QA helper script with synthetic barrier waits, never integrated into the real test harness or CI pipeline.
- **Status:** Quarantined to attic.
- **Restoration Criteria:** None. Superseded by the real-app Playwright e2e harness (`tests/e2e/e2e_harness.ts`, #195) and Web Arena fixtures (#194).

### 4. `rbac_policy.ts` (Triaged in Milestone M9, Issue #193)
- **Findings:** Defined enterprise role/policy data structures (`admin`, `operator`, `restricted`) and SSO configuration stubs with no enforcement point in the browser execution pipeline, no cryptographically signed policy distribution, and no identity provider verification.
- **Status:** Quarantined to attic. Single-user browser security is enforced by `ActionPolicyEngine` PDP (#158).
- **Restoration Criteria:** Enterprise roadmap spec with signed policy bundles, PKCE-based OIDC login, and centralized tenant governance.

### 5. `accessibility_audit.ts` & `page_translator.ts` (Triaged in Milestone M9, Issue #193)
- **Findings:** Utilities without UI integration or runtime hooks.
- **Status:** Quarantined to attic.
- **Restoration Criteria:** Candidate for re-introduction as an on-demand user-invoked agent skill ("audit this page's accessibility", "translate this page") layered on top of AXTree perception (#118).
