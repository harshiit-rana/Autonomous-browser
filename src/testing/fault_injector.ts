/**
 * Project Aegis - Fault Injection & Chaos Engine (Issue #199 - [QA-06])
 * 
 * Implements a matrix of 40+ simulated system, network, model, process, and data faults
 * to guarantee resilience, graceful degradation, and zero orphaned/zombie states.
 */

import { logger } from '../infrastructure/logger.js';

export type ChaosFaultCategory = 'network' | 'provider' | 'process' | 'system' | 'data';

export interface ChaosFaultScenario {
  id: string;
  category: ChaosFaultCategory;
  name: string;
  description: string;
  trigger: () => Promise<any> | any;
  expectedOutcome: 'handled_with_retry' | 'clean_failure_reported' | 'fallback_activated' | 'circuit_breaker_opened';
}

export class FaultInjector {
  private activeFaults: Set<string> = new Set();

  public injectFault(faultId: string): void {
    this.activeFaults.add(faultId);
    logger.warn('Injected simulated fault scenario', { faultId });
  }

  public clearFault(faultId: string): void {
    this.activeFaults.delete(faultId);
    logger.info('Cleared simulated fault scenario', { faultId });
  }

  public clearAllFaults(): void {
    this.activeFaults.clear();
  }

  public isFaultActive(faultId: string): boolean {
    return this.activeFaults.has(faultId);
  }

