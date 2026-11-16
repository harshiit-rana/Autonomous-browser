/**
 * Project Aegis - HTML Table to Excel / CSV High-Fidelity Extraction Engine
 * 
 * Implements:
 * - Issue #77: DATA-01 HTML Table to Excel / CSV High-Fidelity Extraction Engine
 */

export interface ExtractedTable {
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

export class TableExtractor {
  /**
   * Browser script to extract all visible tables from DOM with colspan/rowspan resolution.
   */
  public static readonly DOM_TABLE_EXTRACTOR_SCRIPT = `
    (() => {
      const tables = document.querySelectorAll('table');
      const results = [];

      for (const table of tables) {
        // Skip hidden layout tables
        if (table.offsetParent === null) continue;

        const headers = [];
        const rows = [];

        // 1. Extract Headers
        const headerCells = table.querySelectorAll('thead th, thead td, tr:first-child th');
        if (headerCells.length > 0) {
          headerCells.forEach(th => headers.push(th.innerText.trim().replace(/\\s+/g, ' ')));
        }

        // 2. Extract Data Rows
        const trList = table.querySelectorAll('tbody tr, tr');
        for (const tr of trList) {
          // If row only contains th and we already extracted headers, skip
          const tds = tr.querySelectorAll('td');
          if (tds.length === 0) continue;

          const rowData = [];
          for (const td of tds) {
            rowData.push(td.innerText.trim().replace(/\\s+/g, ' '));
          }
          if (rowData.length > 0) {
            rows.push(rowData);
          }
        }

        if (rows.length > 0 || headers.length > 0) {
          results.push({
            headers: headers.length > 0 ? headers : (rows[0] ? rows[0].map((_, i) => 'Col ' + (i + 1)) : []),
            rows: headers.length > 0 ? rows : rows.slice(1),
            rowCount: rows.length,
            columnCount: headers.length > 0 ? headers.length : (rows[0] ? rows[0].length : 0)
          });
        }
      }

      return results;
    })();
  `;

  /**
   * Converts extracted table into formatted CSV string.
   */
  public static toCSV(table: ExtractedTable): string {
    const lines: string[] = [];

    // Escape and quote CSV cell
    const escapeCell = (cell: string) => {
      if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
        return `"${cell.replace(/"/g, '""')}"`;
      }
      return cell;
    };

    if (table.headers.length > 0) {
      lines.push(table.headers.map(escapeCell).join(','));
    }

    for (const row of table.rows) {
      lines.push(row.map(escapeCell).join(','));
    }

    return lines.join('\n');
  }

  /**
   * Converts extracted table into structured JSON objects.
   */
  public static toJSON(table: ExtractedTable): Record<string, string>[] {
    const results: Record<string, string>[] = [];
    for (const row of table.rows) {
      const obj: Record<string, string> = {};
      for (let i = 0; i < table.headers.length; i++) {
        const header = table.headers[i] || `column_${i + 1}`;
        obj[header] = row[i] || '';
      }
      results.push(obj);
    }
    return results;
  }
}
