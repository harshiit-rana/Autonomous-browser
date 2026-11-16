import { TableExtractor, ExtractedTable } from '../src/data/table_extractor.js';
import { PaginationCrawler } from '../src/data/pagination_crawler.js';
import { ReportSynthesizer } from '../src/data/report_synthesizer.js';
import { ScrapingDiffEngine } from '../src/data/scraping_diff.js';
import { DataCleanRoomSanitizer } from '../src/data/clean_room.js';
import { ClipboardHub } from '../src/data/clipboard_hub.js';
import { IntentGuard } from '../src/security/intent_guard.js';
import { RedTeamSuite } from '../src/security/red_team_suite.js';
import * as assert from 'node:assert';

function testTableExtraction() {
  console.log('--- Testing TableExtractor ---');
  const mockTable: ExtractedTable = {
    headers: ['Product Name', 'Price', 'Stock'],
    rows: [
      ['NVIDIA RTX 4090', '$1,599', 'In Stock'],
      ['AMD Radeon 7900 XTX', '$999', 'Low Stock']
    ],
    rowCount: 2,
    columnCount: 3
  };

  const csv = TableExtractor.toCSV(mockTable);
  console.log('Generated CSV:\n' + csv);
  assert.strictEqual(csv.includes('NVIDIA RTX 4090,"$1,599",In Stock'), true);

  const json = TableExtractor.toJSON(mockTable);
  assert.strictEqual(json.length, 2);
  assert.strictEqual(json[0]['Product Name'], 'NVIDIA RTX 4090');
  console.log('✓ TableExtractor CSV & JSON conversion verified!\n');
}

function testPaginationIncrement() {
  console.log('--- Testing Pagination URL Increment ---');
  const url1 = 'https://example.com/search?q=laptop&page=1';
  const next1 = PaginationCrawler.incrementUrlPage(url1);
  assert.strictEqual(next1, 'https://example.com/search?q=laptop&page=2');

  const url2 = 'https://news.ycombinator.com/news?p=3';
  const next2 = PaginationCrawler.incrementUrlPage(url2);
  assert.strictEqual(next2, 'https://news.ycombinator.com/news?p=4');
  console.log('✓ Pagination URL increment verified!\n');
}

function testReportSynthesizer() {
  console.log('--- Testing ReportSynthesizer ---');
  const md = ReportSynthesizer.generateMarkdown({
    title: 'Market Analysis: GPU Availability',
    goal: 'Track pricing across retail suppliers',
    sections: [
      {
        title: 'Executive Summary',
        content: 'GPU inventory has improved by 15% month over month.'
      },
      {
        title: 'Pricing Comparison',
        content: 'Detailed price breakdown by vendor:',
        tableData: {
          headers: ['Vendor', 'Price', 'Status'],
          rows: [['BestBuy', '$1,599', 'Available'], ['Newegg', '$1,620', 'Backorder']]
        }
      }
    ],
    sources: [{ title: 'BestBuy GPUs', url: 'https://bestbuy.com/gpu' }]
  });

  assert.strictEqual(md.includes('# Market Analysis: GPU Availability'), true);
  assert.strictEqual(md.includes('| BestBuy | $1,599 | Available |'), true);
  console.log('✓ ReportSynthesizer markdown generation verified!\n');
}

function testScrapingDiff() {
  console.log('--- Testing ScrapingDiffEngine ---');
  const prev = [
    { id: 'item_1', name: 'MacBook Pro 16', price: 2499 },
    { id: 'item_2', name: 'iPad Pro', price: 999 }
  ];
  const curr = [
    { id: 'item_1', name: 'MacBook Pro 16', price: 2299 }, // price drop
    { id: 'item_3', name: 'Mac Mini', price: 599 } // new item
  ];

  const diff = ScrapingDiffEngine.computeDiff(prev, curr);
  assert.strictEqual(diff.added.length, 1);
  assert.strictEqual(diff.added[0].id, 'item_3');
  assert.strictEqual(diff.removed.length, 1);
  assert.strictEqual(diff.removed[0].id, 'item_2');
  assert.strictEqual(diff.modified.length, 1);
  assert.strictEqual(diff.modified[0].changes.price.oldValue, 2499);
  assert.strictEqual(diff.modified[0].changes.price.newValue, 2299);
  console.log('✓ ScrapingDiffEngine price tracking verified!\n');
}

function testCleanRoomAndClipboard() {
  console.log('--- Testing CleanRoom Sanitizer & ClipboardHub ---');
  // Clean room
  const dirtyText = 'User SSN: 123-45-6789 and Card: 4111 2222 3333 4444 and key: sk-ant-api03-abcdef12345678901234567890';
  const clean = DataCleanRoomSanitizer.sanitize(dirtyText);
  assert.strictEqual(clean.sanitizedText.includes('123-45-6789'), false);
  assert.strictEqual(clean.sanitizedText.includes('[REDACTED_SSN]'), true);
  assert.strictEqual(clean.sanitizedText.includes('[REDACTED_CREDIT_CARD]'), true);
  assert.strictEqual(clean.sanitizedText.includes('[REDACTED_API_KEY]'), true);

  // Clipboard hub URL UTM stripping
  const dirtyUrl = 'https://store.com/item?id=99&utm_source=twitter&utm_medium=cpc';
  const cleanUrl = ClipboardHub.analyzeAndClean(dirtyUrl);
  assert.strictEqual(cleanUrl.detectedType, 'url');
  assert.strictEqual(cleanUrl.cleanedText, 'https://store.com/item?id=99');
  console.log('✓ CleanRoom & ClipboardHub verified!\n');
}

function testSecurityAndRedTeam() {
  console.log('--- Testing IntentGuard & RedTeamSuite ---');
  const guard = new IntentGuard();

  // Test Irreversible Action Gate
  const resIrreversible = guard.verifyAction({
    userObjective: 'Check settings',
    proposedAction: { type: 'click', targetText: 'Permanently Delete Account' },
    pageContext: { url: 'https://app.com/settings', title: 'Settings' }
  });
  assert.strictEqual(resIrreversible.allowed, false);
  assert.strictEqual(resIrreversible.requiresUserConfirmation, true);

  // Test Red Team Suite
  const report = RedTeamSuite.runSuite();
  console.log(`Red Team Results: ${report.passedTests}/${report.totalTests} tests passed.`);
  console.log('Results details:', report.results);
  assert.strictEqual(report.passedTests, report.totalTests, 'All red team attacks must be neutralized');
  console.log('✓ RedTeamSuite 100% neutralized!\n');
}

testTableExtraction();
testPaginationIncrement();
testReportSynthesizer();
testScrapingDiff();
testCleanRoomAndClipboard();
testSecurityAndRedTeam();
