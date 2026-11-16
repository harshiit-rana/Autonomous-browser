import { WebContents } from 'electron';
import { ActionExecutor } from '../core/action_executor.js';
import { PageDOMState } from '../core/dom_indexer.js';

export interface WorkerState {
  workerId: string;
  url: string;
  title: string;
  status: 'idle' | 'navigating' | 'indexing' | 'executing' | 'error';
  lastError?: string;
  domState?: PageDOMState;
}

/**
 * SwarmWorker
 * An autonomous agent worker controlling an isolated background tab.
 */
export class SwarmWorker {
  public readonly workerId: string;
  public readonly webContents: WebContents;
  public readonly executor: ActionExecutor;
  public status: 'idle' | 'navigating' | 'indexing' | 'executing' | 'error' = 'idle';

  constructor(workerId: string, webContents: WebContents) {
    this.workerId = workerId;
    this.webContents = webContents;
    this.executor = new ActionExecutor(webContents);
  }

  public async navigate(url: string): Promise<PageDOMState> {
    this.status = 'navigating';
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
      url = 'https://' + url;
    }

    await this.webContents.loadURL(url);
    await this.waitForSettle();
    
    this.status = 'indexing';
    const domState = await this.executor.getDOMState();
    this.status = 'idle';
    return domState;
  }

  public async click(agentId: string): Promise<{ success: boolean; mode: string }> {
    this.status = 'executing';
    try {
      const res = await this.executor.clickElement(agentId);
      await this.waitForSettle();
      this.status = 'idle';
      return res;
    } catch (err: any) {
      this.status = 'error';
      throw err;
    }
  }

  public async type(agentId: string, text: string): Promise<void> {
    this.status = 'executing';
    try {
      await this.executor.typeText(agentId, text);
      this.status = 'idle';
    } catch (err: any) {
      this.status = 'error';
      throw err;
    }
  }

  public async getSnapshot(): Promise<WorkerState> {
    let domState: PageDOMState | undefined;
    try {
      domState = await this.executor.getDOMState();
    } catch {}

    return {
      workerId: this.workerId,
      url: this.webContents.getURL(),
      title: this.webContents.getTitle(),
      status: this.status,
      domState
    };
  }

  private async waitForSettle(timeoutMs: number = 800): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, timeoutMs));
  }
}
