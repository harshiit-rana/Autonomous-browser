import assert from 'node:assert';
import { OmnibarParser } from '../src/ui/omnibar_parser.js';

console.log('--- Testing Milestone M3: Omnibar Intent Routing (Issue #140) ---');

async function runTests() {
  // 1. Direct URLs & Schemes
  const directUrls = [
    'https://news.ycombinator.com',
    'http://example.com',
    'http://example.com/test?query=1&foo=bar',
    'github.com',
    'reddit.com/r/programming',
    'localhost',
    'localhost:3000',
    'localhost:8080/api/v1/health',
    '127.0.0.1',
    '127.0.0.1:8080',
    '192.168.1.1:3000/settings',
    'about:blank',
    'view-source:https://news.ycombinator.com'
  ];

  for (const url of directUrls) {
    const res = OmnibarParser.parse(url);
    assert.strictEqual(res.type, 'url', `Expected ${url} to be classified as 'url'`);
    assert(res.targetUrl !== undefined, `Target URL must be present for ${url}`);
  }
  console.log(`✓ Verified ${directUrls.length} direct URL formats (domains, IPs, localhost, schemes)`);

  // 2. Slash Commands
  const slashCommands = [
    { input: '/do scrape the top 5 articles', cmd: 'do', prompt: 'scrape the top 5 articles' },
    { input: '/swarm compare GPU prices', cmd: 'swarm', prompt: 'compare GPU prices' },
    { input: '/research web agent architectures', cmd: 'research', prompt: 'web agent architectures' },
    { input: '/extract all email addresses from page', cmd: 'extract', prompt: 'all email addresses from page' },
    { input: '/summarize', cmd: 'summarize', prompt: '' }
  ];

  for (const item of slashCommands) {
    const res = OmnibarParser.parse(item.input);
    assert.strictEqual(res.type, 'agent_command');
    assert.strictEqual(res.command, item.cmd);
    assert.strictEqual(res.prompt, item.prompt);
  }
  console.log(`✓ Verified ${slashCommands.length} slash commands (/do, /swarm, /research, /extract, /summarize)`);

  // 3. Natural Language Action Intents
  const actionPrompts = [
    'find the cheapest flight from NYC to Tokyo next Tuesday',
    'extract all product names and prices into a markdown table',
    'compare iPhone 16 Pro and Pixel 9 Pro specs and battery life',
    'monitor the price of this GPU and notify me when under $500',
    'track order status on parcel website',
    'buy the top rated wireless headphones',
    'book a table for two at dinner tonight',
    'summarize key findings of this whitepaper',
    'fill out the survey form with default values',
    'download latest driver for NVIDIA RTX 4090',
    'analyze the page structure and find search input'
  ];

  for (const prompt of actionPrompts) {
    const res = OmnibarParser.parse(prompt);
    assert.strictEqual(res.type, 'agent_command', `Expected "${prompt}" to be classified as agent_command`);
    assert.strictEqual(res.prompt, prompt);
  }
  console.log(`✓ Verified ${actionPrompts.length} imperative action prompts routed to agent`);

  // 4. General Search Queries
  const searchQueries = [
    'weather forecast San Francisco',
    'how to make sourdough bread from scratch',
    'what is quantum computing',
    'taylor swift tour dates 2026',
    'current time in Tokyo'
  ];

  for (const query of searchQueries) {
    const res = OmnibarParser.parse(query, 'https://duckduckgo.com/?q=');
    assert.strictEqual(res.type, 'search', `Expected "${query}" to be classified as search`);
    assert(res.targetUrl?.includes('duckduckgo.com/?q='));
    assert(res.targetUrl?.includes(encodeURIComponent(query)));
  }
  console.log(`✓ Verified ${searchQueries.length} general searches routed to configured search engine`);

  console.log('✓ All Omnibar Parser tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
