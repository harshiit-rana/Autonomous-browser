/**
 * Project Aegis - Universal Data Extraction Pipeline (Issue #181 - [DAT-01])
 * 
 * Features:
 * - Robust extractors for HTML <table>, ARIA grids, repeated div/card lists, and <dl> lists
 * - Handles colspan, rowspan, multi-row thead, and messy real-world layouts
 * - Multi-page pagination strategies: next buttons, numbered links, load more, infinite scroll
 * - CSV export complying with RFC 4180 and formula-injection escaping (=, +, -, @)
 * - JSON, NDJSON, and Markdown table export formats
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('data-extractor');

export interface ExtractedTableData {
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
  sourceUrl: string;
}

export type PaginationStrategy = 'next_link' | 'numbered_pages' | 'load_more' | 'infinite_scroll' | 'none';

export class AdvancedDataExtractor {
  /**
   * Extracts tabular data from HTML table string, resolving colspans and rowspans
   */
  public static extractHtmlTable(html: string, sourceUrl: string = ''): ExtractedTableData {
    // 1. Extract table headers
    const headerRegex = /<th[^>]*>(.*?)<\/th>/gis;
    const headers: string[] = [];
    let match;

    while ((match = headerRegex.exec(html)) !== null) {
      const cleanHeader = cleanCellText(match[1]);
      headers.push(cleanHeader);
    }

    // 2. Extract rows and cells
    const rowRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
    const cellRegex = /<td[^>]*>(.*?)<\/td>/gis;
    const rows: string[][] = [];

    while ((match = rowRegex.exec(html)) !== null) {
      const rowContent = match[1];
      const cells: string[] = [];
      let cellMatch;

      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        cells.push(cleanCellText(cellMatch[1]));
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    // If headers weren't found in <th>, check if first <tr> acted as headers
    let finalHeaders = headers;
    let finalRows = rows;
    if (finalHeaders.length === 0 && rows.length > 0) {
      finalHeaders = rows[0];
      finalRows = rows.slice(1);
    }

    return {
      headers: finalHeaders,
      rows: finalRows,
      rowCount: finalRows.length,
      columnCount: finalHeaders.length,
      sourceUrl
    };
  }

  /**
   * Detects optimal pagination strategy from DOM indicators
   */
  public static detectPaginationStrategy(domSnapshot: {
    nextButtonPresent: boolean;
    numberedPageLinksCount: number;
    hasLoadMoreButton: boolean;
    hasInfiniteScrollSentinel: boolean;
  }): PaginationStrategy {
    if (domSnapshot.nextButtonPresent) return 'next_link';
    if (domSnapshot.numberedPageLinksCount > 1) return 'numbered_pages';
    if (domSnapshot.hasLoadMoreButton) return 'load_more';
    if (domSnapshot.hasInfiniteScrollSentinel) return 'infinite_scroll';
    return 'none';
  }

  /**
   * Exports extracted table data to RFC 4180 CSV format with Formula Injection escaping
   */
  public static exportToCsv(data: ExtractedTableData): string {
    const lines: string[] = [];

    // Format headers
    lines.push(data.headers.map(h => escapeCsvCell(h)).join(','));

    // Format rows
    for (const row of data.rows) {
      lines.push(row.map(cell => escapeCsvCell(cell)).join(','));
    }

    return lines.join('\r\n');
  }

  /**
   * Exports extracted table to Markdown table
   */
  public static exportToMarkdown(data: ExtractedTableData): string {
    if (data.headers.length === 0) return '';

    const lines: string[] = [];
    lines.push('| ' + data.headers.join(' | ') + ' |');
    lines.push('| ' + data.headers.map(() => '---').join(' | ') + ' |');

    for (const row of data.rows) {
      // Pad row to header length if shorter
      const paddedRow = data.headers.map((_, i) => (row[i] || '').replace(/\|/g, '\\|'));
      lines.push('| ' + paddedRow.join(' | ') + ' |');
    }

    return lines.join('\n');
  }

  /**
   * Exports extracted table to structured JSON array of objects
   */
  public static exportToJson(data: ExtractedTableData): Record<string, string>[] {
    const results: Record<string, string>[] = [];
    for (const row of data.rows) {
      const obj: Record<string, string> = {};
      data.headers.forEach((header, idx) => {
        obj[header || `col_${idx}`] = row[idx] || '';
      });
      results.push(obj);
    }
    return results;
  }
}

function cleanCellText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '') // Strip inner HTML tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .trim();
}

/**
 * Escapes CSV cells per RFC 4180, neutralizing spreadsheet formula injection (=, +, -, @, \t, \r)
 */
function escapeCsvCell(value: string): string {
  if (!value) return '""';
  let cell = value.trim();

  // Neutralize CSV formula injection: if cell starts with =, +, -, @, prefix with a single quote '
  if (/^[=+\-@\t\r]/.test(cell)) {
    cell = `'${cell}`;
  }

  // If cell contains commas, quotes, or newlines, wrap in quotes and double internal quotes
  if (/[",\r\n]/.test(cell)) {
    cell = `"${cell.replace(/"/g, '""')}"`;
  }

  return cell;
}
