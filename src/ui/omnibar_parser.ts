/**
 * Project Aegis - Universal Smart Omnibar (Hybrid URL Navigation + Agent Intent Routing)
 * Implements: Issue #140 [MCX-07] Robust URL / Intranet / IP routing, customizable search engine,
 * and natural-language goal vs browse routing.
 */

import { UrlClassifier } from '../browser/url_classifier.js';

export interface OmnibarIntent {
  rawInput: string;
  type: 'url' | 'search' | 'agent_command';
  command?: 'swarm' | 'research' | 'extract' | 'mcts' | 'summarize' | 'do';
  targetUrl?: string;
  prompt?: string;
  options?: Record<string, string>;
  eTLDPlusOne?: string;
  securityIndicator?: string;
}

export class OmnibarParser {
  private static classifier = new UrlClassifier();

  public static isDirectUrl(input: string): boolean {
    const res = OmnibarParser.classifier.classify(input);
    return res.type === 'url';
  }

  public static parse(input: string, defaultSearchUrl: string = 'https://www.google.com/search?q='): OmnibarIntent {
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

    // 2. Classify via UrlClassifier (IPv4, IPv6, localhost, intranet, schemes, file paths, keywords)
    const classified = OmnibarParser.classifier.classify(trimmed);
    if (classified.type === 'url') {
      return {
        rawInput: trimmed,
        type: 'url',
        targetUrl: classified.targetUrl,
        eTLDPlusOne: classified.eTLDPlusOne,
        securityIndicator: classified.securityIndicator
      };
    }

    // 3. Natural Language Agent Prompt vs Web Search
    // Imperative verbs indicating multi-step autonomous browsing tasks
    const isAgentPrompt = /^(find|search for|extract|compare|monitor|track|buy|book|summarize|fill|download|analyze|login to|navigate to|scrape)\b/i.test(trimmed);

    if (isAgentPrompt) {
      const cmd: OmnibarIntent['command'] = /^(find|search for)\b/i.test(trimmed) ? 'do' : 'swarm';
      return {
        rawInput: trimmed,
        type: 'agent_command',
        command: cmd,
        prompt: trimmed
      };
    }

    // 4. Search Engine (using classified targetUrl which respects !g, !ddg, etc. or fallback defaultSearchUrl)
    const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase();
    const isKeywordSearch = Boolean(firstWord && UrlClassifier.DEFAULT_SEARCH_ENGINES[firstWord]);
    const finalSearchUrl = isKeywordSearch
      ? classified.targetUrl
      : `${defaultSearchUrl}${encodeURIComponent(trimmed)}`;

    return {
      rawInput: trimmed,
      type: 'search',
      targetUrl: finalSearchUrl,
      prompt: trimmed,
      eTLDPlusOne: OmnibarParser.classifier.extractETLDPlusOne(finalSearchUrl),
      securityIndicator: 'secure'
    };
  }
}
