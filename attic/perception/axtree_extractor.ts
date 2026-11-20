/**
 * Project Aegis - Accessibility Tree (AXTree) Extractor & Semantic Pruner
 * 
 * Implements:
 * - Issue #26: PERC-01 Accessibility Tree (AXTree) Extraction & Semantic Pruning
 */

export interface AXNode {
  nodeId: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  bounds?: { x: number; y: number; w: number; h: number };
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  checked?: boolean | 'mixed';
  children?: AXNode[];
}

export interface PrunedAXTree {
  root: AXNode;
  interactiveCount: number;
  semanticText: string;
}

export class AXTreeExtractor {
  // Roles considered high semantic value for browser agent reasoning
  private static readonly INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'tab',
    'menuitem',
    'option',
    'spinbutton'
  ]);

  private static readonly CONTENT_ROLES = new Set([
    'heading',
    'paragraph',
    'article',
    'region',
    'banner',
    'navigation',
    'main',
    'complementary',
    'contentinfo',
    'dialog',
    'alert',
    'status',
    'cell',
    'columnheader',
    'rowheader'
  ]);

  private static readonly PRUNED_ROLES = new Set([
    'none',
    'generic',
    'ignored',
    'InlineTextBox',
    'LineBreak'
  ]);

  /**
   * In-browser evaluation script to extract clean accessibility & semantic hierarchy
   * directly from the DOM using ARIA reflection and element semantics.
   */
  public static readonly DOM_AX_EXTRACTOR_SCRIPT = `
    (() => {
      let idCounter = 1;

      function extractAXNode(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;

        // Skip hidden elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return null;
        }

        const rect = el.getBoundingClientRect();
        // Skip zero-size invisible layout wrappers
        if (rect.width === 0 && rect.height === 0) {
          return null;
        }

        const tag = el.tagName.toLowerCase();
        let role = el.getAttribute('role');

        if (!role) {
          switch (tag) {
            case 'a': role = el.hasAttribute('href') ? 'link' : 'generic'; break;
            case 'button': role = 'button'; break;
            case 'input': {
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              if (['button', 'submit', 'reset'].includes(type)) role = 'button';
              else if (type === 'checkbox') role = 'checkbox';
              else if (type === 'radio') role = 'radio';
              else if (type === 'search') role = 'searchbox';
              else role = 'textbox';
              break;
            }
            case 'textarea': role = 'textbox'; break;
            case 'select': role = 'combobox'; break;
            case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': role = 'heading'; break;
            case 'nav': role = 'navigation'; break;
            case 'main': role = 'main'; break;
            case 'header': role = 'banner'; break;
            case 'footer': role = 'contentinfo'; break;
            case 'dialog': role = 'dialog'; break;
            default: role = 'generic';
          }
        }

        let name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
        if (!name && ['input', 'textarea'].includes(tag)) {
          name = el.getAttribute('placeholder') || '';
        }
        if (!name && el.innerText) {
          // Only take direct text if not generic container
          name = el.innerText.trim().slice(0, 150);
        }

        const node = {
          nodeId: 'ax_' + (idCounter++),
          role: role,
          name: name ? name.replace(/\\s+/g, ' ') : undefined,
          value: el.value !== undefined ? String(el.value) : undefined,
          bounds: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          },
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          expanded: el.getAttribute('aria-expanded') === 'true',
          checked: el.checked || (el.getAttribute('aria-checked') === 'true'),
          children: []
        };

        for (const child of el.children) {
          const childNode = extractAXNode(child);
          if (childNode) {
            node.children.push(childNode);
          }
        }

        return node;
      }

      return extractAXNode(document.body || document.documentElement);
    })();
  `;

  /**
   * Prunes an AXTree node recursively, eliminating uninformative generic wrappers
   * while hoisting meaningful children up the hierarchy.
   */
  public static pruneTree(rawNode: AXNode): PrunedAXTree {
    let interactiveCount = 0;

    function pruneRecursive(node: AXNode): AXNode | null {
      const isPrunedRole = AXTreeExtractor.PRUNED_ROLES.has(node.role);
      const isInteractive = AXTreeExtractor.INTERACTIVE_ROLES.has(node.role);
      const isContent = AXTreeExtractor.CONTENT_ROLES.has(node.role);

      if (isInteractive) {
        interactiveCount++;
      }

      // Recursively prune children
      const prunedChildren: AXNode[] = [];
      if (node.children) {
        for (const child of node.children) {
          const pruned = pruneRecursive(child);
          if (pruned) {
            prunedChildren.push(pruned);
          }
        }
      }

      // If generic/unimportant and has no name and single child, hoist child
      if (isPrunedRole && !node.name && prunedChildren.length === 1) {
        return prunedChildren[0];
      }

      // If generic with no name and no children, discard
      if (isPrunedRole && !node.name && prunedChildren.length === 0) {
        return null;
      }

      return {
        ...node,
        children: prunedChildren.length > 0 ? prunedChildren : undefined
      };
    }

    const prunedRoot = pruneRecursive(rawNode) || {
      nodeId: 'ax_root',
      role: 'generic',
      children: []
    };

    const semanticText = AXTreeExtractor.toIndentedText(prunedRoot);

    return {
      root: prunedRoot,
      interactiveCount,
      semanticText
    };
  }

  /**
   * Formats the pruned tree into an indented semantic string optimized for LLM prompting.
   */
  public static toIndentedText(node: AXNode, depth = 0): string {
    const indent = '  '.repeat(depth);
    let line = `${indent}[${node.role}]`;

    if (node.name) {
      line += ` "${node.name}"`;
    }
    if (node.value) {
      line += ` value="${node.value}"`;
    }
    if (node.disabled) {
      line += ' (disabled)';
    }
    if (node.checked) {
      line += ' (checked)';
    }
    if (node.expanded) {
      line += ' (expanded)';
    }

    const lines = [line];
    if (node.children) {
      for (const child of node.children) {
        lines.push(AXTreeExtractor.toIndentedText(child, depth + 1));
      }
    }

    return lines.join('\n');
  }
}
