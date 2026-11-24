/**
 * Project Aegis - truthful evidence (#230 SWX-04).
 *
 * Pure logic, no Electron, no model:
 *  - quote verification: a quote counts only when it is a (normalised) substring of the page text the worker really saw;
 *  - page snapshots: the text a quote was checked against is stored content-addressed (`pageTextHash`), so a finding can be
 *    re-verified later without fetching anything (`verifyEvidence`);
 *  - one money normaliser with locale support (`parseMoney`), used by the blackboard for conflict matching;
 *  - confidence computed from verifiable signals (`computeConfidence`), never a constant. The formula is in docs/swarm/evidence.md.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ------------------------------------------------------------------------------------------------ text normalisation

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'", sbquo: "'", ldquo: '"', rdquo: '"', bdquo: '"',
  euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™', shy: ''
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

/**
 * The single text normaliser behind quote matching and snapshot hashing: HTML entities decoded, Unicode NFKC, every kind of
 * space (nbsp, thin, narrow) a plain space, zero-width characters dropped, typographic quotes and dashes ASCII, whitespace
 * collapsed. Case is NOT folded: "Price" and "price" are different text.
 */
export function normalizeText(input: string): string {
  let s = decodeEntities(String(input ?? ''));
  s = s.normalize('NFKC');
  s = s.replace(/[   -   　]/g, ' ');
  s = s.replace(/[​-‍⁠﻿­]/g, '');
  s = s.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"');
  s = s.replace(/[‐-―−]/g, '-');
  return s.replace(/\s+/g, ' ').trim();
}

export function hashPageText(text: string): string {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex');
}

export interface QuoteMatch {
  /** 1 when the normalised quote is a substring of the normalised page text, otherwise 0. There is no partial credit. */
  score: 0 | 1;
  /** Diagnostic only: word overlap with the closest page window. A fuzzy match is never accepted (it is < 0.9 by rule). */
  similarity: number;
  reason?: string;
}

/** Exact normalised substring = 1.0; anything else is rejected (the similarity is reported for the error message only). */
export function matchQuote(quote: string, pageText: string): QuoteMatch {
  const q = normalizeText(quote);
  const p = normalizeText(pageText);
  if (q.length < 3) return { score: 0, similarity: 0, reason: 'The quote is empty or too short.' };
  if (p.includes(q)) return { score: 1, similarity: 1 };
  const qWords = q.split(' ');
  const pWords = p.split(' ');
  const set = new Set(qWords);
  let best = 0;
  const win = qWords.length;
  for (let i = 0; i + win <= pWords.length && best < 0.99; i += 1) {
    let hit = 0;
    for (let j = 0; j < win; j += 1) if (set.has(pWords[i + j])) hit++;
    best = Math.max(best, hit / win);
  }
  return { score: 0, similarity: Math.round(best * 100) / 100, reason: 'The quote is not a substring of the page text.' };
}

// ------------------------------------------------------------------------------------------------ money

