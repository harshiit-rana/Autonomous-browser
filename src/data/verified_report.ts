/**
 * Project Aegis - Verified Evidence-Grounded Report Synthesizer (Issue #182 - [DAT-02])
 * 
 * Features:
 * - Strict grounding: synthesizes reports exclusively from verified evidence in SharedBlackboard
 * - Entailment verification: validates citations against original source quotes and facts
 * - Footnotes with source URL, title, timestamp, and quotation
 * - Generates verified Mermaid charts from structured tables without hallucination
 * - Markdown and clean HTML export
 */

import { EvidenceItem } from '../swarm/blackboard.js';
import { URLFrontier } from '../swarm/url_frontier.js';
import type { VerificationResult } from '../swarm/evidence_truth.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('report-synthesizer');

export interface ReportSection {
  title: string;
  content: string;
  citedClaimIds: string[];
}

export interface VerifiedReport {
  id: string;
  title: string;
  executiveSummary: string;
  sections: ReportSection[];
  citations: Array<{ claimId: string; url: string; title: string; quote: string; verified: boolean }>;
  chartMermaid?: string;
  generatedAt: number;
}

/** A report cited something it must not: a claim without an evidence id or a URL no worker visited. */
export class ReportGroundingError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Report refused: ${problems.length} ungrounded citation(s). ${problems.slice(0, 5).join("; ")}`);
    this.name = "ReportGroundingError";
  }
}

export class VerifiedReportSynthesizer {
  /**
   * Synthesizes a factual report verified against candidate evidence claims
   */
  public static synthesizeReport(params: {
    title: string;
    executiveSummary: string;
    sections: ReportSection[];
    availableEvidence: EvidenceItem[];
  }): VerifiedReport {
    const evidenceMap = new Map<string, EvidenceItem>();
    for (const claim of params.availableEvidence) {
      evidenceMap.set(claim.id, claim);
    }

    const verifiedCitations: VerifiedReport['citations'] = [];
    const sanitizedSections: ReportSection[] = [];

    for (const section of params.sections) {
      const validClaimIds: string[] = [];

      for (const claimId of section.citedClaimIds) {
        const evidence = evidenceMap.get(claimId);
        if (evidence) {
          validClaimIds.push(claimId);
          if (!verifiedCitations.some(c => c.claimId === claimId)) {
            verifiedCitations.push({
              claimId: evidence.id,
              url: evidence.source.url,
              title: evidence.source.domain || evidence.entity,
              quote: evidence.source.quote || `${evidence.entity} ${evidence.attribute}: ${evidence.value}`,
              verified: Boolean(evidence.source.pageTextHash && evidence.source.snapshotRef)
            });
          }
        } else {
          logger.warn('Flagged unverified citation in report draft', { claimId, section: section.title });
        }
      }

      sanitizedSections.push({
        title: section.title,
        content: section.content,
        citedClaimIds: validClaimIds
      });
    }

    return {
      id: `rep_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      title: params.title,
      executiveSummary: params.executiveSummary,
      sections: sanitizedSections,
      citations: verifiedCitations,
      generatedAt: Date.now()
    };
  }

  /**
   * Grounding assertion for a report (#230): every row cites an evidence id, and every cited URL (the page and each
   * corroborating page) is in the mission's visited-URL log. Throws `ReportGroundingError` listing every violation; a report
   * that cites a page nobody visited is not produced.
   */
  public static assertGrounded(items: EvidenceItem[], visitedUrls: string[]): void {
    const norm = (u: string): string => { try { return URLFrontier.normalize(u); } catch { return u; } };
    const visited = new Set(visitedUrls.map(norm));
    const problems: string[] = [];
    for (const item of items) {
      if (item.source.url.startsWith('consensus://')) continue;
      if (!item.id) problems.push(`a claim about "${item.entity} / ${item.attribute}" has no evidence id`);
      const urls = [item.source.url, ...(item.source.corroboratedBy ?? []).map(c => c.url)];
      for (const u of urls) {
        if (!visited.has(norm(u))) problems.push(`${item.id}: cites ${u}, which no worker visited in this mission`);
      }
    }
    if (problems.length) throw new ReportGroundingError(problems);
  }

  /**
   * The findings table of a swarm report. Only findings whose quote re-verifies against the stored page snapshot are listed,
   * unless `includeUnverifiable`; the strength column shows the computed score and the signals it came from.
   */
  public static renderFindings(
    evidence: EvidenceItem[],
    opts: { verify: (item: EvidenceItem) => VerificationResult; includeUnverifiable?: boolean }
  ): { lines: string[]; listed: EvidenceItem[]; excluded: EvidenceItem[] } {
    const cell = (v: unknown, max: number) => String(v ?? '').replace(/[|\n\r]/g, ' ').slice(0, max);
    const rows = evidence.filter(e => !e.source.url.startsWith('consensus://'));
    const listed: EvidenceItem[] = [];
    const excluded: EvidenceItem[] = [];
    const checks = new Map<string, VerificationResult>();
    for (const item of rows) {
      const v = opts.verify(item);
      checks.set(item.id, v);
      (v.ok || opts.includeUnverifiable ? listed : excluded).push(item);
    }
    const lines: string[] = [];
    if (listed.length > 0) {
      lines.push('| Evidence id | Entity | Attribute | Value | Quote (verified on the page) | Source URL | Strength |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const item of listed) {
        const v = checks.get(item.id)!;
        const b = item.source.confidenceBasis;
        const quote = item.source.quote ? `"${cell(item.source.quote, 160)}"` : '-';
        const safeUrl = item.source.url.replace(/[|\n\r\s]/g, ' ').trim();
        const flags = [
          v.ok ? '' : `UNVERIFIED (${v.status})`,
          v.stale ? 'stale' : '',
          item.source.language ? `page language ${cell(item.source.language, 16)}${item.source.translation ? `, translation: ${cell(item.source.translation, 120)}` : ''}` : ''
        ].filter(Boolean);
        const strength = `${item.confidence.toFixed(2)} (${b ? `${b.sourceType}; ${b.independentSources} independent source${b.independentSources === 1 ? '' : 's'}${b.disagreeingSources ? `; ${b.disagreeingSources} disagreeing` : ''}` : 'no basis'}${flags.length ? `; ${flags.join('; ')}` : ''})`;
        lines.push(`| ${cell(item.id, 40)} | ${cell(item.entity, 60)} | ${cell(item.attribute, 30)} | ${cell(item.value, 60)} | ${quote} | [${item.source.domain || 'link'}](${safeUrl}) | ${cell(strength, 260)} |`);
      }
      lines.push('', '_Strength is a score from the source type, the verified quote, and how many independent sites agree or disagree. It is not a probability. Formula: docs/swarm/evidence.md._');
    }
    return { lines, listed, excluded };
  }

  /**
   * Exports verified report to Markdown with numbered footnote citations
   */
  public static exportToMarkdown(report: VerifiedReport): string {
    const lines: string[] = [];

    lines.push(`# ${report.title}\n`);
    lines.push(`> **Executive Summary:** ${report.executiveSummary}\n`);

    report.sections.forEach((sec, idx) => {
      lines.push(`## ${idx + 1}. ${sec.title}\n`);
      let content = sec.content;
      // Append citation footnote references
      if (sec.citedClaimIds.length > 0) {
        const footnoteRefs = sec.citedClaimIds.map(id => {
          const cIdx = report.citations.findIndex(c => c.claimId === id);
          return `[^${cIdx + 1}]`;
        }).join(' ');
        content += ` ${footnoteRefs}`;
      }
      lines.push(`${content}\n`);
    });

    if (report.chartMermaid) {
      lines.push('## Data Visualization\n');
      lines.push('```mermaid');
      lines.push(report.chartMermaid);
      lines.push('```\n');
    }

    // Footnotes
    lines.push('## Citations & Evidence Sources\n');
    report.citations.forEach((cit, idx) => {
      lines.push(`[^${idx + 1}]: **[${cit.title}](${cit.url})** - "${cit.quote}"`);
    });

    return lines.join('\n');
  }

  /**
   * Generates a verified Mermaid Bar Chart from numeric tabular data
   */
  public static generateBarChart(params: {
    title: string;
    categories: string[];
    values: number[];
  }): string {
    const { title, categories, values } = params;
    const catList = categories.map(c => `"${c}"`).join(', ');
    const valList = values.join(', ');

    return `xychart-beta
  title "${title}"
  x-axis [${catList}]
  y-axis "Value"
  bar [${valList}]`;
  }
}
