# ADR-006: Legacy Module Triage & Quarantine Disposition

## Status
Accepted

## Context
During the architectural audit of issues #1–#100 (tracked in #102), multiple orphaned modules were identified in the codebase that either:
1. Implemented incomplete or stubbed functionality (e.g. `audio_loopback.ts` claiming WASAPI capture but only counting HTML media elements).
2. Posed active security vulnerabilities (e.g. `mobile_sync.ts` exposing unauthenticated remote action approval).
3. Pre-emptively defined enterprise governance models (`rbac_policy.ts`, SSO stubs) without runtime enforcement hooks or identity integration.
4. Created maintenance liability without product reachability.

Issues #192 (`[ORP-01]`) and #193 (`[ORP-02]`) mandate recording explicit dispositions for each module and moving unadopted code to `attic/`.

## Decisions

### 1. Audio Loopback & Meeting Transcription (`src/native/audio_loopback.ts`) -> Attic
- **Decision:** Moved to `attic/audio_loopback.ts`.
- **Rationale:** No audio capture was actually implemented. Capturing system or web audio without explicit OS permissions, user opt-in, and visual indicators poses severe legal (wiretapping/consent) and privacy risks.
- **Future Criteria:** Dedicated RFC with local Whisper/WebAssembly transcription, strict visual recording chrome, and explicit per-session consent.

### 2. Multi-tab Synchronized Tester (`src/testing/synchronized_tester.ts`) -> Attic
- **Decision:** Moved to `attic/synchronized_tester.ts`.
- **Rationale:** Superseded by the Playwright Electron E2E harness (`tests/e2e/e2e_harness.ts`, #195) and the deterministic Web Arena server (`fixtures/arena_server.ts`, #194).

### 3. Enterprise RBAC & SSO Stubs (`src/enterprise/rbac_policy.ts`) -> Attic
- **Decision:** Moved to `attic/rbac_policy.ts`.
- **Rationale:** Autonomous Browser v1 is focused on single-user, multi-agent enterprise workstation autonomy. The local Policy Decision Point (`ActionPolicyEngine`, #158) enforces origin ACLs, financial guards, and irreversibility checks locally without requiring mock tenant roles.
- **Future Criteria:** Enterprise policy distribution protocol with Ed25519-signed policy bundles, PKCE OIDC desktop auth, and audit export.

### 4. Accessibility Audit & Page Translator (`src/enterprise/`) -> Attic
- **Decision:** Moved to `attic/accessibility_audit.ts` and `attic/page_translator.ts`.
- **Rationale:** The features have value not as background enterprise daemons, but as user-facing agent skills ("audit this page's WCAG 2.1 contrast and ARIA labels") powered by the AXTree perception engine (`src/perception/dom_extractor.ts`, #118).

## Consequences
- Clean separation between active, verified production codebase and quarantined legacy experiments.
- Documentation accurately reflects reality: zero synthetic enterprise or audio claims in v1 specifications.
