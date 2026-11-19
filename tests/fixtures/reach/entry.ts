import { staticFunc } from './static_mod.js';
import type { TypeOnlyInterface } from './type_only_mod.js';
import { cycleAFunc } from './cycle_a.js';

export async function main() {
  staticFunc();
  cycleAFunc();
  const dyn = await import('./dynamic_mod.js');
  dyn.dynamicFunc();
}
