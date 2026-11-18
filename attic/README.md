# Project Aegis Attic: Quarantined & Decommissioned Code

This directory contains legacy modules removed from active production builds for security, reliability, or architectural non-conformance.

## Quarantined Modules
- `mobile_sync.ts` (Quarantined in Milestone M4, Issue #167):
  - **Vulnerability:** Bound an unauthenticated HTTP server to all network interfaces (`0.0.0.0`) without TLS. The `/api/approve` endpoint accepted arbitrary approval requests without authentication or pairing checks, allowing any attacker on the local LAN to approve high-risk browser actions.
  - **Status:** Permanently decommissioned from production imports.
