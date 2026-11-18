# Contributing to Autonomous Browser

Thank you for contributing to Project Aegis. All contributions must adhere to our honest, production-grade quality standards.

## Definition of Done (DoD)

Before any pull request or milestone issue is considered complete, ensure:

1. **Reachable:** The behaviour is directly reachable from the running Electron application or documented entry points.
2. **No Fabrication:** No stubbed, hardcoded, or simulated outputs on product paths. Demo/fixture data must live only in designated demo scripts.
3. **Layered Verification:** Unit tests and e2e integration tests pass.
4. **Reproducible Documentation:** Any metrics or architectural claims must reference reproducible tests.
5. **Clean IPC & Security:** Strict typing across IPC channels with origin/sender verification.

## Development Workflow

1. Install dependencies: `npm install`
2. Run typecheck: `npm run typecheck`
3. Run tests: `npm test`
4. Build renderer and main bundles: `npm run build`
5. Audit module reachability: `npm run audit:reachability`
