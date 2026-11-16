/**
 * Project Aegis - Enterprise RBAC & Single Sign-On (SSO) Manager
 * 
 * Implements:
 * - Issue #93: ENT-01 Enterprise Role-Based Access Control (RBAC) & Team Policies
 * - Issue #94: ENT-02 Single Sign-On (SSO) & SAML/OIDC Enterprise Login Manager
 */

export type UserRole = 'admin' | 'operator' | 'auditor' | 'restricted';

export interface EnterprisePolicy {
  allowedDomains?: string[]; // Allowed target domains (whitelist)
  deniedDomains?: string[];  // Blocked domains (blacklist)
  allowCheckout: boolean;    // Allow autonomous checkout / financial transactions
  allowFileDownload: boolean;// Allow file downloads
  maxConcurrentTabs: number; // Max concurrent swarm tabs allowed
  requireAuditLogging: boolean;
}

export interface SSOConfig {
  provider: 'okta' | 'azure_ad' | 'google_workspace' | 'custom_oidc';
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
}

export class EnterpriseRBACManager {
  private rolePolicies: Map<UserRole, EnterprisePolicy> = new Map();
  private userRoles: Map<string, UserRole> = new Map(); // userId -> role
  private ssoConfig?: SSOConfig;

  constructor() {
    this.initDefaultPolicies();
  }

  private initDefaultPolicies(): void {
    // Admin: Full permissions
    this.rolePolicies.set('admin', {
      allowCheckout: true,
      allowFileDownload: true,
      maxConcurrentTabs: 16,
      requireAuditLogging: true
    });

    // Operator: Standard swarm research and data extraction, no unconfirmed checkouts
    this.rolePolicies.set('operator', {
      allowCheckout: false,
      allowFileDownload: true,
      maxConcurrentTabs: 8,
      requireAuditLogging: true
    });

    // Auditor: Read-only access to logs and memory, cannot run live swarms
    this.rolePolicies.set('auditor', {
      allowCheckout: false,
      allowFileDownload: false,
      maxConcurrentTabs: 1,
      requireAuditLogging: true
    });

    // Restricted: Heavily sandboxed
    this.rolePolicies.set('restricted', {
      allowCheckout: false,
      allowFileDownload: false,
      maxConcurrentTabs: 2,
      requireAuditLogging: true,
      allowedDomains: ['google.com', 'wikipedia.org']
    });
  }

  public setUserRole(userId: string, role: UserRole): void {
    this.userRoles.set(userId, role);
  }

  public getUserPolicy(userId: string): EnterprisePolicy {
    const role = this.userRoles.get(userId) || 'operator';
    return this.rolePolicies.get(role)!;
  }

  public isActionAllowed(userId: string, actionType: 'checkout' | 'download' | 'navigate', targetDomain?: string): boolean {
    const policy = this.getUserPolicy(userId);

    // Check domain whitelist
    if (targetDomain && policy.allowedDomains && policy.allowedDomains.length > 0) {
      const match = policy.allowedDomains.some(d => targetDomain === d || targetDomain.endsWith('.' + d));
      if (!match) return false;
    }

    // Check domain blacklist
    if (targetDomain && policy.deniedDomains && policy.deniedDomains.length > 0) {
      const match = policy.deniedDomains.some(d => targetDomain === d || targetDomain.endsWith('.' + d));
      if (match) return false;
    }

    if (actionType === 'checkout' && !policy.allowCheckout) return false;
    if (actionType === 'download' && !policy.allowFileDownload) return false;

    return true;
  }

  public configureSSO(config: SSOConfig): void {
    this.ssoConfig = config;
  }

  public getSSOLoginUrl(state: string): string {
    if (!this.ssoConfig) throw new Error('SSO is not configured');
    const u = new URL(`${this.ssoConfig.issuerUrl}/v1/authorize`);
    u.searchParams.set('client_id', this.ssoConfig.clientId);
    u.searchParams.set('redirect_uri', this.ssoConfig.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', this.ssoConfig.scopes.join(' '));
    u.searchParams.set('state', state);
    return u.toString();
  }
}
