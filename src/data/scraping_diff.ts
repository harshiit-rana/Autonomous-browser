/**
 * Project Aegis - Real-Time Web Scraping Diff Engine
 * 
 * Implements:
 * - Issue #81: DATA-05 Real-Time Web Scraping Diff Engine (Competitive Price Tracking)
 */

export interface ItemRecord {
  id: string; // Unique primary key (e.g. SKU, product title, or URL)
  [key: string]: any;
}

export interface DiffResult {
  added: ItemRecord[];
  removed: ItemRecord[];
  modified: Array<{
    id: string;
    changes: Record<string, { oldValue: any; newValue: any }>;
  }>;
  totalBefore: number;
  totalAfter: number;
  timestamp: number;
}

export class ScrapingDiffEngine {
  /**
   * Computes granular structural diff between two snapshots of scraped items.
   */
  public static computeDiff(
    previous: ItemRecord[],
    current: ItemRecord[],
    idField = 'id'
  ): DiffResult {
    const prevMap = new Map<string, ItemRecord>();
    for (const item of previous) {
      prevMap.set(String(item[idField]), item);
    }

    const currMap = new Map<string, ItemRecord>();
    for (const item of current) {
      currMap.set(String(item[idField]), item);
    }

    const added: ItemRecord[] = [];
    const removed: ItemRecord[] = [];
    const modified: DiffResult['modified'] = [];

    // Find added & modified
    for (const [id, currItem] of currMap.entries()) {
      const prevItem = prevMap.get(id);
      if (!prevItem) {
        added.push(currItem);
      } else {
        // Compare fields
        const changes: Record<string, { oldValue: any; newValue: any }> = {};
        const allKeys = new Set([...Object.keys(prevItem), ...Object.keys(currItem)]);

        for (const k of allKeys) {
          if (k === idField) continue;
          if (JSON.stringify(prevItem[k]) !== JSON.stringify(currItem[k])) {
            changes[k] = {
              oldValue: prevItem[k],
              newValue: currItem[k]
            };
          }
        }

        if (Object.keys(changes).length > 0) {
          modified.push({ id, changes });
        }
      }
    }

    // Find removed
    for (const [id, prevItem] of prevMap.entries()) {
      if (!currMap.has(id)) {
        removed.push(prevItem);
      }
    }

    return {
      added,
      removed,
      modified,
      totalBefore: previous.length,
      totalAfter: current.length,
      timestamp: Date.now()
    };
  }
}
