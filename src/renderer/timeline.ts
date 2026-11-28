/**
 * Project Aegis - Virtualised Mission Timeline & Inspector Drawer (#235 [LIV-04])
 *
 * Pure idempotent event reducer (`TimelineStore`) + virtualised DOM renderer (`MissionTimeline`):
 * - Idempotent keyed by `seq`; supports out-of-order / duplicate delivery & `since(seq)` resync
 * - Collapses consecutive scroll calls per worker
 * - Virtualises 10,000+ rows with fixed row height + overscan
 * - Filters: category (all/actions/thoughts/evidence/approvals/errors), worker chip, search, pin
 * - Accessible `role="log"`, keyboard Up/Down/Enter navigation, and 1/2s rate-limited polite live region
 * - Inspector drawer for raw tool call JSON, redacted metadata, snapshot excerpt & policy trace
 */
import type { MissionEvent } from '../ipc/contract.js';

export type TimelineFilter = 'all' | 'actions' | 'thoughts' | 'evidence' | 'approvals' | 'errors';

const OKABE_ITO_WORKERS = ['#56B4E9', '#E69F00', '#009E73', '#CC79A7', '#0072B2', '#D55E00', '#F0E442', '#94A3B8'];
export const LIVE_REGION_MIN_INTERVAL_MS = 2000;
const ROW_HEIGHT_PX = 68;
const OVERSCAN_ROWS = 6;
const VIRTUALIZE_THRESHOLD = 150;

export interface WorkerMetaInfo {
  id: string;
  name: string;
  color: string;
  glyph?: string;
}

export interface TimelineEntry {
  seq: number;
  ts: number;
  durationMs?: number;
  missionId: string;
  workerId: string;
  workerName: string;
  workerColor: string;
  kind: MissionEvent['kind'];
  category: Exclude<TimelineFilter, 'all'>;
  stepId?: string;
  actionLabel: string;
  targetLabel?: string;
  rationale?: string;
  resultStatus?: 'ok' | 'failed' | 'pending';
  outputText?: string;
  tokensTotal?: number;
  costTotal?: number;
  riskClass?: string;
  policyDecision?: string;
  policyReason?: string;
  collapsedScrollCount: number;
  pinned: boolean;
  expanded: boolean;
  rawEvent: MissionEvent;
}

export interface TimelineFilterState {
  category: TimelineFilter;
  workerId: string; // 'all' or specific workerId
  search: string;
  pinnedOnly: boolean;
}

