/**
 * Project Aegis - Robust URL & Address Bar Classifier (Issue #169 - [BRW-02])
 * 
 * Features:
 * - Full WHATWG URL compliance with intelligent address-bar heuristics
 * - Handles IPv4, IPv6 literals ([::1]:8080), localhost, single-label intranet hosts
 * - Windows local paths (C:\...), UNC paths (\\server\share), and special browser schemes
 * - Strips dangerous pasted javascript: code execution attempts
 * - Search engine keyword triggers (!g, !ddg, !b, !w, !yt, !gh) with configurable defaults
 * - eTLD+1 domain extraction for trusted origin display
 * - Security indicator status (secure, insecure, internal, punycode_warning)
 */

export interface ParsedNavigationTarget {
  rawInput: string;
  type: 'url' | 'search' | 'blocked_protocol';
  targetUrl: string;
  displayUrl: string;
  eTLDPlusOne: string;
  searchEngine?: string;
  searchQuery?: string;
  securityIndicator: 'secure' | 'insecure' | 'internal' | 'error' | 'punycode_warning';
  warningMessage?: string;
}

export interface SearchEnginePreset {
  keyword: string;
  name: string;
  urlTemplate: string; // expects %s for query
}

export class UrlClassifier {
  public static readonly DEFAULT_SEARCH_ENGINES: Record<string, SearchEnginePreset> = {
    '!ddg': { keyword: '!ddg', name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s' },
    '!g': { keyword: '!g', name: 'Google', urlTemplate: 'https://www.google.com/search?q=%s' },
    '!b': { keyword: '!b', name: 'Bing', urlTemplate: 'https://www.bing.com/search?q=%s' },
    '!w': { keyword: '!w', name: 'Wikipedia', urlTemplate: 'https://en.wikipedia.org/wiki/Special:Search?search=%s' },
    '!yt': { keyword: '!yt', name: 'YouTube', urlTemplate: 'https://www.youtube.com/results?search_query=%s' },
    '!gh': { keyword: '!gh', name: 'GitHub', urlTemplate: 'https://github.com/search?q=%s' }
  };

  private defaultSearchEngine: SearchEnginePreset;

  constructor(defaultSearchEngineKey: string = '!ddg') {
    this.defaultSearchEngine = UrlClassifier.DEFAULT_SEARCH_ENGINES[defaultSearchEngineKey] || UrlClassifier.DEFAULT_SEARCH_ENGINES['!ddg'];
  }

  /**
   * Classifies user input into either a direct navigation target or search query
   */
  public classify(input: string): ParsedNavigationTarget {
    const raw = (input || '').trim();
    if (!raw) {
      return {
        rawInput: '',
        type: 'search',
        targetUrl: this.defaultSearchEngine.urlTemplate.replace('%s', ''),
        displayUrl: '',
        eTLDPlusOne: '',
        securityIndicator: 'internal'
      };
    }

    // 1. Strip and deny direct javascript: pasted code execution
    if (/^javascript:/i.test(raw)) {
      return {
        rawInput: raw,
        type: 'blocked_protocol',
        targetUrl: 'about:blank',
        displayUrl: 'about:blank',
        eTLDPlusOne: '',
        securityIndicator: 'error',
        warningMessage: 'Execution of pasted javascript: code in the address bar is blocked for security.'
      };
    }

    // 2. Check for search engine keyword shortcuts (!g, !ddg, etc.)
    const firstWord = raw.split(/\s+/)[0]?.toLowerCase();
    if (firstWord && UrlClassifier.DEFAULT_SEARCH_ENGINES[firstWord]) {
      const engine = UrlClassifier.DEFAULT_SEARCH_ENGINES[firstWord];
      const query = raw.substring(firstWord.length).trim();
      const targetUrl = engine.urlTemplate.replace('%s', encodeURIComponent(query));
      return {
        rawInput: raw,
        type: 'search',
        targetUrl,
        displayUrl: `${engine.name} Search: ${query}`,
        eTLDPlusOne: this.extractETLDPlusOne(targetUrl),
        searchEngine: engine.name,
        searchQuery: query,
        securityIndicator: 'secure'
      };
    }

    // 3. Windows local paths & UNC paths
    if (/^[a-zA-Z]:[/\\]/.test(raw)) {
      const normalized = 'file:///' + raw.replace(/\\/g, '/');
      return {
        rawInput: raw,
        type: 'url',
        targetUrl: normalized,
        displayUrl: raw,
        eTLDPlusOne: 'local-file',
        securityIndicator: 'internal'
      };
    }

    if (/^\\\\[a-zA-Z0-9._-]+\\[a-zA-Z0-9._$-]+/.test(raw)) {
      const normalized = 'file://' + raw.replace(/\\/g, '/');
      return {
        rawInput: raw,
        type: 'url',
        targetUrl: normalized,
        displayUrl: raw,
        eTLDPlusOne: 'network-share',
        securityIndicator: 'internal'
      };
    }

    // 4. Special internal schemes (about:, chrome:, view-source:)
    if (/^(?:about:|chrome:|view-source:)/i.test(raw)) {
      return {
        rawInput: raw,
        type: 'url',
        targetUrl: raw,
        displayUrl: raw,
        eTLDPlusOne: 'internal',
        securityIndicator: 'internal'
      };
    }

    // 5. Explicit protocol (http://, https://, file://, ftp://)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
      return this.formatUrlResult(raw, raw);
    }

    // 6. Check if input is a direct host (domain, IP, IPv6, localhost, intranet) without protocol
    if (this.isDirectHostOrUrl(raw)) {
      const withHttps = `https://${raw}`;
      return this.formatUrlResult(raw, withHttps);
    }

    // 7. Otherwise, fallback to default web search
    const query = raw;
    const targetUrl = this.defaultSearchEngine.urlTemplate.replace('%s', encodeURIComponent(query));
    return {
      rawInput: raw,
      type: 'search',
      targetUrl,
      displayUrl: `${this.defaultSearchEngine.name} Search: ${query}`,
      eTLDPlusOne: this.extractETLDPlusOne(targetUrl),
      searchEngine: this.defaultSearchEngine.name,
      searchQuery: query,
      securityIndicator: 'secure'
    };
  }