const CURRENCY_SYMBOLS: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', 'US$': 'USD', 'C$': 'CAD', 'A$': 'AUD' };
const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'CAD', 'AUD', 'CHF', 'CNY', 'SEK', 'PLN'];
/** Languages whose decimal separator is a comma and whose grouping is '.', ' ' or an apostrophe. */
const DECIMAL_COMMA_LANGS = new Set(['de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'pl', 'tr', 'sv', 'da', 'nb', 'fi', 'cs', 'id']);

export interface Money {
  amount: number;
  /** ISO code, or undefined when the text names no currency. */
  currency?: string;
  /** A single separator followed by exactly three digits with no locale given ("1.299"): grouping or decimal cannot be told. */
  ambiguous?: boolean;
}

function parseAmount(raw: string, locale?: string): { amount: number; ambiguous: boolean } | null {
  let s = raw.replace(/[   ']/g, '');
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
  const lang = (locale || '').toLowerCase().split(/[-_]/)[0];
  const commaLocale = DECIMAL_COMMA_LANGS.has(lang);
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let ambiguous = false;
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    s = s.split(grp).join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = s.split(sep).length - 1;
    const digitsAfter = s.length - 1 - s.lastIndexOf(sep);
    let decimal: boolean;
    if (count > 1) decimal = false;
    else if (locale) decimal = sep === ',' ? commaLocale || digitsAfter !== 3 : !(commaLocale && digitsAfter === 3);
    else if (sep === '.') { decimal = true; ambiguous = digitsAfter === 3; }
    else { decimal = digitsAfter !== 3; ambiguous = digitsAfter === 3; }
    s = decimal ? s.replace(sep, '.') : s.split(sep).join('');
  }
  const amount = Number(s);
  return Number.isFinite(amount) ? { amount, ambiguous } : null;
}

/**
 * The one place that turns "$1,299.00", "1299 USD", "1.299,00 €" (de-DE), "1 299,00 EUR" (fr-FR) or "₹1,29,999" into
 * `{ amount, currency }`. Returns null when the text is not an amount of money.
 */
export function parseMoney(input: string, opts: { locale?: string } = {}): Money | null {
  const s = String(input ?? '').normalize('NFKC').replace(/[  ]/g, ' ').trim();
  const sym = '(?:US\\$|C\\$|A\\$|[$€£¥₹])';
  const code = `(?:${CURRENCY_CODES.join('|')})`;
  const cur = `(${sym}|${code})`;
  const num = '(\\d[\\d.,\' ]*\\d|\\d)';
  const m = s.match(new RegExp(`^${cur}?\\s*${num}\\s*${cur}?$`, 'i'));
  if (!m) return null;
  const marker = (m[1] || m[3] || '').toUpperCase();
  if (m[1] && m[3]) return null;
  const amt = parseAmount(m[2], opts.locale);
  if (!amt) return null;
  const currency = marker ? (CURRENCY_SYMBOLS[marker] ?? marker) : undefined;
  return { amount: amt.amount, currency, ...(amt.ambiguous ? { ambiguous: true } : {}) };
}

// ------------------------------------------------------------------------------------------------ confidence

export type SourceKind = 'official' | 'primary' | 'aggregator' | 'ugc';

/** How much a kind of source is trusted a priori. A heuristic, not a measured probability (see docs/swarm/evidence.md). */
export const SOURCE_WEIGHT: Record<SourceKind, number> = { official: 1.0, primary: 0.85, aggregator: 0.7, ugc: 0.5 };

export interface ConfidenceBasis {
  sourceType: SourceKind;
  sourceWeight: number;
  /** 1 = the quote was verified on the page snapshot; 0 = it was not (the finding is unverifiable). */
  quoteMatch: 0 | 1;
  /** Distinct domains whose verified quotes state this value (this item's own domain included). */
  independentSources: number;
  /** Distinct domains whose verified quotes state a different value for the same entity and attribute. */
  disagreeingSources: number;
  corroboration: number;
  dissent: number;
  formula: string;
}

export const CONFIDENCE_FORMULA = 'sourceWeight x quoteMatch x (1 - 0.35 x 0.5^(independentSources-1)) / (1 + disagreeingSources)';

/**
 * Evidence strength in [0, 1], computed from signals that can be checked: the kind of source, whether the quote was verified
 * on the page, how many independent domains agree and how many disagree. Without a verified quote it is 0.
 */
export function computeConfidence(i: { sourceType: SourceKind; quoteMatch: 0 | 1; independentSources: number; disagreeingSources: number }): { value: number; basis: ConfidenceBasis } {
  const sourceWeight = SOURCE_WEIGHT[i.sourceType] ?? SOURCE_WEIGHT.ugc;
  const agreeing = Math.max(1, Math.floor(i.independentSources));
  const corroboration = 1 - 0.35 * Math.pow(0.5, agreeing - 1);
  const dissent = 1 / (1 + Math.max(0, Math.floor(i.disagreeingSources)));
  const value = Math.round(sourceWeight * i.quoteMatch * corroboration * dissent * 1000) / 1000;
  return {
    value,
    basis: { sourceType: i.sourceType, sourceWeight, quoteMatch: i.quoteMatch, independentSources: agreeing, disagreeingSources: Math.max(0, Math.floor(i.disagreeingSources)), corroboration: Math.round(corroboration * 1000) / 1000, dissent: Math.round(dissent * 1000) / 1000, formula: CONFIDENCE_FORMULA }
  };
}

// ------------------------------------------------------------------------------------------------ snapshot store

/** Where the page text a quote was verified against, and the URLs a mission visited, are kept. */
export interface EvidenceArtifactStore {
  /** Stores the page text content-addressed and returns its hash and reference. */
  putSnapshot(text: string): { hash: string; ref: string };
  getSnapshot(ref: string): string | undefined;
  addVisit(url: string, workerId?: string): void;
  listVisits(): Array<{ url: string; at: number; workerId?: string }>;
}

export class MemoryEvidenceStore implements EvidenceArtifactStore {
  private readonly snaps = new Map<string, string>();
  private readonly visits: Array<{ url: string; at: number; workerId?: string }> = [];
  putSnapshot(text: string) { const hash = hashPageText(text); this.snaps.set(hash, text); return { hash, ref: `sha256:${hash}` }; }
  getSnapshot(ref: string) { return this.snaps.get(ref.replace(/^sha256:/, '')); }
  addVisit(url: string, workerId?: string) { this.visits.push({ url, at: Date.now(), workerId }); }
  listVisits() { return [...this.visits]; }
}

/** Snapshots as `<hash>.txt` and the visited-URL log as `visited.jsonl` inside one mission's directory. */
export class FileEvidenceStore implements EvidenceArtifactStore {
  constructor(private readonly dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  private file(ref: string) { const h = ref.replace(/^sha256:/, ''); return /^[0-9a-f]{64}$/.test(h) ? path.join(this.dir, `${h}.txt`) : undefined; }
  putSnapshot(text: string) {
    const hash = hashPageText(text);
    const f = this.file(hash)!;
    if (!fs.existsSync(f)) fs.writeFileSync(f, text, 'utf-8');
    return { hash, ref: `sha256:${hash}` };
  }
  getSnapshot(ref: string) {
    const f = this.file(ref);
    try { return f ? fs.readFileSync(f, 'utf-8') : undefined; } catch { return undefined; }
  }
  addVisit(url: string, workerId?: string) {
    fs.appendFileSync(path.join(this.dir, 'visited.jsonl'), JSON.stringify({ url, at: Date.now(), workerId }) + '\n', 'utf-8');
  }
  listVisits() {
    try {
      return fs.readFileSync(path.join(this.dir, 'visited.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { return []; }
  }
}

// ------------------------------------------------------------------------------------------------ re-verification

export type VerificationStatus =
  | 'verified'            // the quote is in the stored page text and the stored text still has its recorded hash
  | 'unverifiable'        // no stored snapshot (or no quote): nothing to check the claim against
  | 'snapshot_mismatch'   // the stored text no longer hashes to the recorded pageTextHash
  | 'quote_missing'       // the quote is not in the stored text
  | 'page_changed'        // `currentPageText` was given and the quote is no longer on the page
  | 'adjudicated';        // a verdict row (consensus://), not a page claim

export interface VerificationResult {
  status: VerificationStatus;
  /** True when the claim may be reported as verified. */
  ok: boolean;
  /** retrievedAt is older than `maxAgeMs`: the quote was verified when found but the page may have moved on. */
  stale: boolean;
  /** `currentPageText` was given and its hash differs from the recorded one (the quote may still be on it). */
  pageChangedSinceFinding: boolean;
  reason: string;
}

export interface VerifiableItem {
  source: { url: string; quote?: string; pageTextHash?: string; snapshotRef?: string; retrievedAt?: number };
}

/**
 * Re-checks a finding without fetching anything: the quote against the stored snapshot, the snapshot against the hash recorded
 * when the finding was made. `currentPageText` (text of the page now, supplied by a caller that has it) additionally detects a
 * page that changed after the finding.
 */
export function verifyEvidence(item: VerifiableItem, store: EvidenceArtifactStore | undefined, opts: { now?: number; maxAgeMs?: number; currentPageText?: string } = {}): VerificationResult {
  const s = item.source;
  const out = (status: VerificationStatus, ok: boolean, reason: string, extra: Partial<VerificationResult> = {}): VerificationResult =>
    ({ status, ok, stale: false, pageChangedSinceFinding: false, reason, ...extra });
  if (s.url.startsWith('consensus://')) return out('adjudicated', true, 'A verdict on conflicting claims, not a page claim.');
  if (!s.quote || !s.pageTextHash || !s.snapshotRef) return out('unverifiable', false, 'No stored page snapshot or quote to check this claim against.');
  const text = store?.getSnapshot(s.snapshotRef);
  if (text === undefined) return out('unverifiable', false, `The page snapshot ${s.snapshotRef} is not available.`);
  if (hashPageText(text) !== s.pageTextHash) return out('snapshot_mismatch', false, 'The stored page text no longer matches the hash recorded when the finding was made.');
  if (matchQuote(s.quote, text).score !== 1) return out('quote_missing', false, 'The quote is not in the stored page text.');
  const stale = opts.maxAgeMs !== undefined && s.retrievedAt !== undefined && (opts.now ?? Date.now()) - s.retrievedAt > opts.maxAgeMs;
  if (opts.currentPageText !== undefined) {
    const changed = hashPageText(opts.currentPageText) !== s.pageTextHash;
    if (changed && matchQuote(s.quote, opts.currentPageText).score !== 1) {
      return out('page_changed', false, 'The page changed after the finding and no longer contains the quote.', { stale, pageChangedSinceFinding: true });
    }
    return out('verified', true, changed ? 'The page changed since the finding but still contains the quote.' : 'The quote is on the stored page text.', { stale, pageChangedSinceFinding: changed });
  }
  return out('verified', true, 'The quote is on the stored page text.', { stale });
}
