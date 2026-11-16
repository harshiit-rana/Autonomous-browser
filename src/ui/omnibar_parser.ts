/**
 * Project Aegis - Universal Smart Omnibar (Hybrid URL Navigation + Swarm Prompting)
 * 
 * Implements:
 * - Issue #13: M7.1 Universal Smart Omnibar (Hybrid URL Navigation + Swarm Prompting)
 */

export interface OmnibarIntent {
  rawInput: string;
  type: 'url' | 'search' | 'agent_command';
  command?: 'swarm' | 'research' | 'extract' | 'mcts' | 'summarize';
  targetUrl?: string;
  prompt?: string;
  options?: Record<string, string>;
}

export class OmnibarParser {
  private static readonly URL_REGEX = /^(?:https?:\/\/)?(?:(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|localhost)(?::\d+)?(?:\/[^\s]*)?$/i;

  /**
   * Parses user input from the Omnibar into structured intents.
   */
  public static parse(input: string): OmnibarIntent {
    const trimmed = input.trim();
    if (!trimmed) {
      return { rawInput: '', type: 'search', prompt: '' };
    }

    // 1. Explicit Agent Slash Commands (/swarm, /research, /extract, /mcts, /summarize)
    if (trimmed.startsWith('/')) {
      const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      if (match) {
        const cmdName = match[1].toLowerCase();
        const rest = (match[2] || '').trim();

        const validCommands: Record<string, OmnibarIntent['command']> = {
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

    // 2. Direct URL Detection
    if (OmnibarParser.URL_REGEX.test(trimmed) && !trimmed.includes(' ')) {
      let url = trimmed;
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }
      return {
        rawInput: trimmed,
        type: 'url',
        targetUrl: url
      };
    }

    // 3. Natural Language Agent Prompt vs Web Search
    // If input contains imperative action triggers, route to swarm agent
    const isAgentPrompt = /^(find|search for|extract|compare|monitor|track|buy|book|summarize|fill|download)\b/i.test(trimmed);

    if (isAgentPrompt) {
      return {
        rawInput: trimmed,
        type: 'agent_command',
        command: 'swarm',
        prompt: trimmed
      };
    }

    // 4. Default to Web Search
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    return {
      rawInput: trimmed,
      type: 'search',
      targetUrl: searchUrl,
      prompt: trimmed
    };
  }
}
