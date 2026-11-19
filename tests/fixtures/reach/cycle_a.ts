import { cycleBFunc } from './cycle_b.js';

export function cycleAFunc() {
  return 'cycleA' + cycleBFunc();
}
