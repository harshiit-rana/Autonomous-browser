/**
 * Project Aegis - Multi-Device Swarm Synchronization Relay
 * 
 * Implements:
 * - Issue #99: SYNC-01 Multi-Device Swarm Synchronization (Mobile Companion App)
 */

import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

export interface MobileSyncMessage {
  type: 'status_update' | 'approval_request' | 'approval_response' | 'new_evidence';
  payload: any;
  timestamp: number;
}

export class MobileSyncRelay extends EventEmitter {
  private pairingCode: string;
  private server: http.Server | null = null;
  private isPaired = false;
  private port: number;

  constructor(port = 8765) {
    super();
    this.port = port;
    this.pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
  }

  public getPairingCode(): string {
    return this.pairingCode;
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = req.url || '';

        // Pairing endpoint
        if (url === '/api/pair' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            let data: any = {};
            try { data = JSON.parse(body || '{}'); } catch {}
            if (data.code === this.pairingCode) {
              this.isPaired = true;
              this.emit('mobile_paired');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'paired', deviceName: 'Aegis Desktop' }));
            } else {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid pairing code' }));
            }
          });
          return;
        }

        // Approval callback endpoint
        if (url === '/api/approve' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            let data: any = {};
            try { data = JSON.parse(body || '{}'); } catch {}
            this.emit('mobile_approval', data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'received' }));
          });
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ service: 'Aegis Mobile Sync Relay', paired: this.isPaired }));
      });

      this.server.listen(this.port, () => resolve(this.port));
      this.server.on('error', err => reject(err));
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
