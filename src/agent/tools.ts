import { ToolDefinition } from '../models/types.js';
import { TabView } from '../main/view_manager.js';
import { PageSnapshot } from './perception.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('tools');

export const BROWSER_TOOLS: ToolDefinition[] = [
  {
    name: 'navigate',
    description: 'Navigate the browser to a destination URL',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to navigate to (e.g. https://example.com)'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'click',
    description: 'Click on an interactive element referenced by its opaque ref from the snapshot (e.g. "e1", "e2")',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The opaque element ref from the page snapshot (e.g. "e1")'
        },
        button: {
          type: 'string',
          enum: ['left', 'right'],
          description: 'Mouse button to click with'
        }
      },
      required: ['ref']
    }
  },
  {
    name: 'type',
    description: 'Type text into an input or textarea element referenced by its ref',
    parameters: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The opaque element ref to type into (e.g. "e2")'
        },
        text: {
          type: 'string',
          description: 'The text string to type'
        },
        clear: {
          type: 'boolean',
          description: 'Whether to clear existing text in the input before typing'
        },
        pressEnter: {
          type: 'boolean',
          description: 'Whether to press Enter after typing'
        }
      },
      required: ['ref', 'text']
    }
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key (e.g. "Enter", "Escape", "Tab", "ArrowDown")',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The key name to press'
        }
      },
      required: ['key']
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the active page up or down',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'Direction to scroll'
        },
        amount: {
          type: 'number',
          description: 'Amount in pixels to scroll (defaults to 350)'
        }
      },
      required: ['direction']
    }
  },
  {
    name: 'wait',
    description: 'Wait for dynamic content or animations to settle',
    parameters: {
      type: 'object',
      properties: {
        ms: {
          type: 'number',
          description: 'Duration in milliseconds to wait (max 5000)'
        }
      }
    }
  },
  {
    name: 'done',
    description: 'Signal that the user mission has been successfully completed and report final findings',
    parameters: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'The complete final answer or summary of results'
        },
        evidence: {
          type: 'array',
          description: 'List of specific facts or items extracted from the page',
          items: { type: 'string' }
        }
      },
      required: ['result']
    }
  },
  {
    name: 'fail',
    description: 'Report that the mission cannot be accomplished due to an insurmountable roadblock',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Explanation of why the goal could not be completed'
        }
      },
      required: ['reason']
    }
  }
];

export interface ToolExecutionContext {
  tab: TabView;
  snapshot: PageSnapshot;
}

export interface ToolExecutionResult {
  ok: boolean;
  effect?: Record<string, any>;
  output: string;
  error?: string;
  isTerminal?: boolean;
  isDone?: boolean;
}

export class ToolExecutor {
  public static async execute(
    name: string,
    args: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    logger.info('Executing tool', { name, args });
    const { tab, snapshot } = context;

    try {
      switch (name) {
        case 'navigate': {
          let url = String(args.url || '').trim();
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
          }
          await tab.view.webContents.loadURL(url);
          return {
            ok: true,
            effect: { navigated: url },
            output: `Navigated to ${url}`
          };
        }

        case 'click': {
          const ref = String(args.ref || '');
          const el = snapshot.elements.get(ref);
          if (!el) {
            return {
              ok: false,
              output: `Element ${ref} not found in current snapshot. Please re-examine the page snapshot.`,
              error: 'stale_ref'
            };
          }

          // Calculate center coordinates
          const targetX = Math.round(el.bounds.x + el.bounds.width / 2);
          const targetY = Math.round(el.bounds.y + el.bounds.height / 2);

          // Physical cursor movement simulation
          try {
            await tab.executor.moveMouseTo(targetX, targetY, `Agent: Click ${el.name || ref}`);
            await tab.view.webContents.executeJavaScript(`
              if (window.__triggerAgentClick) {
                window.__triggerAgentClick(${targetX}, ${targetY});
              }
            `).catch(() => {});
          } catch {}

          // Perform click dispatch
          await tab.view.webContents.sendInputEvent({
            type: 'mouseDown',
            x: targetX,
            y: targetY,
            button: args.button === 'right' ? 'right' : 'left',
            clickCount: 1
          });
          await new Promise(r => setTimeout(r, 60));
          await tab.view.webContents.sendInputEvent({
            type: 'mouseUp',
            x: targetX,
            y: targetY,
            button: args.button === 'right' ? 'right' : 'left',
            clickCount: 1
          });

          return {
            ok: true,
            effect: { clicked: ref, coords: { x: targetX, y: targetY } },
            output: `Clicked element [${ref}] "${el.name}"`
          };
        }

        case 'type': {
          const ref = String(args.ref || '');
          const el = snapshot.elements.get(ref);
          if (!el) {
            return {
              ok: false,
              output: `Element ${ref} not found in current snapshot.`,
              error: 'stale_ref'
            };
          }

          const targetX = Math.round(el.bounds.x + el.bounds.width / 2);
          const targetY = Math.round(el.bounds.y + el.bounds.height / 2);

          // Focus the input
          await tab.view.webContents.sendInputEvent({
            type: 'mouseDown',
            x: targetX,
            y: targetY,
            button: 'left',
            clickCount: 1
          });
          await tab.view.webContents.sendInputEvent({
            type: 'mouseUp',
            x: targetX,
            y: targetY,
            button: 'left',
            clickCount: 1
          });

          const text = String(args.text || '');

          if (args.clear) {
            // Select all and delete
            await tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
            await tab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
            await tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
            await tab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
          }

          // Type characters
          for (const char of text) {
            await tab.view.webContents.sendInputEvent({ type: 'char', keyCode: char });
            await new Promise(r => setTimeout(r, 15));
          }

          if (args.pressEnter) {
            await tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            await tab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          }

          return {
            ok: true,
            effect: { typed: text, ref },
            output: `Typed "${text}" into element [${ref}]`
          };
        }

        case 'press_key': {
          const key = String(args.key || 'Enter');
          await tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
          await new Promise(r => setTimeout(r, 40));
          await tab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
          return {
            ok: true,
            output: `Pressed key: ${key}`
          };
        }

        case 'scroll': {
          const dir = args.direction === 'up' ? -1 : 1;
          const px = Number(args.amount) || 350;
          await tab.view.webContents.executeJavaScript(`window.scrollBy({ top: ${dir * px}, behavior: 'smooth' });`);
          return {
            ok: true,
            output: `Scrolled ${args.direction} by ${px}px`
          };
        }

        case 'wait': {
          const duration = Math.min(Math.max(Number(args.ms) || 1000, 100), 5000);
          await new Promise(r => setTimeout(r, duration));
          return {
            ok: true,
            output: `Waited for ${duration}ms`
          };
        }

        case 'done': {
          return {
            ok: true,
            output: String(args.result || 'Mission complete'),
            isTerminal: true,
            isDone: true,
            effect: { evidence: args.evidence || [] }
          };
        }

        case 'fail': {
          return {
            ok: false,
            output: String(args.reason || 'Mission failed'),
            error: String(args.reason || 'Failed'),
            isTerminal: true,
            isDone: false
          };
        }

        default:
          return {
            ok: false,
            output: `Unknown tool "${name}"`,
            error: 'unknown_tool'
          };
      }
    } catch (err: any) {
      logger.error('Tool execution error', err);
      return {
        ok: false,
        output: `Error executing tool ${name}: ${err.message}`,
        error: err.message
      };
    }
  }
}
