import { WebContents } from 'electron';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('perception');

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiscoveredElement {
  ref: string;
  tagName: string;
  role?: string;
  type?: string;
  name: string;
  value?: string;
  bounds: BoundingBox;
  isClickable: boolean;
  isTextInput: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: Map<string, DiscoveredElement>;
  formattedTree: string;
  screenshotBase64?: string;
}

const EXTRACTOR_SCRIPT = `
(() => {
  const elements = [];
  const interactiveSelectors = [
    'button',
    'input',
    'select',
    'textarea',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ];

  const candidateNodes = Array.from(document.querySelectorAll(interactiveSelectors.join(',')));

  let counter = 1;
  for (const el of candidateNodes) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      rect.width === 0 ||
      rect.height === 0
    ) {
      continue;
    }

    // Determine accessible text label
    let text = el.getAttribute('aria-label') ||
               el.getAttribute('title') ||
               el.getAttribute('placeholder') ||
               el.innerText ||
               el.textContent ||
               el.getAttribute('value') ||
               '';

    text = text.replace(/\\s+/g, ' ').trim().slice(0, 100);

    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || undefined;
    const type = el.getAttribute('type') || undefined;
    const isTextInput = tagName === 'textarea' || (tagName === 'input' && (!type || ['text', 'search', 'email', 'password', 'url', 'number'].includes(type)));
    const isClickable = !isTextInput;

    elements.push({
      ref: 'e' + counter++,
      tagName,
      role,
      type,
      name: text,
      value: (isTextInput && 'value' in el) ? String(el.value).slice(0, 50) : undefined,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      isClickable,
      isTextInput
    });

    if (counter > 150) break; // Limit elements for token economy
  }

  return {
    url: window.location.href,
    title: document.title,
    elements
  };
})()
`;

export class PerceptionEngine {
  public static async captureSnapshot(webContents: WebContents, captureScreenshot: boolean = false): Promise<PageSnapshot> {
    try {
      if (webContents.isDestroyed()) {
        throw new Error('WebContents is destroyed');
      }

      const rawResult = await webContents.executeJavaScript(EXTRACTOR_SCRIPT) as {
        url: string;
        title: string;
        elements: DiscoveredElement[];
      };

      const elementMap = new Map<string, DiscoveredElement>();
      const treeLines: string[] = [];

      for (const el of rawResult.elements) {
        elementMap.set(el.ref, el);

        const label = el.name ? `"${el.name}"` : '';
        const tag = el.type ? `${el.tagName}[type="${el.type}"]` : el.tagName;
        const val = el.value ? `(value="${el.value}")` : '';
        treeLines.push(`[${el.ref}] ${tag} ${label} ${val}`.trim());
      }

      let screenshotBase64: string | undefined;
      if (captureScreenshot) {
        try {
          const image = await webContents.capturePage();
          screenshotBase64 = image.toJPEG(75).toString('base64');
        } catch (err: any) {
          logger.warn('Screenshot capture failed', { error: err.message });
        }
      }

      const formattedTree = treeLines.length > 0
        ? treeLines.join('\n')
        : '(No interactive elements found on page)';

      return {
        url: rawResult.url || webContents.getURL(),
        title: rawResult.title || webContents.getTitle(),
        elements: elementMap,
        formattedTree,
        screenshotBase64
      };
    } catch (err: any) {
      logger.error('Failed to capture page snapshot', err);
      return {
        url: webContents.getURL() || '',
        title: webContents.getTitle() || '',
        elements: new Map(),
        formattedTree: `(Error taking page snapshot: ${err.message})`
      };
    }
  }
}
