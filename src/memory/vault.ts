/**
 * Project Aegis - Secure Encrypted Credential & API Key Vault
 * 
 * Implements:
 * - Issue #50: MEM-05 Secure Encrypted Vault for User Credentials & API Keys
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EncryptedPayload {
  version: number;
  salt: string; // hex
  iv: string;   // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

export interface CredentialEntry {
  id: string;
  category: 'api_key' | 'credential' | 'cookie' | 'secret';
  key: string;
  value: string;
  domain?: string;
  updatedAt: number;
  metadata?: Record<string, any>;
}

export class EncryptedVault {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32;
  private static readonly IV_LENGTH = 16;
  private static readonly SALT_LENGTH = 32;
  private static readonly ITERATIONS = 100_000;
  private static readonly DIGEST = 'sha512';

  private masterKey: Buffer | null = null;
  private salt: Buffer | null = null;
  private entries: Map<string, CredentialEntry> = new Map();
  private storagePath: string | null = null;
  private isUnlocked = false;

  constructor(storagePath?: string) {
    if (storagePath) {
      this.storagePath = storagePath;
      const dir = path.dirname(storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Unlocks the vault using the user master passphrase.
   * If the vault file does not exist yet, initializes a new encrypted file.
   */
  public unlock(passphrase: string): boolean {
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const payload: EncryptedPayload = JSON.parse(raw);
        const salt = Buffer.from(payload.salt, 'hex');
        const iv = Buffer.from(payload.iv, 'hex');
        const authTag = Buffer.from(payload.authTag, 'hex');
        const ciphertext = Buffer.from(payload.ciphertext, 'hex');

        const key = crypto.pbkdf2Sync(passphrase, salt, EncryptedVault.ITERATIONS, EncryptedVault.KEY_LENGTH, EncryptedVault.DIGEST);
        const decipher = crypto.createDecipheriv(EncryptedVault.ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const entriesArray: CredentialEntry[] = JSON.parse(decrypted.toString('utf8'));

        this.entries.clear();
        for (const entry of entriesArray) {
          this.entries.set(entry.id, entry);
        }

        this.masterKey = key;
        this.salt = salt;
        this.isUnlocked = true;
        return true;
      } catch (err) {
        return false;
      }
    } else {
      // Initialize fresh vault
      const salt = crypto.randomBytes(EncryptedVault.SALT_LENGTH);
      this.masterKey = crypto.pbkdf2Sync(passphrase, salt, EncryptedVault.ITERATIONS, EncryptedVault.KEY_LENGTH, EncryptedVault.DIGEST);
      this.salt = salt;
      this.isUnlocked = true;
      if (this.storagePath) {
        this.saveToFile(salt);
      }
      return true;
    }
  }

  /**
   * Locks the vault and scrubs keys from memory.
   */
  public lock(): void {
    if (this.masterKey) {
      this.masterKey.fill(0); // Zero-out buffer
      this.masterKey = null;
    }
    if (this.salt) {
      this.salt.fill(0);
      this.salt = null;
    }
    this.entries.clear();
    this.isUnlocked = false;
  }

  public getUnlocked(): boolean {
    return this.isUnlocked;
  }

  /**
   * Stores or updates a secret entry.
   */
  public setSecret(entry: Omit<CredentialEntry, 'updatedAt'>): void {
    this.ensureUnlocked();
    const fullEntry: CredentialEntry = {
      ...entry,
      updatedAt: Date.now()
    };
    this.entries.set(entry.id, fullEntry);
    this.save();
  }

  /**
   * Retrieves a secret value by ID.
   */
  public getSecret(id: string): string | null {
    this.ensureUnlocked();
    const entry = this.entries.get(id);
    return entry ? entry.value : null;
  }

  /**
   * Retrieves credentials matching a specific domain.
   */
  public getSecretsByDomain(domain: string): CredentialEntry[] {
    this.ensureUnlocked();
    return Array.from(this.entries.values()).filter(e => e.domain === domain);
  }

  /**
   * Retrieves all API keys configured in the vault.
   */
  public getApiKeys(): Record<string, string> {
    this.ensureUnlocked();
    const keys: Record<string, string> = {};
    for (const entry of this.entries.values()) {
      if (entry.category === 'api_key') {
        keys[entry.key] = entry.value;
      }
    }
    return keys;
  }

  /**
   * Removes a secret by ID.
   */
  public removeSecret(id: string): boolean {
    this.ensureUnlocked();
    const deleted = this.entries.delete(id);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  /**
   * Lists metadata of stored entries (without exposing secret values).
   */
  public listEntries(): Array<Omit<CredentialEntry, 'value'>> {
    this.ensureUnlocked();
    return Array.from(this.entries.values()).map(e => ({
      id: e.id,
      category: e.category,
      key: e.key,
      domain: e.domain,
      updatedAt: e.updatedAt,
      metadata: e.metadata
    }));
  }

  private ensureUnlocked(): void {
    if (!this.isUnlocked || !this.masterKey) {
      throw new Error('EncryptedVault is locked. Call unlock(passphrase) first.');
    }
  }

  private save(): void {
    if (!this.storagePath || !this.salt) return;
    this.saveToFile(this.salt);
  }

  private saveToFile(salt: Buffer): void {
    if (!this.storagePath || !this.masterKey) return;
    const iv = crypto.randomBytes(EncryptedVault.IV_LENGTH);
    const cipher = crypto.createCipheriv(EncryptedVault.ALGORITHM, this.masterKey, iv);

    const plaintext = Buffer.from(JSON.stringify(Array.from(this.entries.values())), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
      version: 1,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      ciphertext: ciphertext.toString('hex')
    };

    fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}
