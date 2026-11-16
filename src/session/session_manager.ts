/**
 * Project Aegis - Session Management & Multi-Profile Partition Isolation
 * 
 * Implements:
 * - Issue #61: SESSION-01 Cross-Restart Session & Persistent Cookie Store Migration
 * - Issue #63: SESSION-03 Multi-Account Profile Isolation (Simultaneous Multi-Session)
 * - Issue #65: SESSION-05 Auto-Save Form State & Crash Recovery Restoration Loop
 */

import { session, Session, CookiesGetFilter, Cookie } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface UserProfile {
  id: string;
  name: string;
  isIncognito: boolean;
  partitionName: string;
  colorBadge?: string;
  createdAt: number;
}

export interface StoredSessionState {
  profileId: string;
  timestamp: number;
  openTabs: Array<{ url: string; title: string; active: boolean }>;
  cookies: Cookie[];
}

export class SessionManager {
  private profiles: Map<string, UserProfile> = new Map();
  private storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir || path.join(process.cwd(), '.sessions');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    // Initialize default profile
    this.getOrCreateProfile('default', 'Default Profile', false);
  }

  /**
   * Retrieves or provisions an isolated profile partition.
   */
  public getOrCreateProfile(id: string, name = 'Profile', incognito = false): UserProfile {
    const existing = this.profiles.get(id);
    if (existing) return existing;

    const partitionName = incognito ? `profile_incognito_${id}` : `persist:profile_${id}`;
    const profile: UserProfile = {
      id,
      name,
      isIncognito: incognito,
      partitionName,
      createdAt: Date.now()
    };

    this.profiles.set(id, profile);
    return profile;
  }

  /**
   * Gets the Electron Session associated with a profile partition.
   */
  public getElectronSession(profileId: string): Session {
    const profile = this.getOrCreateProfile(profileId);
    return session.fromPartition(profile.partitionName);
  }

  /**
   * Saves cookies and active tab states to disk for cross-restart crash recovery.
   */
  public async saveSessionState(
    profileId: string,
    openTabs: Array<{ url: string; title: string; active: boolean }>
  ): Promise<void> {
    const ses = this.getElectronSession(profileId);
    const cookies = await ses.cookies.get({});

    const state: StoredSessionState = {
      profileId,
      timestamp: Date.now(),
      openTabs,
      cookies
    };

    const filePath = path.join(this.storageDir, `session_${profileId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  }

  /**
   * Restores cookies and tab states from saved session.
   */
  public async restoreSessionState(profileId: string): Promise<StoredSessionState | null> {
    const filePath = path.join(this.storageDir, `session_${profileId}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const state: StoredSessionState = JSON.parse(raw);
      const ses = this.getElectronSession(profileId);

      // Restore cookies
      for (const c of state.cookies) {
        try {
          const domain = c.domain ? c.domain.replace(/^\./, '') : 'localhost';
          const url = (c.secure ? 'https://' : 'http://') + domain + (c.path || '/');
          await ses.cookies.set({
            url,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate
          });
        } catch {}
      }

      return state;
    } catch (err) {
      console.warn(`[SessionManager] Failed to restore session for ${profileId}:`, err);
      return null;
    }
  }

  public listProfiles(): UserProfile[] {
    return Array.from(this.profiles.values());
  }
}
