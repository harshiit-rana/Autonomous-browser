/**
 * Mission history (reads the persisted SQLite mission/event log through IPC) and the Settings
 * "Export data" / "Import data" actions. Issue #239.
 *
 * All text is inserted with textContent (event payloads originate from web pages and models: untrusted).
 */

import type { MissionHistoryItem, MissionEventItem, DataTransferResult } from '../ipc/contract.js';

interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

const EVENT_PAGE = 500;
const MAX_EVENTS_RENDERED = 5000;

function clean(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001F\u007F-\u009F‎‏‪-‮]/g, ' ').trim();
}

function describeEvent(e: MissionEventItem): string {
  const d: any = e.data;
  if (e.kind === 'evidence') return clean(d?.text);
  if (e.kind === 'status') return `${clean(d?.status)}: ${clean(d?.message)}`;
  if (e.kind === 'worker') return `${clean(d?.name || d?.id)} - ${clean(d?.task)} (${clean(d?.status)}, ${clean(d?.progress)}%)`;
  if (e.kind === 'telemetry') return `tokens ${clean(d?.tokensTotal)}, cost $${clean(d?.costTotal)}`;
  return clean(JSON.stringify(d));
}

export class HistoryPanel {
  private readonly modal = document.getElementById('history-modal');
  private readonly list = document.getElementById('history-mission-list');
  private readonly events = document.getElementById('history-event-list');
  private readonly title = document.getElementById('history-events-title');
  private readonly status = document.getElementById('history-status-msg');
  private selectedMissionId: string | null = null;

  constructor() {
    document.getElementById('history-btn')?.addEventListener('click', () => void this.open());
    document.getElementById('close-history-btn')?.addEventListener('click', () => this.close());
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.close();
    });
    document.getElementById('export-data-btn')?.addEventListener('click', () => void this.transfer('export'));
    document.getElementById('import-data-btn')?.addEventListener('click', () => void this.transfer('import'));
  }

  private get aegis(): any {
    return (window as any).aegis;
  }

  public async open(): Promise<void> {
    if (!this.modal) return;
    this.aegis?.setOverlayActive?.(true); // keep the native page view from covering the modal
    this.modal.classList.remove('hidden');
    await this.refresh();
  }

  public close(): void {
    if (!this.modal || this.modal.classList.contains('hidden')) return;
    this.modal.classList.add('hidden');
    this.aegis?.setOverlayActive?.(false);
  }

  private setStatus(text: string, isError = false): void {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
  }

  public async refresh(): Promise<void> {
    if (!this.list || !this.aegis?.listMissions) return;
    const res = (await this.aegis.listMissions(100)) as IpcResult<MissionHistoryItem[]>;
    this.list.replaceChildren();
    if (!res?.ok || !res.data) {
      this.setStatus(`Could not load history: ${res?.error ?? 'unknown error'}`, true);
      return;
    }
    this.setStatus(res.data.length ? `${res.data.length} mission(s)` : 'No missions recorded yet.');
    for (const m of res.data) {
      const row = document.createElement('button');
      row.className = 'history-mission';
      row.dataset.missionId = m.id;
      row.dataset.state = m.state;
      const prompt = document.createElement('span');
      prompt.className = 'history-mission-prompt';
      prompt.textContent = clean(m.prompt).slice(0, 120);
      const meta = document.createElement('span');
      meta.className = 'history-mission-meta';
      meta.textContent = `${m.state} - ${new Date(m.createdAt).toLocaleString()} - ${m.stepCount} step(s)`;
      row.append(prompt, meta);
      row.addEventListener('click', () => void this.showMission(m));
      this.list.appendChild(row);
    }
  }

  private async showMission(m: MissionHistoryItem): Promise<void> {
    if (!this.events || !this.aegis?.getMissionEvents) return;
    this.selectedMissionId = m.id;
    this.list?.querySelectorAll('.history-mission').forEach(el => el.classList.toggle('selected', (el as HTMLElement).dataset.missionId === m.id));
    this.events.replaceChildren();
    if (this.title) this.title.textContent = `Events - ${clean(m.prompt).slice(0, 80)}`;

    let after = 0;
    let total = 0;
    let rendered = 0;
    for (;;) {
      const res = (await this.aegis.getMissionEvents(m.id, after, EVENT_PAGE)) as IpcResult<{ events: MissionEventItem[]; nextAfterSeq: number | null; total: number }>;
      if (this.selectedMissionId !== m.id) return; // user picked another mission meanwhile
      if (!res?.ok || !res.data) {
        this.setStatus(`Could not load events: ${res?.error ?? 'unknown error'}`, true);
        return;
      }
      total = res.data.total;
      for (const e of res.data.events) {
        const li = document.createElement('li');
        li.className = `history-event kind-${clean(e.kind).replace(/[^a-z0-9_-]/gi, '')}`;
        li.dataset.seq = String(e.seq);
        const seq = document.createElement('span');
        seq.className = 'history-event-seq';
        seq.textContent = `#${e.seq}`;
        const kind = document.createElement('span');
        kind.className = 'history-event-kind';
        kind.textContent = e.kind;
        const text = document.createElement('span');
        text.className = 'history-event-text';
        text.textContent = describeEvent(e);
        li.append(seq, kind, text);
        this.events.appendChild(li);
        rendered++;
      }
      if (res.data.nextAfterSeq === null || rendered >= MAX_EVENTS_RENDERED) break;
      after = res.data.nextAfterSeq;
    }
    this.setStatus(`${rendered} of ${total} event(s) shown for ${m.id}`);
  }

  private async transfer(kind: 'export' | 'import'): Promise<void> {
    const out = document.getElementById('settings-status-msg');
    const show = (text: string, isError: boolean): void => {
      if (!out) return;
      out.textContent = text;
      out.style.color = isError ? 'var(--danger)' : 'var(--text-muted)';
      out.style.display = 'block';
    };
    const fn = kind === 'export' ? this.aegis?.exportData : this.aegis?.importData;
    if (!fn) return;
    show(kind === 'export' ? 'Exporting...' : 'Waiting for import...', false);
    const res = (await fn()) as IpcResult<DataTransferResult>;
    if (!res?.ok) show(`${kind === 'export' ? 'Export' : 'Import'} failed: ${res?.error ?? 'unknown error'}`, true);
    else show(res.data?.message ?? 'Done', false);
  }
}
