/**
 * Project Aegis - Autonomous Multi-Page Pagination Crawler
 * 
 * Implements:
 * - Issue #78: DATA-02 Autonomous Multi-Page Pagination Crawler
 */

import { WebContents } from 'electron';

export interface PaginationAction {
  type: 'click' | 'navigate' | 'done';
  selector?: string;
  nextUrl?: string;
  pageNumber: number;
}

export class PaginationCrawler {
  /**
   * Browser script to detect the most probable 'Next' button or pagination link.
   */
  public static readonly DETECT_NEXT_SCRIPT = `
    (() => {
      // 1. Check rel="next"
      const relNext = document.querySelector('link[rel="next"], a[rel="next"]');
      if (relNext && relNext.href) {
        return { type: 'navigate', nextUrl: relNext.href };
      }

      // 2. Search clickable elements for 'Next' patterns
      const candidates = document.querySelectorAll('a, button, [role="button"]');
      const nextPatterns = [/^next$/i, /^next\\s*[>»→]$/i, /^[>»→]\\s*next/i, /^older$/i, /^more$/i, /^load\\s*more$/i];

      for (const el of candidates) {
        // Skip invisible elements
        if (el.offsetParent === null) continue;
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim();

        for (const pat of nextPatterns) {
          if (pat.test(text)) {
            // Assign temporary agent selector if needed
            if (!el.id) el.id = 'aegis_pagination_next_' + Date.now();
            return {
              type: el.tagName.toLowerCase() === 'a' && el.href ? 'navigate' : 'click',
              selector: '#' + el.id,
              nextUrl: el.href || undefined
            };
          }
        }
      }

      // 3. Fallback: check numerical pagination (e.g. active is '1', find '2')
      const activePage = document.querySelector('.active, [aria-current="page"]');
      if (activePage) {
        const num = parseInt(activePage.innerText.trim(), 10);
        if (!isNaN(num)) {
          const nextNum = num + 1;
          for (const el of candidates) {
            if (el.innerText.trim() === String(nextNum)) {
              if (!el.id) el.id = 'aegis_pagination_next_' + Date.now();
              return {
                type: el.tagName.toLowerCase() === 'a' && el.href ? 'navigate' : 'click',
                selector: '#' + el.id,
                nextUrl: el.href || undefined
              };
            }
          }
        }
      }

      return { type: 'done' };
    })();
  `;

  /**
   * Checks if URL has an incrementable page parameter.
   */
  public static incrementUrlPage(currentUrl: string): string | null {
    try {
      const u = new URL(currentUrl);
      const pageKeys = ['page', 'p', 'pg', 'paged', 'offset', 'start'];

      for (const key of pageKeys) {
        const val = u.searchParams.get(key);
        if (val !== null) {
          const num = parseInt(val, 10);
          if (!isNaN(num)) {
            const step = ['offset', 'start'].includes(key) ? 10 : 1;
            u.searchParams.set(key, String(num + step));
            return u.toString();
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Discovers the next pagination action on the page.
   */
  public static async findNextPage(
    webContents: WebContents,
    currentPageNumber: number
  ): Promise<PaginationAction> {
    if (webContents.isDestroyed()) {
      return { type: 'done', pageNumber: currentPageNumber };
    }

    try {
      const result = await webContents.executeJavaScript(PaginationCrawler.DETECT_NEXT_SCRIPT);
      if (result.type !== 'done') {
        return {
          type: result.type,
          selector: result.selector,
          nextUrl: result.nextUrl,
          pageNumber: currentPageNumber + 1
        };
      }

      // Try URL parameter increment
      const urlInc = PaginationCrawler.incrementUrlPage(webContents.getURL());
      if (urlInc) {
        return {
          type: 'navigate',
          nextUrl: urlInc,
          pageNumber: currentPageNumber + 1
        };
      }

      return { type: 'done', pageNumber: currentPageNumber };
    } catch {
      return { type: 'done', pageNumber: currentPageNumber };
    }
  }
}
