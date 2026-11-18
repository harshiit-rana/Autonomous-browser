/**
 * Project Aegis - Mission Conversation Threads & Branching
 * Implements: Issue #210 [WKS-05] Multi-turn threads, follow-ups, forking/branching,
 * history search, and markdown export.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppPaths } from '../infrastructure/paths.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('conversation-threads');

export interface ThreadMissionItem {
  missionId: string;
  prompt: string;
  result?: string;
  status: string;
  timestamp: string;
}

export interface ConversationThread {
  id: string;
  title: string;
  parentThreadId?: string;
  missions: ThreadMissionItem[];
  createdAt: string;
  updatedAt: string;
}

export class ThreadManager {
  private static instance: ThreadManager | null = null;
  private threadsDir: string | null = null;
  private inMemoryThreads: Map<string, ConversationThread> = new Map();

  private constructor() {
    try {
      const paths = getAppPaths();
      this.threadsDir = path.join(paths.userData, 'threads');
      if (!fs.existsSync(this.threadsDir)) {
        fs.mkdirSync(this.threadsDir, { recursive: true });
      }
    } catch {
      this.threadsDir = null;
    }
  }

  public static getInstance(): ThreadManager {
    if (!ThreadManager.instance) {
      ThreadManager.instance = new ThreadManager();
    }
    return ThreadManager.instance;
  }

  public createThread(title: string, parentThreadId?: string): ConversationThread {
    const thread: ConversationThread = {
      id: `th_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      title,
      parentThreadId,
      missions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.inMemoryThreads.set(thread.id, thread);
    this.saveThread(thread);
    logger.info('Conversation thread created', { id: thread.id, title });
    return thread;
  }

  public forkThread(sourceThreadId: string, title?: string): ConversationThread | undefined {
    const source = this.getThread(sourceThreadId);
    if (!source) return undefined;

    const forked = this.createThread(title || `Fork of ${source.title}`, source.id);
    // Clone history items
    forked.missions = [...source.missions];
    this.saveThread(forked);
    logger.info('Forked conversation thread', { from: source.id, to: forked.id });
    return forked;
  }

  public addMissionToThread(threadId: string, item: ThreadMissionItem): void {
    const thread = this.getThread(threadId);
    if (!thread) return;

    thread.missions.push(item);
    thread.updatedAt = new Date().toISOString();
    this.saveThread(thread);
  }

  public getThread(id: string): ConversationThread | undefined {
    if (this.inMemoryThreads.has(id)) {
      return this.inMemoryThreads.get(id);
    }

    if (this.threadsDir) {
      const filePath = path.join(this.threadsDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const thread = JSON.parse(raw);
          this.inMemoryThreads.set(id, thread);
          return thread;
        } catch {}
      }
    }

    return undefined;
  }

  public listThreads(query?: string): ConversationThread[] {
    if (this.threadsDir && fs.existsSync(this.threadsDir)) {
      try {
        const files = fs.readdirSync(this.threadsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const id = file.replace('.json', '');
          if (!this.inMemoryThreads.has(id)) {
            const raw = fs.readFileSync(path.join(this.threadsDir, file), 'utf-8');
            this.inMemoryThreads.set(id, JSON.parse(raw));
          }
        }
      } catch {}
    }

    let list = Array.from(this.inMemoryThreads.values());
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(t => t.title.toLowerCase().includes(q) || t.missions.some(m => m.prompt.toLowerCase().includes(q)));
    }

    return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  public exportThreadMarkdown(threadId: string): string {
    const thread = this.getThread(threadId);
    if (!thread) return '';

    const lines: string[] = [
      `# Conversation Thread: ${thread.title}`,
      `**Thread ID:** \`${thread.id}\``,
      `**Created:** ${thread.createdAt}`,
      `**Updated:** ${thread.updatedAt}`,
      thread.parentThreadId ? `**Forked From:** \`${thread.parentThreadId}\`` : '',
      `\n---\n`
    ];

    for (let i = 0; i < thread.missions.length; i++) {
      const m = thread.missions[i];
      lines.push(`## Turn ${i + 1}: ${m.prompt}`);
      lines.push(`- **Status:** ${m.status}`);
      lines.push(`- **Timestamp:** ${m.timestamp}`);
      lines.push(`\n### Result\n${m.result || 'No deliverable recorded.'}\n`);
    }

    return lines.filter(Boolean).join('\n');
  }

  private saveThread(thread: ConversationThread): void {
    if (!this.threadsDir) return;
    try {
      const filePath = path.join(this.threadsDir, `${thread.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(thread, null, 2), 'utf-8');
    } catch {}
  }
}
