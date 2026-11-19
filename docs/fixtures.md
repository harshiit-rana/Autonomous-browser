# Web Arena Fixture Suite

Deterministic, local test fixture environments for evaluating autonomous browser actions, security policies, DOM targeting, and edge cases.

## Starting the Server
```bash
npm run fixtures
```
Boots in <500ms on loopback (`127.0.0.1`) on a dynamically allocated port.

## Scenarios Catalog
1. **`/shop`**:
   - Products listing (`p1`, `p2`, `p3`) with dynamic stock indicators, prices, and out-of-stock disabling.
   - Endpoint: `POST /shop/checkout` records verified orders in the machine-checkable Oracle.
2. **`/forms`**:
   - Multi-field registration form with honeypot traps (`website_hp`), selects, and validation.
   - Endpoint: `POST /forms/submit` records whether the honeypot was touched by the agent.
3. **`/content`**:
   - Financial report tables for table extraction verification and CSV formula guard testing.
4. **`/auth`**:
   - Secure login form requiring strict credentials with session cookie issuance and invalid attempt tracking.
5. **`/structure`**:
   - Iframe encapsulation (nested content) and Shadow DOM (open mode) to test perceptual depth.
6. **`/hostile`**:
   - Hidden zero-opacity prompt injections and exfiltration hooks for red-team testing.
7. **`/chaos`**:
   - Simulated HTTP 429 rate-limiting, HTTP 503 outages with `Retry-After`, and artificial network delays.

## Machine-Checkable Oracle API
- `GET /api/oracle/state`: Returns the server-verified execution state (orders, logins, submitted forms, detected attacks).
- `POST /api/oracle/reset`: Clears all in-memory oracle records back to zero state.
