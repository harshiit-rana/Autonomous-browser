/**
 * Semantic DOM Tree Indexer
 * Reverse-engineered from Strawberry's `RT` script and extended with:
 * - Persistent `data-agent-id` attribute assignment
 * - Shadow DOM open root deep traversal
 * - Accessible name computation (ARIA label, placeholder, title, innerText)
 * - Exact bounding box calculation relative to active viewport
 */

export interface IndexedElement {
  id: string;
  tag: string;
  role?: string;
  type?: string;
  label?: string;
  href?: string;
  bounds: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  isContentEditable: boolean;
}

export interface PageDOMState {
  title: string;
  url: string;
  elementCount: number;
  elements: IndexedElement[];
}

export const DOM_INDEXER_SCRIPT = `
(() => {
  const TAG_ATTR = 'data-agent-id';
  let counter = 1;

  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) return true;
    if (['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'combobox'].includes(role)) return true;
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
    return false;
  }

  function cleanText(str, maxLen = 80) {
    if (!str) return '';
    const clean = String(str).replace(/\\s+/g, ' ').trim();
    return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
  }

  const elements = [];

  function traverse(root) {
    const nodes = root.querySelectorAll('*');
    nodes.forEach(node => {
      if (!isVisible(node)) return;

      if (isInteractive(node)) {
        let agentId = node.getAttribute(TAG_ATTR);
        if (!agentId) {
          agentId = 'el_' + counter++;
          node.setAttribute(TAG_ATTR, agentId);
        }

        const rect = node.getBoundingClientRect();
        const label = cleanText(
          node.getAttribute('aria-label') ||
          node.getAttribute('placeholder') ||
          node.getAttribute('title') ||
          node.innerText ||
          node.textContent ||
          node.value
        );

        elements.push({
          id: agentId,
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute('role') || undefined,
          type: node.getAttribute('type') || undefined,
          label: label || undefined,
          href: node.getAttribute('href') || undefined,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          },
          isContentEditable: node.isContentEditable || node.getAttribute('contenteditable') === 'true'
        });
      }

      // Traverse open shadow roots
      if (node.shadowRoot) {
        traverse(node.shadowRoot);
      }
    });
  }

  traverse(document);

  return {
    title: document.title,
    url: window.location.href,
    elementCount: elements.length,
    elements
  };
})()
`;
