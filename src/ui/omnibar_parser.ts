/**
 * Project Aegis - Universal Smart Omnibar (Hybrid URL Navigation + Agent Intent Routing)
 * Implements: Issue #140 [MCX-07] Robust URL / Intranet / IP routing, customizable search engine,
 * and natural-language goal vs browse routing.
 */

export interface OmnibarIntent {
  rawInput: string;
  type: 'url' | 'search' | 'agent_command';
  command?: 'swarm' | 'research' | 'extract' | 'mcts' | 'summarize' | 'do';
  targetUrl?: string;
  prompt?: string;
  options?: Record<string, string>;
}

export class OmnibarParser {
  // Matches valid domains, IPs, localhost, intranet hosts with optional port and paths
  private static readonly URL_OR_IP_REGEX = /^(?:https?:\/\/)?(?:(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9_-]+)(?::\d+)?(?:\/[^\s]*)?$/i;

  public static isDirectUrl(input: string): boolean {
    const trimmed = input.trim();
    if (trimmed.includes(' ')) return false;

    // Special schemes
    if (/^(?:https?:\/\/|about:|chrome:|file:\/\/|view-source:)/i.test(trimmed)) {
      return true;
    }

    // Localhost or IPv4 with port or path
    if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:\/.*)?$/i.test(trimmed)) {
      return true;
    }

    // Domain with known extension (e.g. example.com, test.co.uk)
    if (/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(trimmed)) {
      return true;
    }

    return false;
  }

  public static parse(input: string, defaultSearchUrl: string = 'https://duckduckgo.com/?q='): OmnibarIntent {
    const trimmed = input.trim();
    if (!trimmed) {
      return { rawInput: '', type: 'search', prompt: '' };
    }

    // 1. Explicit Agent Slash Commands (/do, /swarm, /research, /extract, /mcts, /summarize)
    if (trimmed.startsWith('/')) {
      const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      if (match) {
        const cmdName = match[1].toLowerCase();
        const rest = (match[2] || '').trim();

        const validCommands: Record<string, OmnibarIntent['command']> = {
          'do': 'do',
          'swarm': 'swarm',
          'research': 'research',
          'extract': 'extract',
          'mcts': 'mcts',
          'summarize': 'summarize'
        };

        if (cmdName in validCommands) {
          return {
            rawInput: trimmed,
            type: 'agent_command',
            command: validCommands[cmdName],
            prompt: rest
          };
        }
      }
    }

    // 2. Direct URL Detection (including IPs, ports, localhost, intranet)
    if (OmnibarParser.isDirectUrl(trimmed)) {
      let url = trimmed;
      if (!/^[a-zA-Z0-9+.-]+:\/\//i.test(url) && !url.startsWith('about:') && !url.startsWith('view-source:')) {
        url = `https://${url}`;
      }
      return {
        rawInput: trimmed,
        type: 'url',
        targetUrl: url
      };
    }

    // 3. Natural Language Agent Prompt vs Web Search
    // Imperative verbs indicating multi-step autonomous browsing tasks
    const isAgentPrompt = /^(find|search for|extract|compare|monitor|track|buy|book|summarize|fill|download|analyze|login to|navigate to|scrape)\b/i.test(trimmed);

    if (isAgentPrompt) {
      return {
        rawInput: trimmed,
        type: 'agent_command',
        command: 'do',
        prompt: trimmed
      };
    }

    // 4. Default to Search Engine
    const searchTarget = `${defaultSearchUrl}${encodeURIComponent(trimmed)}`;
    return {
      rawInput: trimmed,
      type: 'search',
      targetUrl: searchTarget,
      prompt: trimmed
    };
  }
}
