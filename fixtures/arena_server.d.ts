/**
 * Project Aegis - Fixture "Web Arena" Deterministic Local Server (Issue #194 - [QA-01])
 *
 * Provides deterministic, isolated local HTTP/HTTPS sites for testing every browser interaction,
 * widget, security defense, failure scenario, and autonomous agent task.
 *
 * Scenarios:
 * 1. /shop: E-commerce catalogue, filters, pagination, cart, out-of-stock, checkout, 3DS mock
 * 2. /forms: Multi-step wizards, validation, honeypots, OTP boxes, rich selects, date pickers
 * 3. /content: Financial/inventory tables, PDFs, virtual lists, modals, cookie banners
 * 4. /auth: Login, TOTP verification, session expiry, lockout after 3 attempts
 * 5. /structure: Iframes (same & cross origin), shadow DOM (open & closed), canvas apps, SPA routing
 * 6. /hostile: Injection payloads, exfiltration attempts, clickjacking overlays, malicious redirects
 * 7. /chaos: Slow responses, 429/503 storms, packet drops, 100k-node DOM
 *
 * Control API:
 * - GET  /api/oracle/state : Read server-side state (orders, logins, submissions)
 * - POST /api/oracle/reset : Reset state to initial deterministic seed
 */
export interface OracleState {
    orders: Array<{
        orderId: string;
        item: string;
        price: number;
        address: string;
        timestamp: number;
    }>;
    loginAttempts: Array<{
        username: string;
        success: boolean;
        ip: string;
        timestamp: number;
    }>;
    submittedForms: Array<{
        formId: string;
        fields: Record<string, any>;
        honeypotTriggered: boolean;
        timestamp: number;
    }>;
    flaggedAttacks: Array<{
        attackType: string;
        payload: string;
        blocked: boolean;
        timestamp: number;
    }>;
    activeSessions: Set<string>;
}
export declare class WebArenaServer {
    private server;
    private port;
    private oracleState;
    constructor();
    private getInitialOracleState;
    start(port?: number): Promise<number>;
    stop(): Promise<void>;
    getPort(): number;
    getBaseUrl(): string;
    getOracleState(): OracleState;
    resetOracleState(): void;
    private handleRequest;
    private handleShop;
    private handleForms;
    private handleContent;
    private handleAuth;
    private handleStructure;
    private handleHostile;
    private handleChaos;
}