  /**
   * Generates the 40+ Fault Matrix Catalog
   */
  public static getFaultCorpus(): ChaosFaultScenario[] {
    return [
      // 1. Network Faults (1-10)
      { id: 'net_offline', category: 'network', name: 'Network Offline Toggle', description: 'Network drops mid-mission step', trigger: () => { throw new Error('ERR_INTERNET_DISCONNECTED'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'net_dns_fail', category: 'network', name: 'DNS Resolution Failure', description: 'Target domain NXDOMAIN', trigger: () => { throw new Error('ERR_NAME_NOT_RESOLVED'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'net_429_storm', category: 'network', name: 'HTTP 429 Rate Limit Storm', description: 'Target origin replies with 429 Too Many Requests', trigger: () => ({ status: 429, retryAfter: 2 }), expectedOutcome: 'handled_with_retry' },
      { id: 'net_503_outage', category: 'network', name: 'HTTP 503 Service Unavailable', description: 'Target origin server down', trigger: () => ({ status: 503 }), expectedOutcome: 'handled_with_retry' },
      { id: 'net_redirect_loop', category: 'network', name: 'Infinite HTTP Redirect Loop', description: 'A -> B -> A redirect loop', trigger: () => { throw new Error('ERR_TOO_MANY_REDIRECTS'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'net_tls_invalid', category: 'network', name: 'Expired/Invalid TLS Certificate', description: 'Certificate untrusted', trigger: () => { throw new Error('ERR_CERT_AUTHORITY_INVALID'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'net_slow_2g', category: 'network', name: 'High Latency Slow Network', description: '15,000ms response delay', trigger: () => new Promise(r => setTimeout(r, 100)), expectedOutcome: 'handled_with_retry' },
      { id: 'net_packet_loss', category: 'network', name: 'Intermittent Socket Reset', description: 'Connection reset by peer mid-stream', trigger: () => { throw new Error('ECONNRESET'); }, expectedOutcome: 'handled_with_retry' },
      { id: 'net_captive_portal', category: 'network', name: 'Captive Portal Interstitial', description: 'HTTP 200 with Wi-Fi login page', trigger: () => ({ status: 200, captivePortal: true }), expectedOutcome: 'clean_failure_reported' },
      { id: 'net_websocket_drop', category: 'network', name: 'CDP WebSocket Drop', description: 'CDP connection closed abruptly', trigger: () => { throw new Error('CDP WebSocket Disconnected'); }, expectedOutcome: 'handled_with_retry' },

      // 2. LLM Provider Faults (11-20)
      { id: 'prov_429_ratelimit', category: 'provider', name: 'Model Provider 429', description: 'Rate limit hit on primary provider', trigger: () => { throw new Error('Provider Rate Limit Exceeded (429)'); }, expectedOutcome: 'fallback_activated' },
      { id: 'prov_500_overloaded', category: 'provider', name: 'Model Provider 500 Overloaded', description: 'Provider servers overloaded', trigger: () => { throw new Error('Internal Server Error 500'); }, expectedOutcome: 'handled_with_retry' },
      { id: 'prov_empty_response', category: 'provider', name: 'Provider Empty Content', description: 'Model returns empty string without tool calls', trigger: () => ({ content: '' }), expectedOutcome: 'clean_failure_reported' },
      { id: 'prov_truncated_tokens', category: 'provider', name: 'Max Tokens Truncation', description: 'Model stops due to max_tokens limit mid-JSON', trigger: () => ({ stopReason: 'max_tokens', partial: '{"too' }), expectedOutcome: 'clean_failure_reported' },
      { id: 'prov_refusal', category: 'provider', name: 'Model Safety Refusal', description: 'Model declines prompt due to safety policy', trigger: () => ({ stopReason: 'refusal', message: 'I cannot fulfill this request' }), expectedOutcome: 'clean_failure_reported' },
      { id: 'prov_key_revoked', category: 'provider', name: 'API Key Revoked Mid-Mission', description: '401 Unauthorized from model provider', trigger: () => { throw new Error('401 Unauthorized API Key Invalid'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'prov_malformed_json', category: 'provider', name: 'Malformed Tool Call JSON', description: 'Non-JSON syntax in tool arguments', trigger: () => ({ toolCallArgs: '{ invalid json' }), expectedOutcome: 'handled_with_retry' },
      { id: 'prov_repeated_failures', category: 'provider', name: 'Circuit Breaker Trip', description: '5 consecutive provider failures', trigger: () => { throw new Error('Continuous Outage'); }, expectedOutcome: 'circuit_breaker_opened' },
      { id: 'prov_slow_first_token', category: 'provider', name: 'Slow First Token Timeout', description: 'Model takes 60s for first token', trigger: () => ({ timeout: true }), expectedOutcome: 'handled_with_retry' },
      { id: 'prov_quota_exhausted', category: 'provider', name: 'Monthly Budget Exhausted', description: 'Provider billing account empty', trigger: () => { throw new Error('Monthly Quota Exhausted'); }, expectedOutcome: 'clean_failure_reported' },

      // 3. Process & Rendering Faults (21-30)
      { id: 'proc_renderer_crash', category: 'process', name: 'Worker Renderer Crash', description: 'Renderer process terminated unexpectedly', trigger: () => ({ killed: true, exitCode: 139 }), expectedOutcome: 'handled_with_retry' },
      { id: 'proc_gpu_crash', category: 'process', name: 'GPU Process Crash', description: 'GPU process restarted', trigger: () => ({ gpuRestarted: true }), expectedOutcome: 'fallback_activated' },
      { id: 'proc_worker_hang', category: 'process', name: 'Worker Page Hang', description: 'JavaScript infinite loop on page', trigger: () => ({ hung: true, timeout: 5000 }), expectedOutcome: 'handled_with_retry' },
      { id: 'proc_oom_simulation', category: 'process', name: 'Out-Of-Memory Eviction', description: 'Worker tab evicted by OS memory pressure', trigger: () => ({ oom: true }), expectedOutcome: 'handled_with_retry' },
      { id: 'proc_main_exception', category: 'process', name: 'Main Process IPC Exception', description: 'Unhandled exception inside IPC handler', trigger: () => { throw new Error('IPC Handler Panic'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'proc_cdp_drop', category: 'process', name: 'CDP Session Drop', description: 'CDP session disconnects mid-click', trigger: () => { throw new Error('CDP target detached'); }, expectedOutcome: 'handled_with_retry' },
      { id: 'proc_kill_signal', category: 'process', name: 'SIGTERM Kill Signal', description: 'SIGTERM received mid-mission', trigger: () => ({ sigterm: true }), expectedOutcome: 'clean_failure_reported' },
      { id: 'proc_tab_closed', category: 'process', name: 'User Closed Tab', description: 'Target tab closed by user', trigger: () => { throw new Error('Target page destroyed'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'proc_devtools_open', category: 'process', name: 'DevTools Opened', description: 'DevTools attached to target tab', trigger: () => ({ devtoolsAttached: true }), expectedOutcome: 'handled_with_retry' },

      // 4. System & OS Faults (30-38)
      { id: 'sys_disk_full', category: 'system', name: 'ENOSPC Disk Full', description: 'Disk full during evidence write', trigger: () => { throw new Error('ENOSPC: no space left on device'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'sys_permission_denied', category: 'system', name: 'EACCES Permission Denied', description: 'Data directory read-only', trigger: () => { throw new Error('EACCES: permission denied'); }, expectedOutcome: 'clean_failure_reported' },
      { id: 'sys_clock_jump', category: 'system', name: 'Clock Jump / DST Shift', description: 'System time jumps forward by 2 hours', trigger: () => ({ timeOffsetMs: 7_200_000 }), expectedOutcome: 'handled_with_retry' },
      { id: 'sys_sleep_resume', category: 'system', name: 'Laptop Lid Close / Sleep', description: 'System sleeps for 4 hours then wakes', trigger: () => ({ sleepDurationMs: 14_400_000 }), expectedOutcome: 'handled_with_retry' },
      { id: 'sys_low_ram', category: 'system', name: 'Low Memory Pressure', description: 'Free RAM drops below 500MB', trigger: () => ({ freeMemMB: 400 }), expectedOutcome: 'fallback_activated' },
      { id: 'sys_display_change', category: 'system', name: 'DPI Display Change', description: 'Window moved across high-DPI displays', trigger: () => ({ scaleFactor: 2.0 }), expectedOutcome: 'handled_with_retry' },
      { id: 'sys_screen_locked', category: 'system', name: 'Workstation Locked', description: 'Screen locked while waiting for approval', trigger: () => ({ locked: true }), expectedOutcome: 'clean_failure_reported' },

      // 5. Data & Storage Faults (38-42)
      { id: 'data_corrupt_json', category: 'data', name: 'Corrupt Settings JSON', description: 'Config file truncated mid-write', trigger: () => '{ invalid json }', expectedOutcome: 'fallback_activated' },
      { id: 'data_db_locked', category: 'data', name: 'SQLite DB Busy / Locked', description: 'SQLite database locked by external process', trigger: () => { throw new Error('SQLITE_BUSY: database is locked'); }, expectedOutcome: 'handled_with_retry' },
      { id: 'data_bad_schema', category: 'data', name: 'Corrupted State Record', description: 'Missing required fields in mission store', trigger: () => ({}), expectedOutcome: 'clean_failure_reported' },
      { id: 'data_wal_corrupt', category: 'data', name: 'SQLite WAL Header Corrupted', description: 'WAL header corrupted', trigger: () => { throw new Error('SQLITE_CORRUPT: wal header broken'); }, expectedOutcome: 'clean_failure_reported' }
    ];
  }
}
