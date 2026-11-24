# Truthful evidence (#230 SWX-04)

What a swarm finding is, how it is verified, and how its strength is computed. Code: `src/swarm/evidence_truth.ts` (pure logic),
`src/swarm/blackboard.ts` (store), `src/swarm/worker_findings.ts` (worker guard and verifier stage), `src/data/verified_report.ts` and
`src/swarm/coordinator.ts` (report). Tests: `tests/test_evidence_truth.ts`, `tests/e2e/evidence_truth.spec.ts`.

## 1. A finding is a quote on a page

A worker records a fact with `report_finding(entity, attribute, value, quote, url[, language, translation])`.

1. The quote must be an **exact normalised substring** of the page text the worker was looking at. Normalisation (`normalizeText`):
   HTML entities decoded, Unicode NFKC, every space variant (nbsp, thin, narrow) a plain space, zero-width characters dropped,
   typographic quotes and dashes made ASCII, whitespace collapsed. Case is not folded. Anything else is rejected. A near miss (for
   example `$99.00` where the page says `$129.00`) is rejected too; its word overlap is only shown in the error message.
2. The quote must state the value: as text, or as the same amount of money written differently (`129.00 USD` and `$129.00`).
3. The reported URL must be the page's own URL.
4. The blackboard checks the quote again against the same page text, stores that text as a **snapshot**
   (`<missionDir>/evidence/<sha256>.txt`) and records `pageTextHash`, `snapshotRef`, `retrievedAt` and the page title on the finding.
   A rejected finding records nothing: no row, no snapshot, no visit.

A finding posted without page text (older callers) is kept but is `unverifiable`: its strength is 0 and reports leave it out.

Other languages: the original quote (page language) is what is verified; `language` and an English `translation` are stored next to it
and shown in the report, never used for matching.

## 2. Strength (what was called "confidence")

`confidence` is a number in [0, 1], recomputed whenever another finding for the same `(entity, attribute)` arrives, and persisted.
A value passed by the caller is ignored.

```
strength = sourceWeight x quoteMatch x (1 - 0.35 x 0.5^(independentSources - 1)) / (1 + disagreeingSources)
```

| Signal | Meaning |
|---|---|
| `sourceWeight` | official 1.0, primary 0.85, aggregator 0.7, ugc 0.5 (a priori trust in the kind of source) |
| `quoteMatch` | 1 when the quote was verified on a stored page snapshot, otherwise 0 (there is no fuzzy 0.9) |
| `independentSources` | distinct **sites** (host:port) whose verified quotes state this value. The same site twice, with or without tracking parameters, counts once |
| `disagreeingSources` | distinct sites whose verified quotes state a different value for the same entity and attribute |

Examples: one primary source 0.553; two independent sites 0.701; one primary source against one site that disagrees 0.276.
The weights and the 0.35 are heuristics. The score ranks and explains evidence; it is **not a calibrated probability**, and the report says so.
A verdict row (`consensus://`) has no page: its strength is that of the claim it settled on.

## 3. Re-verifying (`verifyEvidence`)

Fetches nothing. It loads the stored snapshot, checks that it still hashes to `pageTextHash`, and checks the quote in it.
Results: `verified`, `unverifiable` (no snapshot), `snapshot_mismatch` (stored text altered), `quote_missing`, `page_changed`
(a caller passed the current page text and the quote is gone), plus `stale` (older than `maxAgeMs`) and `pageChangedSinceFinding`.
The report re-verifies every row and uses `stale` after 24 hours.

## 4. Conflicts

Two findings with different values for one `(entity, attribute)` make a conflict record.

- Automatic settlement is a head count only: a value wins when at least two independent sites state it with verified quotes and they
  are at least 65% of the verified sites. Nothing is settled by comparing strengths, and an official source no longer wins alone.
- Everything else goes to the verifier stage: one model call with each claim's value, **page title**, URL and quote (no strength shown).
  Verdict `winner` (index), `both_valid`, or `needs_human`, with a reason. Anything else leaves the conflict open. A conflict with fewer
  than two verified claims is `needs_human` without a model call. `needs_human` is not asked again; the report lists it for the user.

## 5. Reports

`SwarmCoordinator.synthesizeReport` lists only findings that re-verify (unless `includeUnverifiable`), each row with its evidence id,
the quote, the source and the strength with its signals, then the conflicts (settled and open) and what was left out.
`VerifiedReportSynthesizer.assertGrounded` requires an evidence id on every row and every cited URL (the page and each corroborating
page) to be in the mission's visited-URL log (`visited.jsonl`, written when a worker navigates or a verified finding is posted).
If not, `ReportGroundingError` is thrown and the mission result is a "Report refused" notice listing the offenders, with `success: false`.

## 6. Persistence

Evidence rows (with the computed confidence, snapshot hash, corroborating sources, translation) go to the `evidence` table tagged with
the mission id (#239); snapshots and the visited-URL log are files in the mission directory. A blackboard for the same mission id
reloads all of it.
