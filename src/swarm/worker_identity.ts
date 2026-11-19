/**
 * Project Aegis - Stable worker identity (Issue #229 step 6).
 *
 * Every worker gets a name, a colour and a glyph derived only from its spawn ordinal, so the same worker looks
 * the same in the grid, the timeline and the presence layer (#232-#235) for the whole mission. Names and
 * colours stay distinct for the first 12 workers (the pool never exceeds 8); later ordinals repeat with a suffix.
 */

export interface WorkerIdentity {
  /** Spawn ordinal this identity was derived from (1-based). */
  ordinal: number;
  name: string;
  /** CSS hex colour; chosen to stay distinguishable on dark and light chrome. */
  color: string;
  glyph: string;
}

const NAMES = ['Ada', 'Bram', 'Cleo', 'Dax', 'Eve', 'Finn', 'Gwen', 'Hugo', 'Iris', 'Jude', 'Kira', 'Leo'];
const COLORS = [
  '#38BDF8', '#F472B6', '#A3E635', '#FBBF24', '#C084FC', '#34D399',
  '#FB7185', '#60A5FA', '#F97316', '#2DD4BF', '#E879F9', '#FACC15'
];
const GLYPHS = ['▲', '●', '◆', '■', '★', '✦', '⬢', '◐', '♥', '♠', '♣', '♦'];

export function workerIdentityFor(ordinal: number): WorkerIdentity {
  const n = Math.max(1, Math.floor(ordinal));
  const i = (n - 1) % NAMES.length;
  const cycle = Math.floor((n - 1) / NAMES.length);
  return {
    ordinal: n,
    name: cycle === 0 ? NAMES[i] : `${NAMES[i]} ${cycle + 1}`,
    color: COLORS[i],
    glyph: GLYPHS[i]
  };
}
