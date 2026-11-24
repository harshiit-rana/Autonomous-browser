/**
 * Real-app e2e entry point (#254): `electron dist/main/e2e_entry.js` with `AEGIS_E2E=1`.
 *
 * Installs the read-only observation hooks, then loads the unmodified product entry (`./index.js`). It exists so that the
 * test hooks never have to be compiled into, or branched on inside, the production entry. Without `AEGIS_E2E=1` it
 * refuses to start. Nothing in the product imports this file, and `package.json` build.files keeps it out of the
 * packaged app (see tests/test_e2e_harness_guard.ts).
 */
import { installE2EHooks } from './e2e_hooks.js';

if (process.env.AEGIS_E2E !== '1') {
  process.stderr.write('e2e_entry refuses to start: AEGIS_E2E=1 is not set. Run the product with `npm start` instead.\n');
  process.exit(2);
}

installE2EHooks();
require('./index.js');
