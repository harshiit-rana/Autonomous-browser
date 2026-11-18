/**
 * Project Aegis - Secure Credential Vault & Role-Based Routing
 * Implements: Issue #133 [MDL-06] OS keystore integration via Electron safeStorage,
 * zero plaintext persistence, role-based model routing, and credential verification.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { getAppPaths } from './paths.js';
import { rootLogger } from './logger.js';

const logger = rootLogger.child('credential-vault');

export type AgentRole = 'planner' | 'actor' | 'verifier' | 'summariser' | 'vision-grounder';

export interface RoleModelAssignment {
  provider: 'gemini' | 'anthropic' | 'openai' | 'ollama' | 'local';
  model: string;
}

export interface RoleRoutingConfig {
  planner: RoleModelAssignment;
  actor: RoleModelAssignment;
  verifier: RoleModelAssignment;
  summariser: RoleModelAssignment;
  visionGrounder: RoleModelAssignment;
}

export type RoutingPreset = 'fast_cheap' | 'balanced' | 'max_quality' | 'local_only';

export const ROUTING_PRESETS: Record<RoutingPreset, RoleRoutingConfig> = {
  fast_cheap: {
    planner: { provider: 'gemini', model: 'gemini-2.0-flash' },
    actor: { provider: 'gemini', model: 'gemini-2.0-flash' },
    verifier: { provider: 'gemini', model: 'gemini-2.0-flash' },
    summariser: { provider: 'gemini', model: 'gemini-2.0-flash' },
    visionGrounder: { provider: 'gemini', model: 'gemini-2.0-flash' }
  },
  balanced: {
    planner: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
    actor: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    verifier: { provider: 'gemini', model: 'gemini-2.0-flash' },
    summariser: { provider: 'openai', model: 'gpt-4o-mini' },
    visionGrounder: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' }
  },
  max_quality: {
    planner: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
    actor: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
    verifier: { provider: 'openai', model: 'gpt-4o' },
    summariser: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    visionGrounder: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' }
  },
  local_only: {
    planner: { provider: 'ollama', model: 'deepseek-r1:8b' },
    actor: { provider: 'ollama', model: 'deepseek-r1:8b' },
    verifier: { provider: 'ollama', model: 'deepseek-r1:8b' },
    summariser: { provider: 'ollama', model: 'deepseek-r1:8b' },
    visionGrounder: { provider: 'ollama', model: 'deepseek-r1:8b' }
  }
};

export class CredentialVault {
  private static instance: CredentialVault | null = null;
  private vaultPath: string | null = null;
  private inMemoryStore: Map<string, string> = new Map();

  private constructor() {
    try {
      const paths = getAppPaths();
      this.vaultPath = path.join(paths.userData, 'vault.enc');
    } catch {
      this.vaultPath = null;
    }
  }

  public static getInstance(): CredentialVault {
    if (!CredentialVault.instance) {
      CredentialVault.instance = new CredentialVault();
    }
    return CredentialVault.instance;
  }

  private isSafeStorageAvailable(): boolean {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  public async setKey(provider: string, rawKey: string): Promise<void> {
    const cleanKey = (rawKey || '').trim();
    if (!cleanKey) {
      await this.deleteKey(provider);
      return;
    }

    if (this.isSafeStorageAvailable() && this.vaultPath) {
      try {
        const encrypted = safeStorage.encryptString(cleanKey);
        const vaultData = this.loadVaultFile();
        vaultData[provider] = encrypted.toString('base64');
        fs.writeFileSync(this.vaultPath, JSON.stringify(vaultData, null, 2), 'utf-8');
        logger.info(`Encrypted API key saved for provider '${provider}'`);
        return;
      } catch (err: any) {
        logger.warn(`SafeStorage write failed, falling back to in-memory store: ${err.message}`);
      }
    }

    // Fallback in-memory
    this.inMemoryStore.set(provider, cleanKey);
    logger.info(`API key stored in memory for provider '${provider}'`);
  }

  public getKeySync(provider: string): string | undefined {
    if (this.inMemoryStore.has(provider)) {
      return this.inMemoryStore.get(provider);
    }

    if (this.isSafeStorageAvailable() && this.vaultPath && fs.existsSync(this.vaultPath)) {
      try {
        const vaultData = this.loadVaultFile();
        const base64Enc = vaultData[provider];
        if (base64Enc) {
          const buffer = Buffer.from(base64Enc, 'base64');
          return safeStorage.decryptString(buffer);
        }
      } catch (err: any) {
        logger.error(`Failed to decrypt key for provider '${provider}'`, err);
      }
    }

    return undefined;
  }

  public async getKey(provider: string): Promise<string | undefined> {
    return this.getKeySync(provider);
  }

  public async deleteKey(provider: string): Promise<void> {
    this.inMemoryStore.delete(provider);
    if (this.vaultPath && fs.existsSync(this.vaultPath)) {
      try {
        const vaultData = this.loadVaultFile();
        delete vaultData[provider];
        fs.writeFileSync(this.vaultPath, JSON.stringify(vaultData, null, 2), 'utf-8');
      } catch {}
    }
  }

  private loadVaultFile(): Record<string, string> {
    if (!this.vaultPath || !fs.existsSync(this.vaultPath)) {
      return {};
    }
    try {
      const content = fs.readFileSync(this.vaultPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /**
   * Test connection and credentials for a given provider with a minimal probe call
   */
  public async testCredentials(
    provider: string,
    key: string,
    baseUrl?: string
  ): Promise<{ valid: boolean; message: string; models?: string[] }> {
    const cleanKey = key.trim();
    if (!cleanKey && provider !== 'ollama' && provider !== 'local') {
      return { valid: false, message: 'API key cannot be empty' };
    }

    try {
      if (provider === 'gemini') {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: cleanKey });
        // Minimal probe
        const res = await ai.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: 'ping'
        });
        if (res && res.text) {
          return { valid: true, message: 'Successfully authenticated with Gemini API', models: ['gemini-2.0-flash', 'gemini-1.5-pro'] };
        }
      } else if (provider === 'openai') {
        const { OpenAI } = await import('openai');
        const client = new OpenAI({ apiKey: cleanKey, baseURL: baseUrl });
        const list = await client.models.list();
        const models = list.data.map(m => m.id).slice(0, 10);
        return { valid: true, message: `Connected to OpenAI (${list.data.length} models found)`, models };
      } else if (provider === 'anthropic') {
        const { Anthropic } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: cleanKey });
        const count = await client.messages.countTokens({
          model: 'claude-3-5-haiku-latest',
          messages: [{ role: 'user', content: 'hi' }]
        });
        if (count && count.input_tokens > 0) {
          return { valid: true, message: 'Successfully authenticated with Anthropic API', models: ['claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'] };
        }
      } else if (provider === 'ollama' || provider === 'local') {
        const targetUrl = baseUrl || 'http://localhost:11434';
        const res = await fetch(`${targetUrl}/api/tags`);
        if (res.ok) {
          const data = await res.json() as any;
          const models = data.models ? data.models.map((m: any) => m.name) : [];
          return { valid: true, message: `Connected to local Ollama (${models.length} models found)`, models };
        }
        return { valid: false, message: `Ollama returned status ${res.status}` };
      }
      return { valid: false, message: `Unknown provider '${provider}'` };
    } catch (err: any) {
      return { valid: false, message: `Authentication check failed: ${err.message}` };
    }
  }
}

export const credentialVault = CredentialVault.getInstance();