  private isDirectHostOrUrl(input: string): boolean {
    // If it contains spaces, it's a search query
    if (/\s/.test(input)) return false;

    // IPv6 literal with or without port: [::1] or [::1]:8080
    if (/^\[[0-9a-fA-F:]+\](?::\d+)?(?:\/.*)?$/.test(input)) {
      return true;
    }

    // IPv4 address with optional port and path
    if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(input)) {
      return true;
    }

    // Localhost with optional port and path
    if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(input)) {
      return true;
    }

    // Domain name with known TLD (e.g. google.com, example.org, api.domain.co.uk)
    if (/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d+)?(?:\/.*)?$/.test(input)) {
      return true;
    }

    // Intranet host with explicit port (e.g. wiki:8080, jira:8000)
    if (/^[a-zA-Z0-9_-]+:\d+(?:\/.*)?$/.test(input)) {
      return true;
    }

    return false;
  }

  private formatUrlResult(rawInput: string, finalUrl: string): ParsedNavigationTarget {
    try {
      const parsed = new URL(finalUrl);
      const isHttps = parsed.protocol === 'https:';
      const isHttp = parsed.protocol === 'http:';
      const isInternal = parsed.protocol === 'file:' || parsed.protocol === 'about:' || parsed.protocol === 'chrome:';

      let securityIndicator: ParsedNavigationTarget['securityIndicator'] = isHttps ? 'secure' : (isInternal ? 'internal' : 'insecure');
      let warningMessage: string | undefined = undefined;

      // Punycode / IDN homograph warning
      if (parsed.hostname.startsWith('xn--') || /[^\u0020-\u007E]/.test(parsed.hostname)) {
        securityIndicator = 'punycode_warning';
        warningMessage = 'Potential IDN homograph character detected in domain name.';
      }

      return {
        rawInput,
        type: 'url',
        targetUrl: finalUrl,
        displayUrl: parsed.href,
        eTLDPlusOne: this.extractETLDPlusOne(parsed.hostname),
        securityIndicator,
        warningMessage
      };
    } catch {
      return {
        rawInput,
        type: 'search',
        targetUrl: this.defaultSearchEngine.urlTemplate.replace('%s', encodeURIComponent(rawInput)),
        displayUrl: rawInput,
        eTLDPlusOne: '',
        securityIndicator: 'error'
      };
    }
  }

  public extractETLDPlusOne(hostOrUrl: string): string {
    let hostname = hostOrUrl;
    try {
      if (hostOrUrl.includes('://')) {
        hostname = new URL(hostOrUrl).hostname;
      }
    } catch {}

    const parts = hostname.toLowerCase().split('.');
    if (parts.length <= 2) {
      return hostname;
    }

    // Common two-level TLDs (co.uk, com.au, org.uk, etc.)
    const twoLevelTLDs = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'org.uk', 'gov.uk'];
    const lastTwo = parts.slice(-2).join('.');
    if (twoLevelTLDs.includes(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }

    return parts.slice(-2).join('.');
  }
}