export function classifyEventCategory(kind: MissionEvent['kind']): Exclude<TimelineFilter, 'all'> {
  switch (kind) {
    case 'thought':
      return 'thoughts';
    case 'evidence':
    case 'conflict':
      return 'evidence';
    case 'approval_request':
    case 'question':
    case 'policy_decision':
      return 'approvals';
    case 'error':
      return 'errors';
    default:
      return 'actions';
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class TimelineStore {
  private entriesBySeq = new Map<number, TimelineEntry>();
  private seenSeqs = new Set<number>();
  private orderedSeqs: number[] = [];
  private workers = new Map<string, WorkerMetaInfo>();
  private latestThoughtByWorker = new Map<string, string>();
  private lastEventTsByWorker = new Map<string, number>();
  private pinnedSeqs = new Set<number>();
  private expandedSeqs = new Set<number>();
  private maxSeq = 0;

  public reset(): void {
    this.entriesBySeq.clear();
    this.seenSeqs.clear();
    this.orderedSeqs = [];
    this.workers.clear();
    this.latestThoughtByWorker.clear();
    this.lastEventTsByWorker.clear();
    this.pinnedSeqs.clear();
    this.expandedSeqs.clear();
    this.maxSeq = 0;
  }

  public getSinceSeq(): number {
    return this.maxSeq;
  }

  public getWorkers(): WorkerMetaInfo[] {
    return Array.from(this.workers.values());
  }

  public getEntry(seq: number): TimelineEntry | undefined {
    return this.entriesBySeq.get(seq);
  }

  public togglePin(seq: number): boolean {
    if (this.pinnedSeqs.has(seq)) this.pinnedSeqs.delete(seq);
    else this.pinnedSeqs.add(seq);
    const entry = this.entriesBySeq.get(seq);
    if (entry) entry.pinned = this.pinnedSeqs.has(seq);
    return this.pinnedSeqs.has(seq);
  }

  public toggleExpand(seq: number): boolean {
    if (this.expandedSeqs.has(seq)) this.expandedSeqs.delete(seq);
    else this.expandedSeqs.add(seq);
    const entry = this.entriesBySeq.get(seq);
    if (entry) entry.expanded = this.expandedSeqs.has(seq);
    return this.expandedSeqs.has(seq);
  }

  private resolveWorker(ev: MissionEvent): WorkerMetaInfo {
    const id = ev.workerId || 'mission';
    const existing = this.workers.get(id);
    const color = (typeof ev.data?.color === 'string' && ev.data.color) || existing?.color || OKABE_ITO_WORKERS[this.workers.size % OKABE_ITO_WORKERS.length];
    const name = (typeof ev.data?.name === 'string' && ev.data.name) || (typeof ev.data?.workerName === 'string' && ev.data.workerName) || existing?.name || id;
    const glyph = (typeof ev.data?.glyph === 'string' && ev.data.glyph) || existing?.glyph;
    const info: WorkerMetaInfo = { id, name, color, glyph };
    this.workers.set(id, info);
    return info;
  }

  public applyBatch(events: MissionEvent[]): void {
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    for (const ev of sorted) this.apply(ev);
  }

  public apply(ev: MissionEvent): TimelineEntry | null {
    if (this.seenSeqs.has(ev.seq)) {
      return this.entriesBySeq.get(ev.seq) ?? null; // Idempotent: duplicate seq ignored even after scroll collapse
    }
    this.seenSeqs.add(ev.seq);
    if (ev.seq > this.maxSeq) this.maxSeq = ev.seq;

    const worker = this.resolveWorker(ev);
    const d = ev.data || {};
    const prevTs = this.lastEventTsByWorker.get(worker.id);
    const durationMs = prevTs !== undefined && ev.ts >= prevTs ? ev.ts - prevTs : undefined;
    this.lastEventTsByWorker.set(worker.id, ev.ts);

    if (ev.kind === 'thought' && typeof d.text === 'string') {
      this.latestThoughtByWorker.set(worker.id, d.text);
    }

    // Collapse consecutive scroll tool calls for the same worker
    if (ev.kind === 'tool_call' && d.tool === 'scroll') {
      for (let i = this.orderedSeqs.length - 1; i >= 0; i--) {
        const last = this.entriesBySeq.get(this.orderedSeqs[i]);
        if (!last) continue;
        if (last.workerId === worker.id && last.kind === 'tool_call' && last.rawEvent.data?.tool === 'scroll') {
          last.collapsedScrollCount += 1;
          last.ts = ev.ts;
          last.actionLabel = `scroll ×${last.collapsedScrollCount}`;
          return last;
        }
        if (last.workerId === worker.id) break;
      }
    }

    let actionLabel: string = ev.kind;
    let targetLabel: string | undefined = typeof d.targetLabel === 'string' ? d.targetLabel : undefined;
    let outputText: string | undefined;
    let resultStatus: TimelineEntry['resultStatus'];

    switch (ev.kind) {
      case 'step_started':
        actionLabel = d.task ? `Step: ${String(d.task)}` : `Started ${d.title || worker.name}`;
        targetLabel = typeof d.url === 'string' ? d.url : targetLabel;
        break;
      case 'observation':
        actionLabel = `Observe: ${String(d.title || d.url || 'page')}`;
        targetLabel = d.elementsCount !== undefined ? `${d.elementsCount} elements` : undefined;
        break;
      case 'thought':
        actionLabel = 'Thought';
        outputText = String(d.text || '');
        break;
      case 'tool_call':
        actionLabel = `${String(d.tool || 'action')}`;
        targetLabel = targetLabel || (typeof d.url === 'string' ? d.url : typeof d.text === 'string' ? `"${d.text}"` : undefined);
        break;
      case 'tool_result':
        actionLabel = `Result: ${String(d.tool || 'action')}`;
        resultStatus = d.ok === false ? 'failed' : 'ok';
        outputText = typeof d.output === 'string' ? d.output : undefined;
        break;
      case 'policy_decision':
        actionLabel = `Policy: ${String(d.decision || 'allow')} (${String(d.tool || '')})`;
        outputText = typeof d.reason === 'string' ? d.reason : undefined;
        break;
      case 'approval_request':
        actionLabel = `Approval: ${String(d.tool || 'action')}`;
        resultStatus = 'pending';
        outputText = typeof d.reason === 'string' ? d.reason : undefined;
        break;
      case 'evidence':
        actionLabel = 'Evidence';
        outputText = String(d.text || '');
        resultStatus = 'ok';
        break;
      case 'conflict':
        actionLabel = `Conflict: ${String(d.entity || '')}`;
        outputText = String(d.text || d.reason || '');
        break;
      case 'error':
        actionLabel = 'Error';
        resultStatus = 'failed';
        outputText = String(d.message || d.text || 'Unknown error');
        break;
      case 'status':
        actionLabel = `Status: ${String(d.status || d.text || '')}`;
        outputText = typeof d.reason === 'string' ? d.reason : typeof d.text === 'string' ? d.text : undefined;
        break;
      default:
        outputText = typeof d.text === 'string' ? d.text : undefined;
        break;
    }

    const entry: TimelineEntry = {
      seq: ev.seq,
      ts: ev.ts,
      durationMs,
      missionId: ev.missionId,
      workerId: worker.id,
      workerName: worker.name,
      workerColor: worker.color,
      kind: ev.kind,
      category: classifyEventCategory(ev.kind),
      stepId: ev.stepId,
      actionLabel,
      targetLabel,
      rationale: ev.kind === 'tool_call' ? this.latestThoughtByWorker.get(worker.id) : undefined,
      resultStatus,
      outputText,
      tokensTotal: typeof d.tokensTotal === 'number' ? d.tokensTotal : undefined,
      costTotal: typeof d.costTotal === 'number' ? d.costTotal : undefined,
      riskClass: typeof d.riskClass === 'string' ? d.riskClass : undefined,
      policyDecision: typeof d.decision === 'string' ? d.decision : undefined,
      policyReason: typeof d.reason === 'string' ? d.reason : undefined,
      collapsedScrollCount: d.tool === 'scroll' ? 1 : 0,
      pinned: this.pinnedSeqs.has(ev.seq),
      expanded: this.expandedSeqs.has(ev.seq),
      rawEvent: ev
    };

    this.entriesBySeq.set(ev.seq, entry);
    if (ev.seq > this.maxSeq) this.maxSeq = ev.seq;
    // Insert maintaining ascending seq order for real (>=1) events; synthetic local UI notes (seq <= 0) append in arrival order
    if (ev.seq <= 0 || this.orderedSeqs.length === 0 || ev.seq > this.orderedSeqs[this.orderedSeqs.length - 1]) {
      this.orderedSeqs.push(ev.seq);
    } else {
      const idx = this.orderedSeqs.findIndex(s => s > 0 && s > ev.seq);
      if (idx === -1) this.orderedSeqs.push(ev.seq);
      else this.orderedSeqs.splice(idx, 0, ev.seq);
    }
    return entry;
  }

  public query(filter: TimelineFilterState): TimelineEntry[] {
    const q = filter.search.trim().toLowerCase();
    const out: TimelineEntry[] = [];
    for (const seq of this.orderedSeqs) {
      const e = this.entriesBySeq.get(seq)!;
      if (filter.pinnedOnly && !e.pinned) continue;
      if (filter.workerId !== 'all' && e.workerId !== filter.workerId) continue;
      if (filter.category !== 'all' && e.category !== filter.category) continue;
      if (q) {
        const hay = `${e.workerName} ${e.actionLabel} ${e.targetLabel || ''} ${e.outputText || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(e);
    }
    return out;
  }
}

export function renderTimelineRowHtml(entry: TimelineEntry): string {
  const timeStr = new Date(entry.ts).toISOString().slice(11, 19);
  const durStr = entry.durationMs !== undefined ? `${entry.durationMs}ms` : '';
  const body = entry.outputText
    ? (entry.expanded || entry.outputText.length <= 220 ? entry.outputText : `${entry.outputText.slice(0, 220)}…`)
    : (entry.targetLabel || '');
  const riskBadge = entry.riskClass ? `<span class="tl-risk">${escapeHtml(entry.riskClass)}</span>` : '';
  const resBadge = entry.resultStatus ? `<span class="tl-res tl-res-${entry.resultStatus}">${entry.resultStatus}</span>` : '';
  return `<div class="tl-card item-${entry.category}${entry.pinned ? ' is-pinned' : ''}" data-seq="${entry.seq}" data-worker-id="${escapeHtml(entry.workerId)}" data-category="${entry.category}" tabindex="0" style="border-left: 3px solid ${escapeHtml(entry.workerColor)};">` +
    `<div class="tl-top"><span class="tl-worker-chip" style="background:${escapeHtml(entry.workerColor)}22;color:${escapeHtml(entry.workerColor)};border-color:${escapeHtml(entry.workerColor)}">${escapeHtml(entry.workerName)}</span>` +
    `<span class="tl-action">${escapeHtml(entry.actionLabel)}</span>${riskBadge}${resBadge}` +
    `<span class="tl-time">${timeStr}${durStr ? ` · ${durStr}` : ''}</span></div>` +
    (body ? `<div class="tl-body">${escapeHtml(body)}</div>` : '') +
    `</div>`;
}

export class MissionTimeline {
  public readonly store = new TimelineStore();
  private filter: TimelineFilterState = { category: 'all', workerId: 'all', search: '', pinnedOnly: false };
  private autoScroll = true;
  private selectedSeq: number | null = null;
  private syntheticSeq = 0;
  private lastLiveAnnounceAt = 0;

  private viewportEl: HTMLElement;
  private spacerEl: HTMLElement;
  private rowsEl: HTMLElement;
  private liveRegionEl: HTMLElement;
  private workerFiltersEl: HTMLElement | null;
  private searchInputEl: HTMLInputElement | null;
  private jumpLatestBtn: HTMLButtonElement | null;
  private inspectorEl: HTMLElement | null;
  private inspectorBodyEl: HTMLElement | null;

  constructor(container: HTMLElement) {
    this.viewportEl = container;
    this.viewportEl.setAttribute('role', 'log');
    this.viewportEl.setAttribute('aria-label', 'Mission Activity Timeline');

    this.liveRegionEl = document.createElement('div');
    this.liveRegionEl.className = 'sr-only';
    this.liveRegionEl.setAttribute('aria-live', 'polite');

    this.spacerEl = document.createElement('div');
    this.spacerEl.className = 'tl-spacer';
    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'tl-rows';
    this.spacerEl.appendChild(this.rowsEl);

    this.viewportEl.replaceChildren(this.liveRegionEl, this.spacerEl);

    this.workerFiltersEl = document.getElementById('timeline-worker-filters');
    this.searchInputEl = document.getElementById('timeline-search') as HTMLInputElement | null;
    this.jumpLatestBtn = document.getElementById('timeline-jump-latest') as HTMLButtonElement | null;
    this.inspectorEl = document.getElementById('timeline-inspector');
    this.inspectorBodyEl = document.getElementById('timeline-inspector-body');

    this.bindEvents();
  }

  private bindEvents(): void {
    this.viewportEl.addEventListener('scroll', () => {
      const atBottom = this.viewportEl.scrollTop + this.viewportEl.clientHeight >= this.viewportEl.scrollHeight - 24;
      this.autoScroll = atBottom;
      this.jumpLatestBtn?.classList.toggle('hidden', atBottom);
      this.renderVisibleSlice();
    });

    this.jumpLatestBtn?.addEventListener('click', () => {
      this.autoScroll = true;
      this.viewportEl.scrollTop = this.viewportEl.scrollHeight;
      this.jumpLatestBtn?.classList.add('hidden');
      this.renderVisibleSlice();
    });

    this.searchInputEl?.addEventListener('input', () => {
      this.filter.search = this.searchInputEl?.value || '';
      this.render();
    });

    document.getElementById('timeline-inspector-close')?.addEventListener('click', () => {
      this.inspectorEl?.classList.add('hidden');
      this.selectedSeq = null;
    });

    this.rowsEl.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest('.tl-card') as HTMLElement | null;
      if (!card) return;
      const seq = Number(card.dataset.seq);
      if (Number.isFinite(seq)) this.openInspector(seq);
    });

    this.viewportEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      const cards = Array.from(this.rowsEl.querySelectorAll('.tl-card')) as HTMLElement[];
      if (cards.length === 0) return;
      const activeIdx = cards.findIndex(c => c === document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        cards[Math.min(cards.length - 1, activeIdx + 1)]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cards[Math.max(0, activeIdx - 1)]?.focus();
      } else if (e.key === 'Enter' && activeIdx >= 0) {
        const seq = Number(cards[activeIdx].dataset.seq);
        if (Number.isFinite(seq)) this.openInspector(seq);
      }
    });
  }

  public setCategoryFilter(category: TimelineFilter): void {
    this.filter.category = category;
    this.render();
  }

  public setWorkerFilter(workerId: string): void {
    this.filter.workerId = workerId;
    this.renderWorkerChips();
    this.render();
  }

  public pushEvent(ev: MissionEvent, nowMs = Date.now()): void {
    this.store.apply(ev);
    if (ev.kind === 'status' && nowMs - this.lastLiveAnnounceAt >= LIVE_REGION_MIN_INTERVAL_MS) {
      this.lastLiveAnnounceAt = nowMs;
      this.liveRegionEl.textContent = `Mission status: ${String(ev.data?.status || ev.data?.text || '')}`;
    }
    this.renderWorkerChips();
    this.render();
  }

  public pushLegacyText(text: string): void {
    const seq = --this.syntheticSeq;
    const lower = text.toLowerCase();
    const kind: MissionEvent['kind'] = lower.includes('[thought')
      ? 'thought'
      : lower.includes('[error')
        ? 'error'
        : lower.includes('[evidence') || lower.includes('[blackboard evidence]')
          ? 'evidence'
          : 'status';
    this.pushEvent({ seq, ts: Date.now(), missionId: 'live', kind, data: { text } });
  }

  private renderWorkerChips(): void {
    if (!this.workerFiltersEl) return;
    const workers = this.store.getWorkers().filter(w => w.id !== 'mission');
    this.workerFiltersEl.replaceChildren();
    if (workers.length <= 1) return;

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `filter-chip${this.filter.workerId === 'all' ? ' active' : ''}`;
    allBtn.dataset.workerFilter = 'all';
    allBtn.textContent = 'All workers';
    allBtn.addEventListener('click', () => this.setWorkerFilter('all'));
    this.workerFiltersEl.appendChild(allBtn);

    for (const w of workers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `filter-chip${this.filter.workerId === w.id ? ' active' : ''}`;
      btn.dataset.workerFilter = w.id;
      btn.style.borderColor = w.color;
      btn.textContent = w.name;
      btn.addEventListener('click', () => this.setWorkerFilter(w.id));
      this.workerFiltersEl.appendChild(btn);
    }
  }

  public render(): void {
    const items = this.store.query(this.filter);
    this.spacerEl.style.height = items.length > VIRTUALIZE_THRESHOLD ? `${Math.max(items.length * ROW_HEIGHT_PX, ROW_HEIGHT_PX)}px` : 'auto';
    if (this.autoScroll) {
      this.viewportEl.scrollTop = this.viewportEl.scrollHeight;
    }
    this.renderVisibleSlice(items);
  }

  private renderVisibleSlice(prequeried?: TimelineEntry[]): void {
    const items = prequeried ?? this.store.query(this.filter);
    if (items.length === 0) {
      this.rowsEl.style.transform = 'translateY(0px)';
      this.rowsEl.innerHTML = '<div id="no-evidence-msg" class="empty-state-text">No activity recorded</div>';
      return;
    }
    if (items.length <= VIRTUALIZE_THRESHOLD) {
      this.rowsEl.style.transform = 'translateY(0px)';
      this.rowsEl.innerHTML = items.map(renderTimelineRowHtml).join('');
      return;
    }
    const viewH = this.viewportEl.clientHeight || 400;
    const scrollTop = this.viewportEl.scrollTop || 0;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS);
    const visibleCount = Math.ceil(viewH / ROW_HEIGHT_PX) + OVERSCAN_ROWS * 2;
    const endIdx = Math.min(items.length, startIdx + visibleCount);

    this.rowsEl.style.transform = `translateY(${startIdx * ROW_HEIGHT_PX}px)`;
    const slice = items.slice(startIdx, endIdx);
    this.rowsEl.innerHTML = slice.map(renderTimelineRowHtml).join('');
  }

  public openInspector(seq: number): void {
    const entry = this.store.getEntry(seq);
    if (!entry || !this.inspectorEl || !this.inspectorBodyEl) return;
    this.selectedSeq = seq;
    this.inspectorEl.classList.remove('hidden');
    this.inspectorBodyEl.innerHTML =
      `<div class="tl-insp-meta"><strong>${escapeHtml(entry.workerName)}</strong> · seq #${entry.seq} · ${escapeHtml(entry.kind)}</div>` +
      (entry.rationale ? `<div class="tl-insp-sec"><label>Rationale</label><p>${escapeHtml(entry.rationale)}</p></div>` : '') +
      (entry.policyReason ? `<div class="tl-insp-sec"><label>Policy Trace (${escapeHtml(entry.riskClass || 'low')})</label><p>${escapeHtml(entry.policyDecision || '')}: ${escapeHtml(entry.policyReason)}</p></div>` : '') +
      `<div class="tl-insp-sec"><label>Raw Event JSON (Redacted)</label><pre>${escapeHtml(JSON.stringify(entry.rawEvent, null, 2))}</pre></div>`;
  }
}
