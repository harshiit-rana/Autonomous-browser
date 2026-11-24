/**
 * Issue #230 (SWX-04): truthful evidence. Plain Node, no Electron and no model (the verifier is a scripted IModelProvider, as in
 * the other swarm suites). Every assertion is about observable behaviour: what is recorded, what is rejected, which numbers
 * come out of the formula, what the report contains and what it refuses to produce.
 *  1. quote verification: exact normalised substring only (whitespace, entities, typography); fabricated and near-miss rejected
 *  2. one money normaliser with locale support
 *  3. confidence is computed from verifiable signals (source type, verified quote, independent agreeing / disagreeing domains)
 *  4. blackboard: rejection records nothing, duplicated sources, corroboration, dissent, ignored caller confidence
 *  5. verifyEvidence from the stored snapshot: tampered snapshot, changed page, stale, unverifiable
 *  6. persistence with the mission (real SQLite + snapshot files), restored after restart
 *  7. conflicts: verifier gets both quotes and titles; winner / both_valid / needs_human; never by confidence alone
 *  8. report: unverifiable left out unless included; every cited URL must be in the visited log or the report is refused
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SharedBlackboard, EvidenceNormalizer } from '../src/swarm/blackboard.js';
import {
  normalizeText, matchQuote, parseMoney, computeConfidence, hashPageText, verifyEvidence, MemoryEvidenceStore, FileEvidenceStore
} from '../src/swarm/evidence_truth.js';
import { checkFinding, adjudicateConflicts } from '../src/swarm/worker_findings.js';
import { SwarmCoordinator } from '../src/swarm/coordinator.js';
import { SwarmManager } from '../src/swarm/swarm_manager.js';
import { VerifiedReportSynthesizer, ReportGroundingError } from '../src/data/verified_report.js';
import { AegisDb, setDb } from '../src/infrastructure/db.js';
import { createRepos } from '../src/infrastructure/repos/index.js';
import type { IModelProvider, ModelRequest, ModelResponse } from '../src/models/types.js';
import { fakeWorkerFactory } from './helpers/fake_worker_host.js';

console.log('--- #230 SWX-04: truthful evidence ---');
const bbNew = () => new SharedBlackboard({ inMemory: true });
const pageA = 'Shop Alpha\nAegis Widget X:   $129.00 including tax\nFree returns within 30 days';
const quoteA = 'Aegis Widget X: $129.00 including tax';

function judge(answer: Record<string, unknown> | null, seen: ModelRequest[] = []): IModelProvider {
  return {
    providerName: 'test', modelName: 'test',
    async generate(req: ModelRequest): Promise<ModelResponse> {
      seen.push(req);
      return { text: '', toolCalls: answer ? [{ id: 'c1', name: 'resolve_conflict', arguments: answer }] : [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
  };
}

async function main() {
  // ---- 1. quote verification
  {
    assert.equal(matchQuote(quoteA, pageA).score, 1, 'whitespace runs on the page are collapsed');
    assert.equal(matchQuote('Aegis Widget X:\u00a0$129.00\u2009including tax', pageA).score, 1, 'non-breaking and thin spaces');
    assert.equal(matchQuote('Aegis Widget X: $129.00 including tax', 'Aegis&nbsp;Widget X: $129.00 including&#32;tax').score, 1, 'entities on the page side');
    assert.equal(matchQuote('Tom &amp; Jerry&#8217;s deal: &#36;5.00', "Tom & Jerry's deal: $5.00").score, 1, 'entities in the quote');
    assert.equal(matchQuote('The \u201cbest\u201d price \u2013 today', 'The "best" price - today').score, 1, 'typographic quotes and dashes');
    assert.equal(matchQuote('Price: \u200b$129.00', 'Price: $129.00').score, 1, 'zero-width characters');
    assert.equal(normalizeText('a\u00a0\u00a0b\n\tc'), 'a b c');
    // rejected
    const fabricated = matchQuote('Aegis Widget X: $99.00 including tax', pageA);
    assert.equal(fabricated.score, 0, 'a quote that is not on the page is rejected');
    assert.ok(fabricated.similarity >= 0.7 && fabricated.similarity < 1, 'the near miss is reported but never accepted');
    assert.equal(matchQuote('aegis widget x: $129.00 including tax', pageA).score, 0, 'case is not folded');
    assert.equal(matchQuote('Aegis Widget X: $129.00', 'Aegis Widget X: $129.0').score, 0, 'a truncated number is not a match');
    assert.equal(matchQuote('ab', 'ab ab').score, 0, 'a quote under 3 characters never counts');
    assert.equal(matchQuote('', pageA).score, 0);
    assert.notEqual(hashPageText('a b'), hashPageText('a c'));
    assert.equal(hashPageText('a   b'), hashPageText('a b'), 'the page hash ignores whitespace noise');
    console.log('✓ quotes: exact normalised substring only; whitespace, entity and typography variants match; fabricated, near-miss and case changes do not');
  }

  // ---- worker guard uses the same rules
  {
    const page = { text: pageA, url: 'http://a.test/p' };
    assert.equal(checkFinding({ value: '$129.00', quote: quoteA, url: page.url }, page).ok, true);
    assert.equal(checkFinding({ value: '129.00 USD', quote: quoteA, url: page.url }, page).ok, true, 'same amount, written differently');
    assert.equal(checkFinding({ value: '$1,299.00', quote: 'Price: 1.299,00 \u20ac', url: page.url, locale: 'de-DE' }, { text: 'Price: 1.299,00 \u20ac', url: page.url }).ok, false, 'EUR is not USD');
    assert.equal(checkFinding({ value: '1299 EUR', quote: 'Preis: 1.299,00 \u20ac', url: page.url, locale: 'de-DE' }, { text: 'Preis: 1.299,00 \u20ac', url: page.url }).ok, true, 'German formatting with locale');
    assert.match(checkFinding({ value: '$130.00', quote: quoteA, url: page.url }, page).problem!, /does not contain the value/);
    assert.match(checkFinding({ value: '$129.00', quote: 'Aegis Widget X: $129.00 incl tax', url: page.url }, page).problem!, /does not occur/);
    console.log('✓ worker guard: money written differently is the same value, a different amount is not');
  }

  // ---- 2. money
  {
    assert.deepEqual(parseMoney('$1,299.00'), { amount: 1299, currency: 'USD' });
    assert.deepEqual(parseMoney('1299 USD'), { amount: 1299, currency: 'USD' });
    assert.deepEqual(parseMoney('1.299,00 \u20ac', { locale: 'de-DE' }), { amount: 1299, currency: 'EUR' });
    assert.deepEqual(parseMoney('1 299,00 EUR', { locale: 'fr-FR' }), { amount: 1299, currency: 'EUR' });
    assert.deepEqual(parseMoney('1\u202f299,00\u00a0\u20ac', { locale: 'fr' }), { amount: 1299, currency: 'EUR' });
    assert.deepEqual(parseMoney('\u20b91,29,999.00'), { amount: 129999, currency: 'INR' });
    assert.deepEqual(parseMoney('19,99 \u20ac'), { amount: 19.99, currency: 'EUR' }, 'a comma with two digits after it is a decimal comma');
    assert.deepEqual(parseMoney('1,299', { locale: 'en-US' }), { amount: 1299 });
    assert.deepEqual(parseMoney('1.299', { locale: 'de-DE' }), { amount: 1299 }, 'German grouping');
    assert.equal(parseMoney('1.299')?.ambiguous, true, 'no locale and one separator followed by 3 digits: flagged, not guessed silently');
    assert.equal(parseMoney('16 GB'), null);
    assert.equal(parseMoney('$12 and $13'), null);
    assert.equal(parseMoney('$'), null);
    const usd1 = EvidenceNormalizer.normalize('$1,299.00', 'price');
    const usd2 = EvidenceNormalizer.normalize('1299 USD', 'price');
    assert.ok(EvidenceNormalizer.areEquivalent(usd1, usd2), '$1,299.00 and 1299 USD are one value');
    assert.ok(!EvidenceNormalizer.areEquivalent(usd1, EvidenceNormalizer.normalize('1299 EUR', 'price')), 'same number, other currency: different');
    assert.ok(EvidenceNormalizer.areEquivalent(usd1, EvidenceNormalizer.normalize('1.299,00 $', 'price', 'de-DE')), 'locale-aware');
    console.log('✓ money: one normaliser, locale aware ($1,299.00 = 1299 USD = 1.299,00 $ de-DE; EUR differs)');
  }

  // ---- 3. confidence is computed
  {
    const c = (sourceType: any, quoteMatch: 0 | 1, independentSources: number, disagreeingSources: number) => computeConfidence({ sourceType, quoteMatch, independentSources, disagreeingSources }).value;
    assert.equal(c('primary', 1, 1, 0), 0.553, '0.85 x (1 - 0.35)');
    assert.equal(c('primary', 1, 2, 0), 0.701, '0.85 x (1 - 0.175)');
    assert.equal(c('official', 1, 1, 0), 0.65);
    assert.equal(c('ugc', 1, 1, 0), 0.325);
    assert.equal(c('primary', 1, 1, 1), 0.276, 'one disagreeing site halves it');
    assert.equal(c('official', 0, 5, 0), 0, 'no verified quote: 0, whatever else is true');
    const seen = new Set([c('official', 1, 1, 0), c('primary', 1, 1, 0), c('aggregator', 1, 1, 0), c('ugc', 1, 1, 0), c('primary', 1, 2, 0), c('primary', 1, 3, 0), c('primary', 1, 1, 1), c('primary', 1, 1, 2)]);
    assert.equal(seen.size, 8, 'every distinct set of signals gives a distinct number');
    assert.ok(c('primary', 1, 9, 0) < 0.85, 'never reaches the source weight, let alone 1');
    assert.ok(c('primary', 1, 3, 0) > c('primary', 1, 2, 0) && c('primary', 1, 2, 0) > c('primary', 1, 1, 0), 'more independent sources, more strength');
    assert.ok(c('primary', 1, 2, 1) < c('primary', 1, 2, 0), 'disagreement lowers it');
    console.log('✓ confidence: computed from source type x verified quote x corroboration / dissent; 0 without a verified quote');
  }

  // ---- 4. blackboard: rejection, duplicates, corroboration, dissent
  {
    const bb = bbNew();
    const bad = bb.postEvidence({ entity: 'Widget at Alpha', attribute: 'price', value: '$99.00', source: { url: 'http://alpha.test/p', quote: 'Aegis Widget X: $99.00 including tax' }, pageText: pageA, workerId: 'w1' });
    assert.equal(bad.posted, false);
    assert.match(bad.rejected!, /not a substring of the page text/);
    assert.equal(bb.getAllEvidence().length, 0, 'a rejected quote records nothing');
    assert.equal(bb.getVisitedUrls().length, 0, 'and does not count as a visit');
    const noQuote = bb.postEvidence({ entity: 'Widget at Alpha', attribute: 'price', value: '$129.00', source: { url: 'http://alpha.test/p' }, pageText: pageA, workerId: 'w1' });
    assert.equal(noQuote.posted, false, 'with page text a quote is required');
    assert.equal(bb.getAllEvidence().length, 0);

    const ok = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$129.00', source: { url: 'http://alpha.test/p', quote: quoteA, pageTitle: 'Shop Alpha' }, pageText: pageA, workerId: 'w1', confidence: 0.99 });
    assert.ok(ok.posted);
    const item = bb.getAllEvidence()[0];
    assert.equal(item.confidence, 0.553, 'the caller-supplied 0.99 is ignored; the score is computed');
    assert.equal(item.source.confidenceBasis?.quoteMatch, 1);
    assert.equal(item.source.pageTextHash, hashPageText(pageA));
    assert.match(item.source.snapshotRef!, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(bb.getVisitedUrls(), ['http://alpha.test/p']);

    // duplicated source: same domain, other page (or tracking parameter) states the same value -> no corroboration
    const sameDomain = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '129.00 USD', source: { url: 'http://alpha.test/other?ref=x', quote: quoteA }, pageText: pageA, workerId: 'w2' });
    assert.equal(sameDomain.posted, false);
    assert.equal(sameDomain.corroborated, undefined);
    assert.equal(sameDomain.duplicate, true);
    assert.equal(bb.getAllEvidence()[0].confidence, 0.553, 'a duplicated source adds nothing');
    assert.equal(bb.getAllEvidence()[0].source.corroboratedBy, undefined);

    // an independent domain with a verified quote: corroboration
    const pageB = 'Beta Store - Aegis Widget X costs $129.00 today';
    const co = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$129.00', source: { url: 'http://beta.test/x', quote: 'Aegis Widget X costs $129.00 today' }, pageText: pageB, workerId: 'w3' });
    assert.equal(co.corroborated, true);
    assert.equal(bb.getAllEvidence().length, 1);
    assert.equal(bb.getAllEvidence()[0].confidence, 0.701);
    assert.equal(bb.getAllEvidence()[0].source.corroboratedBy?.length, 1);
    // ...but a corroborating claim with a fabricated quote is rejected and does not count
    const fakeCo = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$129.00', source: { url: 'http://gamma.test/x', quote: 'Aegis Widget X costs $129.00 right now' }, pageText: 'Gamma. Widget at $129.00', workerId: 'w4' });
    assert.equal(fakeCo.rejected !== undefined, true);
    assert.equal(bb.getAllEvidence()[0].confidence, 0.701);

    // disagreement lowers it, and the conflict is recorded
    const pageD = 'Delta: Aegis Widget X is $119.50';
    const dis = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$119.50', source: { url: 'http://delta.test/x', quote: 'Aegis Widget X is $119.50' }, pageText: pageD, workerId: 'w5' });
    assert.ok(dis.conflict);
    const [first, second] = bb.getAllEvidence();
    assert.equal(first.confidence, 0.351, '0.85 x 0.825 / 2 (one disagreeing site)');
    assert.equal(second.confidence, 0.184, '0.85 x 0.65 / (1 + 2 sites stating $129.00)');
    assert.equal(dis.conflict!.resolved, true, '2 independent domains against 1 is settled by head count');
    assert.equal(dis.conflict!.resolutionMethod, 'majority');
    assert.equal(dis.conflict!.resolvedValue, '$129.00');
    console.log('✓ blackboard: fabricated quote records nothing; caller confidence ignored; same-domain duplicate adds nothing; independent domain corroborates; dissent lowers strength');
  }

  // ---- 5. verifyEvidence against the stored snapshot
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ev-'));
    const store = new FileEvidenceStore(dir);
    const bb = new SharedBlackboard({ inMemory: true, artifactStore: store });
    bb.postEvidence({ entity: 'W', attribute: 'price', value: '$129.00', source: { url: 'http://a.test/p', quote: quoteA }, pageText: pageA, workerId: 'w1' });
    bb.postEvidence({ entity: 'W2', attribute: 'price', value: '$5.00', source: { url: 'http://b.test/p', quote: 'only a quote $5.00' }, workerId: 'w1' });
    const [verified, loose] = bb.getAllEvidence();
    assert.equal(bb.verifyEvidence(verified).status, 'verified');
    assert.equal(loose.confidence, 0, 'no page text: confidence 0');
    assert.equal(bb.verifyEvidence(loose).status, 'unverifiable', 'no snapshot recorded -> unverifiable');
    assert.equal(bb.verifyEvidence(loose).ok, false);

    // stale: verified when found, old now
    const old = bb.verifyEvidence(verified, { now: Date.now() + 3 * 86_400_000, maxAgeMs: 86_400_000 });
    assert.equal(old.ok && old.stale, true);
    assert.equal(bb.verifyEvidence(verified, { maxAgeMs: 86_400_000 }).stale, false);

    // page changed between finding and verification: the caller supplies the current text
    const changedKeepsQuote = bb.verifyEvidence(verified, { currentPageText: pageA + '\nNew banner: sale ends soon' });
    assert.equal(changedKeepsQuote.ok, true);
    assert.equal(changedKeepsQuote.pageChangedSinceFinding, true);
    const changedLosesQuote = bb.verifyEvidence(verified, { currentPageText: 'Shop Alpha\nAegis Widget X: $139.00 including tax' });
    assert.equal(changedLosesQuote.status, 'page_changed');
    assert.equal(changedLosesQuote.ok, false);
    assert.equal(bb.verifyEvidence(verified, { currentPageText: pageA.replace(/ {3}/, ' ') }).pageChangedSinceFinding, false, 'whitespace noise is not a change');

    // the quote is edited after the fact -> no longer in the snapshot
    const edited = { ...verified, source: { ...verified.source, quote: 'Aegis Widget X: $1.00 including tax' } };
    assert.equal(verifyEvidence(edited, store).status, 'quote_missing');
    // the snapshot file is tampered with
    const file = path.join(dir, `${verified.source.pageTextHash}.txt`);
    assert.ok(fs.existsSync(file));
    fs.writeFileSync(file, pageA.replace('$129.00', '$99.00'));
    assert.equal(bb.verifyEvidence(verified).status, 'snapshot_mismatch');
    // the snapshot is gone
    fs.unlinkSync(file);
    assert.equal(bb.verifyEvidence(verified).status, 'unverifiable');
    // a different store knows nothing of it
    assert.equal(verifyEvidence(verified, new MemoryEvidenceStore()).status, 'unverifiable');
    console.log('✓ verifyEvidence: verified / unverifiable / stale / page changed / edited quote / tampered or missing snapshot');
  }

  // ---- 6. evidence is saved with the mission and survives a restart
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ev-db-'));
    const dbFile = path.join(dir, 'aegis.sqlite');
    let db = AegisDb.open(dbFile);
    setDb(db);
    createRepos(db).missions.upsertMission({ id: 'm_ev', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });
    const filesDir = path.join(dir, 'missions', 'm_ev', 'evidence');
    let bb = new SharedBlackboard({ missionId: 'm_ev', evidenceRepo: createRepos(db).evidence, artifactStore: new FileEvidenceStore(filesDir) });
    bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$129.00', source: { url: 'http://alpha.test/p', quote: quoteA, pageTitle: 'Shop Alpha', language: 'de', translation: 'Aegis Widget X: $129.00 incl. tax' }, pageText: pageA, workerId: 'w1' });
    bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$129.00', source: { url: 'http://beta.test/x', quote: 'Aegis Widget X costs $129.00 today' }, pageText: 'Beta Store - Aegis Widget X costs $129.00 today', workerId: 'w2' });
    const before = bb.getAllEvidence()[0];
    assert.equal(before.confidence, 0.701);
    db.close();
    setDb(null);

    db = AegisDb.open(dbFile);
    setDb(db);
    bb = new SharedBlackboard({ missionId: 'm_ev', evidenceRepo: createRepos(db).evidence, artifactStore: new FileEvidenceStore(filesDir) });
    const after = bb.getAllEvidence();
    assert.equal(after.length, 1);
    assert.equal(after[0].confidence, 0.701, 'the recomputed confidence was persisted, not the first value');
    assert.equal(after[0].source.pageTextHash, before.source.pageTextHash);
    assert.equal(after[0].source.corroboratedBy?.[0].domain, 'beta.test');
    assert.equal(after[0].source.language, 'de');
    assert.equal(bb.verifyEvidence(after[0]).status, 'verified', 'the snapshot was kept with the mission and still verifies the quote');
    assert.deepEqual(bb.getVisitedUrls().sort(), ['http://alpha.test/p', 'http://beta.test/x']);
    // translation is stored next to the original; only the original quote is ever matched
    assert.equal(after[0].source.translation, 'Aegis Widget X: $129.00 incl. tax');
    const tr = bb.postEvidence({ entity: 'T', attribute: 'price', value: '$1.00', source: { url: 'http://de.test/x', quote: 'Only the English rendering $1.00', language: 'de', translation: 'Only the English rendering $1.00' }, pageText: 'Nur der deutsche Text: 1,00 $', workerId: 'w9' });
    assert.ok(tr.rejected, 'a quote that exists only as the translation is rejected');
    db.close();
    setDb(null);
    console.log('✓ persistence: evidence, computed confidence, snapshot hash, corroboration, translation and the visited log survive a restart');
  }

  // ---- 7. conflicts: the verifier reads both quotes and the page titles; never by confidence alone
  {
    const mk = () => {
      const bb = bbNew();
      bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$10.00', source: { url: 'http://a.test/', quote: 'Widget now $10.00', pageTitle: 'Shop A - Widget (new)', sourceType: 'official' }, pageText: 'Shop A. Widget now $10.00', workerId: 'w1' });
      const r = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$12.00', source: { url: 'http://b.test/', quote: 'Widget price $12.00', pageTitle: 'Shop B - Widget (refurbished)', sourceType: 'ugc' }, pageText: 'Shop B. Widget price $12.00', workerId: 'w2' });
      assert.ok(r.conflict, 'two fixture prices for one (entity, attribute) produce a conflict record');
      return bb;
    };
    // the high-weight official source loses: the model decided from the quotes
    {
      const bb = mk();
      assert.ok(bb.getAllEvidence()[0].confidence > bb.getAllEvidence()[1].confidence, 'precondition: the first claim is the stronger one');
      const seen: ModelRequest[] = [];
      const res = await adjudicateConflicts(bb, judge({ verdict: 'winner', winner: 1, reason: 'the refurbished page quotes the price directly' }, seen), { missionId: 'm' });
      assert.equal(seen.length, 1, 'exactly one verifier call');
      const prompt = String((seen[0].messages[0] as any).content);
      for (const needle of ['Widget now $10.00', 'Widget price $12.00', 'Shop A - Widget (new)', 'Shop B - Widget (refurbished)', 'http://a.test/', 'http://b.test/']) assert.ok(prompt.includes(needle), `the verifier is shown ${needle}`);
      assert.ok(!/confidence|strength/i.test(prompt) && !bb.getAllEvidence().some(e => prompt.includes(`strength ${e.confidence}`) || prompt.includes(String(e.confidence))), 'the verifier is not shown a confidence to lean on');
      assert.equal(res[0].verdict, 'winner');
      assert.equal(bb.getConflicts()[0].resolvedValue, '$12.00');
      assert.equal(bb.getConflicts()[0].resolutionMethod, 'verifier_adjudicated');
      assert.equal(bb.getUnresolvedConflicts().length, 0);
    }
    {
      const bb = mk();
      const res = await adjudicateConflicts(bb, judge({ verdict: 'both_valid', reason: 'new versus refurbished' }), { missionId: 'm' });
      assert.equal(res[0].verdict, 'both_valid');
      const c = bb.getConflicts()[0];
      assert.equal(c.resolved, true);
      assert.equal(c.resolutionMethod, 'both_valid');
      assert.equal(c.resolvedValue, undefined, 'no value is picked');
      assert.equal(bb.getAllEvidence().length, 2, 'both claims stay');
    }
    {
      const bb = mk();
      const res = await adjudicateConflicts(bb, judge({ verdict: 'needs_human', reason: 'the quotes describe different editions' }), { missionId: 'm' });
      assert.equal(res[0].resolved, false);
      assert.equal(bb.getUnresolvedConflicts()[0].verdict, 'needs_human');
      assert.equal(bb.getUnresolvedConflicts()[0].verdictReason, 'the quotes describe different editions');
      const again: ModelRequest[] = [];
      assert.equal((await adjudicateConflicts(bb, judge({ verdict: 'winner', winner: 0, reason: 'x' }, again), { missionId: 'm' })).length, 0, 'a needs_human verdict is not re-asked');
      assert.equal(again.length, 0);
    }
    {
      const bb = mk();
      for (const bad of [null, { verdict: 'winner', winner: 7, reason: 'x' }, { verdict: 'winner', reason: 'no index' }, { verdict: 'maybe', reason: 'x' }, { choice: 0, reason: 'legacy shape' }]) {
        const r = await adjudicateConflicts(bb, judge(bad as any), { missionId: 'm' });
        assert.equal(r[0].resolved, false, `invalid verdict ${JSON.stringify(bad)} leaves it open`);
      }
      assert.equal(bb.getUnresolvedConflicts().length, 1);
    }
    {
      // a conflict with one unverifiable side never reaches the model
      const bb = bbNew();
      bb.postEvidence({ entity: 'W', attribute: 'price', value: '$1.00', source: { url: 'http://a.test/', quote: 'W $1.00' }, pageText: 'W $1.00', workerId: 'w1' });
      bb.postEvidence({ entity: 'W', attribute: 'price', value: '$2.00', source: { url: 'http://b.test/', quote: 'W $2.00 (no snapshot)' }, workerId: 'w2' });
      const seen: ModelRequest[] = [];
      const r = await adjudicateConflicts(bb, judge({ verdict: 'winner', winner: 0, reason: 'x' }, seen), { missionId: 'm' });
      assert.equal(seen.length, 0);
      assert.equal(r[0].verdict, 'needs_human');
    }
    {
      // automatic settlement is a head count of independent verified domains, not a confidence comparison
      const bb = bbNew();
      const post = (url: string, v: string) => bb.postEvidence({ entity: 'W', attribute: 'price', value: v, source: { url, quote: `W costs ${v}` }, pageText: `W costs ${v}`, workerId: url });
      post('http://a.test/', '$5.00');
      post('http://b.test/', '$5.00');
      const r = post('http://c.test/', '$9.00');
      assert.equal(r.conflict?.resolved, true, '2 independent domains against 1');
      assert.equal(r.conflict?.resolutionMethod, 'majority');
      assert.equal(r.conflict?.resolvedValue, '$5.00');
      const bb2 = bbNew();
      const p2 = (url: string, v: string, type: any) => bb2.postEvidence({ entity: 'W', attribute: 'price', value: v, source: { url, quote: `W costs ${v}`, sourceType: type }, pageText: `W costs ${v}`, workerId: url });
      p2('http://official.test/', '$5.00', 'official');
      const r2 = p2('http://forum.test/', '$9.00', 'ugc');
      assert.equal(r2.conflict?.resolved, false, 'an official source does not win on its own any more');
    }
    console.log('✓ conflicts: verifier sees both quotes and titles, not confidence; winner / both_valid / needs_human; invalid verdicts leave it open; no model call without two verified claims');
  }

  // ---- 8. the report
  {
    const mkCoordinator = (includeUnverifiable = false) => {
      const fakes = fakeWorkerFactory();
      const swarm = new SwarmManager({ missionId: 'm_r', workerFactory: fakes.factory, maxWorkers: 8 });
      const c = new SwarmCoordinator({ swarm, blackboard: bbNew(), includeUnverifiable });
      return { c, swarm };
    };
    // a finding without a snapshot is counted and left out
    {
      const { c, swarm } = mkCoordinator();
      const bb = c.getBlackboard();
      bb.postEvidence({ entity: 'Good', attribute: 'price', value: '$1.00', source: { url: 'http://a.test/p', quote: 'Good $1.00' }, pageText: 'Good $1.00', workerId: 'w1' });
      bb.postEvidence({ entity: 'Loose', attribute: 'price', value: '$2.00', source: { url: 'http://never.test/p', quote: 'Loose $2.00' }, workerId: 'w2' });
      const md = c.synthesizeReport('goal', bb.getAllEvidence(), [], { conflicts: bb.getConflicts() });
      assert.match(md, /\| Good \| price \| \$1\.00 \|/);
      assert.doesNotMatch(md, /\| Loose \|/, 'unverifiable findings are excluded from the table');
      assert.match(md, /Left out: no verified quote \(1\)[\s\S]*Loose \/ price: \$2\.00/);
      assert.match(md, /Completed with Notes/);
      assert.match(md, /not a probability/);
      await swarm.shutdown();
    }
    // included on request, but a URL nobody visited makes the report fail
    {
      const { c, swarm } = mkCoordinator(true);
      const bb = c.getBlackboard();
      bb.postEvidence({ entity: 'Loose', attribute: 'price', value: '$2.00', source: { url: 'http://never.test/p', quote: 'Loose $2.00' }, workerId: 'w2' });
      assert.throws(() => c.synthesizeReport('goal', bb.getAllEvidence(), []), (e: any) => e instanceof ReportGroundingError && /http:\/\/never\.test\/p, which no worker visited/.test(e.message));
      bb.recordVisit('http://never.test/p?utm_source=x', 'w2');
      const md = c.synthesizeReport('goal', bb.getAllEvidence(), []);
      assert.match(md, /UNVERIFIED \(unverifiable\)/, 'an included unverifiable finding is flagged as such in its row');
      assert.match(md, /\| 0\.00 \(/, 'with strength 0');
      await swarm.shutdown();
    }
    // the assertion itself
    {
      const bb = bbNew();
      bb.postEvidence({ entity: 'E', attribute: 'a', value: '$1.00', source: { url: 'http://x.test/1', quote: 'E $1.00' }, pageText: 'E $1.00', workerId: 'w' });
      bb.postEvidence({ entity: 'E', attribute: 'a', value: '$1.00', source: { url: 'http://y.test/2', quote: 'also E $1.00' }, pageText: 'also E $1.00', workerId: 'w' });
      const items = bb.getAllEvidence();
      VerifiedReportSynthesizer.assertGrounded(items, ['http://x.test/1', 'http://y.test/2']);
      assert.throws(() => VerifiedReportSynthesizer.assertGrounded(items, ['http://x.test/1']), /http:\/\/y\.test\/2/, 'a corroborating URL must have been visited too');
      assert.throws(() => VerifiedReportSynthesizer.assertGrounded([{ ...items[0], id: '' }], ['http://x.test/1']), /no evidence id/);
    }
    // end to end through the coordinator: a refused report fails the mission result instead of shipping an ungrounded table
    {
      const { c, swarm } = mkCoordinator(true);
      const res = await c.executeMission('m_refuse', 'compare prices across http://x.test/a http://y.test/b', async () => {
        c.getBlackboard().postEvidence({ entity: 'Ghost', attribute: 'price', value: '$3.00', source: { url: 'http://ghost.test/p', quote: 'Ghost $3.00' }, workerId: 'w' });
        return { status: 'completed' };
      }, { inlineExecutorFn: async () => ({ status: 'completed' }) });
      assert.equal(res.success, false);
      assert.match(res.deliverableMarkdown, /Report refused[\s\S]*ghost\.test\/p, which no worker visited/);
      assert.doesNotMatch(res.deliverableMarkdown, /\| Ghost \|/);
      await swarm.shutdown();
    }
    console.log('✓ report: unverifiable findings left out unless included; a cited URL nobody visited fails the report; strength and basis shown per row');
  }

  console.log('\nALL #230 TRUTHFUL EVIDENCE TESTS PASSED');
}

main().catch(err => { console.error(err); process.exit(1); });
