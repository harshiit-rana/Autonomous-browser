/**
 * Project Aegis - Persistent Autonomous Task Scheduler & Webhook Listeners
 * 
 * Implements:
 * - Issue #85: AUTO-01 Persistent Autonomous Task Scheduler (Cron & Event Triggers)
 * - Issue #86: AUTO-02 Trigger-Based Autonomous Agents (Webhook & Event Listeners)
 */

import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ScheduledTask {
  id: string;
  name: string;
  goal: string;
  cronExpression?: string;
  intervalMs?: number;
  webhookPath?: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  createdAt: number;
}

export class TaskScheduler extends EventEmitter {
  private tasks: Map<string, ScheduledTask> = new Map();
  private storagePath: string;
  private timer: NodeJS.Timeout | null = null;
  private webhookServer: http.Server | null = null;
  private webhookPort: number;

  constructor(storagePath?: string, webhookPort = 9876) {
    super();
    this.storagePath = storagePath || path.join(process.cwd(), '.scheduled_tasks.json');
    this.webhookPort = webhookPort;
    this.loadTasks();
  }

  public registerTask(task: Omit<ScheduledTask, 'runCount' | 'createdAt'>): ScheduledTask {
    const fullTask: ScheduledTask = {
      ...task,
      runCount: 0,
      createdAt: Date.now(),
      nextRun: this.calculateNextRun(task.intervalMs)
    };
    this.tasks.set(task.id, fullTask);
    this.saveTasks();
    return fullTask;
  }

  public unregisterTask(id: string): boolean {
    const deleted = this.tasks.delete(id);
    if (deleted) this.saveTasks();
    return deleted;
  }

  public start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.checkScheduledTasks(), 5000);
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
  }

  /**
   * Starts local HTTP server for webhook triggers.
   */
  public startWebhookListener(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.webhookServer = http.createServer((req, res) => {
        const url = req.url || '';
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          let payload: any = {};
          try { payload = JSON.parse(body || '{}'); } catch {}

          // Match task by webhook path
          const matchedTask = Array.from(this.tasks.values()).find(t => t.webhookPath && url.startsWith(t.webhookPath));

          if (matchedTask && matchedTask.enabled) {
            matchedTask.runCount++;
            matchedTask.lastRun = Date.now();
            this.emit('task_triggered', { task: matchedTask, trigger: 'webhook', payload });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'triggered', taskId: matchedTask.id }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No matching webhook task found' }));
          }
        });
      });

      this.webhookServer.listen(this.webhookPort, () => {
        resolve(this.webhookPort);
      });

      this.webhookServer.on('error', (err) => reject(err));
    });
  }

  public listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  private checkScheduledTasks(): void {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (task.nextRun && now >= task.nextRun) {
        task.runCount++;
        task.lastRun = now;
        task.nextRun = this.calculateNextRun(task.intervalMs);
        this.saveTasks();
        this.emit('task_triggered', { task, trigger: 'interval' });
      }
    }
  }

  private calculateNextRun(intervalMs?: number): number | undefined {
    if (!intervalMs || intervalMs <= 0) return undefined;
    return Date.now() + intervalMs;
  }

  private loadTasks(): void {
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const list: ScheduledTask[] = JSON.parse(raw);
        for (const t of list) {
          this.tasks.set(t.id, t);
        }
      } catch {}
    }
  }

  private saveTasks(): void {
    try {
      fs.writeFileSync(this.storagePath, JSON.stringify(Array.from(this.tasks.values()), null, 2), 'utf8');
    } catch {}
  }
}
