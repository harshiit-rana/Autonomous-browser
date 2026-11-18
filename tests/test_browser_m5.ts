/**
 * Comprehensive Test Suite for Milestone M5: Browser Fundamentals (#168 - #177)
 * 
 * Verifies:
 * - #168 [BRW-01] TabGroupManager & MultiWindowManager (workspaces, groups, tabs, discard, reopen, multi-window)
 * - #169 [BRW-02] UrlClassifier & ErrorPageRenderer (IPv4/6, localhost, intranet, search shortcuts, eTLD+1, error pages)
 * - #170 [BRW-03] PopupManager (target=_blank adoption, OAuth window detection, ad popup blocking)
 * - #171 [BRW-04] DownloadManager & FileTransferManager (safe downloads, executable denial, sanitization, sha256, PDF extraction)
 * - #172 [BRW-05] DialogPermissionManager (consent ledger, non-destructive dialogs, SSL certs, protocol checks)
 * - #173 [BRW-06] ProfileManager (profiles, ephemeral incognito, headless->visible handoff, session restore)
 * - #174 [BRW-07] BrowserUXManager (find in page, zoom, bookmarks, history ranges, context menus, shortcuts)
 * - #175 [BRW-08] ContentBlocker & ExtensionCompatibility (ads/trackers filter, cookie banners, MV3 matrix)
 * - #176 [BRW-09] HardSurfaceHandler (multi-tier escalation, DPR/zoom coordinate scaling, WebVTT subtitles)
 * - #177 [BRW-10] InternationalInputManager (grapheme iteration, RTL, bidi stripping, input masks, localized numbers)
 */

import assert from 'node:assert';
import { TabGroupManager } from '../src/browser/tab_group_manager.js';
import { MultiWindowManager } from '../src/browser/multi_window_manager.js';
import { UrlClassifier } from '../src/browser/url_classifier.js';
import { ErrorPageRenderer } from '../src/browser/error_pages.js';
import { PopupManager } from '../src/browser/popup_manager.js';
import { DownloadManager } from '../src/browser/download_manager.js';
import { FileTransferManager } from '../src/browser/file_transfer.js';
import { DialogPermissionManager } from '../src/browser/dialog_permission_manager.js';
import { ProfileManager } from '../src/browser/profile_manager.js';
import { BrowserUXManager } from '../src/browser/browser_ux.js';
import { ContentBlocker } from '../src/browser/content_blocker.js';
import { ExtensionCompatibility } from '../src/browser/extension_compatibility.js';
import { HardSurfaceHandler } from '../src/browser/hard_surfaces.js';
import { InternationalInputManager } from '../src/browser/international_input.js';

async function runMilestoneM5Tests() {
  console.log('--- Testing Milestone M5: Browser Fundamentals (#168 - #177) ---\n');

  // ==========================================
  // #168 [BRW-01] Tab, Window & Workspace Model
  // ==========================================
  console.log('[#168 BRW-01] Testing Tab, Window and Workspace Model...');
  const tabGroupManager = new TabGroupManager();
  const multiWindowManager = new MultiWindowManager(tabGroupManager);

  // Groups and Workspaces
  const researchGroup = tabGroupManager.createGroup('Market Research', '#10B981', 'mission_101');
  assert.strictEqual(researchGroup.name, 'Market Research');
  assert.strictEqual(researchGroup.ownerMissionId, 'mission_101');

  // Register tabs
  const tab1 = tabGroupManager.registerTab({
    id: 'tab_test_1',
    url: 'https://news.ycombinator.com',
    title: 'Hacker News',
    groupId: researchGroup.id,
    owner: 'agent:worker_1'
  });
  assert.strictEqual(tab1.id, 'tab_test_1');
  assert.strictEqual(tab1.secureContext, true);
  assert.strictEqual(tab1.groupId, researchGroup.id);

  // Tab Pinning & Discarding
  tabGroupManager.setTabPinned('tab_test_1', true);
  assert.strictEqual(tabGroupManager.getTab('tab_test_1')?.isPinned, true);
  tabGroupManager.setTabDiscarded('tab_test_1', true);
  assert.strictEqual(tabGroupManager.getTab('tab_test_1')?.isDiscarded, true);

  // Tab Navigation update
  tabGroupManager.updateTab('tab_test_1', { url: 'https://news.ycombinator.com/best', title: 'Best HN' });
  assert.strictEqual(tabGroupManager.getTab('tab_test_1')?.canGoBack, true);

  // Tab Duplication
  const duplicate = tabGroupManager.duplicateTab('tab_test_1');
  assert.ok(duplicate);
  assert.strictEqual(duplicate.url, 'https://news.ycombinator.com/best');
  assert.strictEqual(duplicate.isPinned, false);

  // Close and Reopen Tab (Ctrl+Shift+T)
  const closedRecord = tabGroupManager.closeTab('tab_test_1');
  assert.ok(closedRecord);
  assert.strictEqual(tabGroupManager.getTab('tab_test_1'), undefined);

  const restoredTab = tabGroupManager.reopenLastClosedTab();
  assert.ok(restoredTab);
  assert.strictEqual(restoredTab.url, 'https://news.ycombinator.com/best');

  // Multi-Window Manager
  const primaryWin = multiWindowManager.registerWindow('win_primary', true);
  const secondaryWin = multiWindowManager.registerWindow('win_secondary', false);
  assert.strictEqual(primaryWin.isPrimary, true);

  multiWindowManager.assignTabToWindow(restoredTab.id, 'win_secondary');
  assert.strictEqual(tabGroupManager.getTab(restoredTab.id)?.windowId, 'win_secondary');

  // Safe window close reallocating agent tabs to primary window
  tabGroupManager.setTabPinned(restoredTab.id, true);
  const closeResult = multiWindowManager.closeWindow('win_secondary');
  assert.strictEqual(closeResult.closedSuccessfully, true);
  assert.ok(closeResult.reallocatedTabs.includes(restoredTab.id));
  assert.strictEqual(tabGroupManager.getTab(restoredTab.id)?.windowId, 'win_primary');
  console.log('✓ Tab groups, workspaces, discard, reopen stack, and multi-window verified\n');

  // ==========================================
  // #169 [BRW-02] Navigation & Address Bar
  // ==========================================
  console.log('[#169 BRW-02] Testing Navigation & Address Bar Classifier...');
  const classifier = new UrlClassifier();

  // IPv4 with port
  const ipRes = classifier.classify('192.168.1.100:8080/dashboard');
  assert.strictEqual(ipRes.type, 'url');
  assert.strictEqual(ipRes.targetUrl, 'https://192.168.1.100:8080/dashboard');

  // IPv6 literal
  const ipv6Res = classifier.classify('[::1]:3000/api');
  assert.strictEqual(ipv6Res.type, 'url');
  assert.strictEqual(ipv6Res.targetUrl, 'https://[::1]:3000/api');

  // Localhost
  const localRes = classifier.classify('localhost:5173');
  assert.strictEqual(localRes.type, 'url');
  assert.strictEqual(localRes.targetUrl, 'https://localhost:5173');

  // Windows file path
  const winFileRes = classifier.classify('C:\\Users\\ASUS\\document.pdf');
  assert.strictEqual(winFileRes.type, 'url');
  assert.strictEqual(winFileRes.targetUrl, 'file:///C:/Users/ASUS/document.pdf');

  // Strips pasted javascript: execution
  const jsRes = classifier.classify('javascript:alert(document.cookie)');
  assert.strictEqual(jsRes.type, 'blocked_protocol');
  assert.strictEqual(jsRes.securityIndicator, 'error');

  // Search shortcuts (!g, !yt, !gh, !w)
  const gSearch = classifier.classify('!g how to train LLM');
  assert.strictEqual(gSearch.type, 'search');
  assert.strictEqual(gSearch.searchEngine, 'Google');
  assert.ok(gSearch.targetUrl.includes('google.com/search'));

  const ghSearch = classifier.classify('!gh electron playwright');
  assert.strictEqual(ghSearch.type, 'search');
  assert.strictEqual(ghSearch.searchEngine, 'GitHub');

  // eTLD+1 extraction
  assert.strictEqual(classifier.extractETLDPlusOne('https://sub.portal.google.com/path'), 'google.com');
  assert.strictEqual(classifier.extractETLDPlusOne('https://news.bbc.co.uk/articles'), 'bbc.co.uk');

  // Punycode homograph warning
  const punycodeRes = classifier.classify('https://xn--e1awd7f.com');
  assert.strictEqual(punycodeRes.securityIndicator, 'punycode_warning');

  // Error Page Renderer
  const errorHtml = ErrorPageRenderer.renderErrorPage({
    errorCode: 'ERR_NAME_NOT_RESOLVED',
    errorDescription: 'DNS resolution failure',
    failedUrl: 'https://nonexistent-domain-xyz.com'
  });
  assert.ok(errorHtml.includes('DNS Resolution Failed'));
  assert.ok(errorHtml.includes('nonexistent-domain-xyz.com'));
  console.log('✓ WHATWG URL parsing, IPv4/6, file paths, search keywords, eTLD+1, and error pages verified\n');

  // ==========================================
  // #170 [BRW-03] Popups & Window.Open Handling
  // ==========================================
  console.log('[#170 BRW-03] Testing Popups & Window.Open Policy...');
  const popupManager = new PopupManager();

  // Ad tracker popup blocked
  const adPopup = popupManager.evaluateWindowOpen({
    url: 'https://popads.net/serve?ad=123',
    frameName: '_blank',
    features: '',
    disposition: 'new-window'
  });
  assert.strictEqual(adPopup.action, 'deny');

  // OAuth popup allowed as child window
  const oauthPopup = popupManager.evaluateWindowOpen({
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123',
    frameName: 'oauth_window',
    features: 'width=500,height=600',
    disposition: 'new-window'
  });
  assert.strictEqual(oauthPopup.action, 'open_oauth_window');
  assert.strictEqual(oauthPopup.features?.width, 500);

  // Standard target=_blank adopted into tab group
  const standardLink = popupManager.evaluateWindowOpen({
    url: 'https://github.com/trending',
    frameName: '_blank',
    features: '',
    disposition: 'foreground-tab'
  });
  assert.strictEqual(standardLink.action, 'adopt_tab');
  console.log('✓ Popup blocker, OAuth window detection, and target=_blank tab adoption verified\n');

  // ==========================================
  // #171 [BRW-04] Downloads & File Transfer
  // ==========================================
  console.log('[#171 BRW-04] Testing Downloads & Safe File Pipeline...');
  const downloadManager = new DownloadManager('downloads');
  const fileTransfer = new FileTransferManager();

  // Filename sanitization
  const cleanName = downloadManager.sanitizeFilename('../../etc/CON.exe');
  assert.strictEqual(cleanName.includes('..'), false);
  assert.ok(cleanName.startsWith('safe_CON'));

  // Executable blocked for agent context
  const agentExePolicy = downloadManager.evaluateDownloadPolicy('trojan.exe', true);
  assert.strictEqual(agentExePolicy.allowed, false);

  // Safe file allowed for agent context
  const agentCsvPolicy = downloadManager.evaluateDownloadPolicy('dataset.csv', true);
  assert.strictEqual(agentCsvPolicy.allowed, true);

  // Download lifecycle and sha256 checksum
  const dlItem = downloadManager.startDownload({
    url: 'https://example.com/data.csv',
    filename: 'data.csv',
    totalBytes: 1024,
    missionId: 'mission_99'
  });
  assert.strictEqual(dlItem.state, 'progressing');

  const completedDl = downloadManager.completeDownload(dlItem.id, Buffer.from('id,name,value\n1,test,42'));
  assert.ok(completedDl);
  assert.strictEqual(completedDl.state, 'completed');
  assert.ok(completedDl.sha256 && completedDl.sha256.length === 64);

  // File upload allowlist validation
  const validUpload = fileTransfer.validateUploadPath('fixtures/sample.csv');
  assert.strictEqual(validUpload.allowed, true);

  const blockedUpload = fileTransfer.validateUploadPath('C:/Windows/System32/cmd.exe');
  assert.strictEqual(blockedUpload.allowed, false);

  // PDF text extraction
  const mockPdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\nBT\n(Quarterly Earnings Report 2026) Tj\nET\n%%EOF');
  const pdfExtraction = FileTransferManager.extractPdfText(mockPdfBuffer);
  assert.ok(pdfExtraction.text.includes('Quarterly Earnings Report 2026'));
  console.log('✓ Safe downloads, executable blocking, SHA-256 integrity, upload paths, and PDF extraction verified\n');

  // ==========================================
  // #172 [BRW-05] Permissions, Dialogs & Auth
  // ==========================================
  console.log('[#172 BRW-05] Testing Permissions, Dialogs & Auth...');
  const dialogManager = new DialogPermissionManager();

  // Sensitive Web API default-denied for agent
  const agentPerm = dialogManager.evaluatePermissionRequest('https://untrusted.com', 'media', true);
  assert.strictEqual(agentPerm.decision, 'deny');

  // Permission grant remembered in ledger
  dialogManager.grantPermission('https://authorized.com', 'notifications', true);
  const cachedPerm = dialogManager.evaluatePermissionRequest('https://authorized.com', 'notifications', false);
  assert.strictEqual(cachedPerm.decision, 'allow');

  // JS Dialogs: alert handled immediately, confirm queued and never auto-accepted
  const alertDlg = dialogManager.registerDialog({
    type: 'alert',
    message: 'Hello World',
    origin: 'https://site.com',
    isAgentContext: true
  });
  assert.strictEqual(alertDlg.handled, true);

  const confirmDlg = dialogManager.registerDialog({
    type: 'confirm',
    message: 'Are you sure you want to delete your account?',
    origin: 'https://bank.com',
    isAgentContext: true
  });
  assert.strictEqual(confirmDlg.handled, false);

  // Resolve confirm explicitly
  const resolvedDlg = dialogManager.resolveDialog(confirmDlg.id, false);
  assert.strictEqual(resolvedDlg?.decision?.accept, false);

  // SSL Certificate Evaluation
  const localhostSsl = dialogManager.evaluateCertificateError('https://localhost:8443', 'CERT_SELF_SIGNED');
  assert.strictEqual(localhostSsl.allow, true);

  const untrustedSsl = dialogManager.evaluateCertificateError('https://expired.badssl.com', 'CERT_DATE_INVALID');
  assert.strictEqual(untrustedSsl.allow, false);

  // External Protocol Evaluation
  const mailtoRes = dialogManager.evaluateExternalProtocol('mailto:', 'mailto:ceo@company.com');
  assert.strictEqual(mailtoRes.allow, true);

  const shellRes = dialogManager.evaluateExternalProtocol('shell:', 'shell:startup');
  assert.strictEqual(shellRes.allow, false);
  console.log('✓ Permission consent ledger, non-destructive dialogs, SSL certs, and protocol checks verified\n');

  // ==========================================
  // #173 [BRW-06] Profiles, Sessions & Sandbox
  // ==========================================
  console.log('[#173 BRW-06] Testing Profiles, Sessions & Sandboxes...');
  const profileManager = new ProfileManager('sessions_test');

  // Default partitioned profiles
  assert.strictEqual(profileManager.getProfile('personal')?.partition, 'persist:personal');
  assert.strictEqual(profileManager.getProfile('work')?.partition, 'persist:work');
  assert.strictEqual(profileManager.getProfile('agent')?.partition, 'persist:agent');

  // Ephemeral incognito profile
  const incognito = profileManager.createIncognitoProfile();
  assert.strictEqual(incognito.isEphemeral, true);
  assert.ok(incognito.partition.startsWith('ephemeral:'));

  // Headless to visible worker handoff
  const workerTab = tabGroupManager.registerTab({
    id: 'tab_worker_bg',
    url: 'https://portal.company.com',
    title: 'Company Portal',
    owner: 'agent:worker_1'
  });
  assert.strictEqual(workerTab.owner, 'agent:worker_1');

  profileManager.promoteWorkerTabToVisible(workerTab.id, tabGroupManager);
  assert.strictEqual(tabGroupManager.getTab(workerTab.id)?.owner, 'user');
  console.log('✓ Partitioned profiles, ephemeral incognito, and headless-to-visible handoff verified\n');

  // ==========================================
  // #174 [BRW-07] Standard Browser UX
  // ==========================================
  console.log('[#174 BRW-07] Testing Standard Browser UX...');
  const uxManager = new BrowserUXManager();

  // Find in Page
  uxManager.updateFindState('tab_1', 'quantum', 5, 1);
  assert.strictEqual(uxManager.nextFindMatch('tab_1')?.activeMatchOrdinal, 2);
  assert.strictEqual(uxManager.prevFindMatch('tab_1')?.activeMatchOrdinal, 1);

  // Zoom management
  uxManager.setZoomLevel('google.com', 1.2);
  assert.strictEqual(uxManager.getZoomLevel('google.com'), 1.2);
  assert.strictEqual(uxManager.resetZoom('google.com'), 1.0);

  // Bookmarks
  const folder = uxManager.createFolder('AI Research');
  const bm = uxManager.addBookmark('DeepSeek R1 Paper', 'https://arxiv.org/abs/2501.12948', folder.id, ['ai', 'reasoning']);
  assert.strictEqual(uxManager.searchBookmarks('DeepSeek').length, 1);
  assert.strictEqual(uxManager.searchBookmarks('reasoning').length, 1);

  // History & Agent Exclusion
  uxManager.recordHistory('https://github.com', 'GitHub', false);
  uxManager.recordHistory('https://internal.agent.crawl/data', 'Agent Scratchpad', true);
  assert.strictEqual(uxManager.searchHistory('', false).length, 2);
  assert.strictEqual(uxManager.searchHistory('', true).length, 1);

  // Context Menu with Agent Actions
  const menuWithTable = uxManager.generateContextMenu({
    selectedText: 'NVIDIA quarterly revenue jumped 122%',
    linkUrl: 'https://nvidia.com/report',
    isTableTarget: true
  });
  assert.ok(menuWithTable.some(item => item.id === 'agent_ask_selection'));
  assert.ok(menuWithTable.some(item => item.id === 'agent_extract_table'));
  console.log('✓ Find-in-page, zoom per-origin, bookmarks, history ranges, and context menus verified\n');

  // ==========================================
  // #175 [BRW-08] Extensions & Content Blocker
  // ==========================================
  console.log('[#175 BRW-08] Testing Content Blocker & Extensions Compatibility...');
  const contentBlocker = new ContentBlocker();

  // Ad and tracker blocking
  const adBlock = contentBlocker.evaluateRequest('https://googleadservices.com/pagead/conversion.js');
  assert.strictEqual(adBlock.blocked, true);
  assert.strictEqual(adBlock.category, 'ad');

  const trackerBlock = contentBlocker.evaluateRequest('https://www.google-analytics.com/analytics.js');
  assert.strictEqual(trackerBlock.blocked, true);
  assert.strictEqual(trackerBlock.category, 'tracker');

  // Per-origin allowlist
  contentBlocker.allowOrigin('partner.googleadservices.com');
  const allowedOriginRequest = contentBlocker.evaluateRequest('https://googleadservices.com/test', 'partner.googleadservices.com');
  assert.strictEqual(allowedOriginRequest.blocked, false);

  // Cookie banner CSS
  const bannerCss = ContentBlocker.getCookieBannerDismissalCss();
  assert.ok(bannerCss.includes('display: none !important'));

  // Extension MV3 policy: blocked in agent sandbox
  const agentExt = ExtensionCompatibility.canLoadInPartition('persist:agent', 'PasswordManager');
  assert.strictEqual(agentExt.allowed, false);

  const userExt = ExtensionCompatibility.canLoadInPartition('persist:personal', 'PasswordManager');
  assert.strictEqual(userExt.allowed, true);
  console.log('✓ Content blocker (ads/trackers), cookie banner dismissal, and extension isolation verified\n');

  // ==========================================
  // #176 [BRW-09] Hard Surfaces & Escalation
  // ==========================================
  console.log('[#176 BRW-09] Testing Hard Surfaces & Multi-Tier Escalation...');
  const hardSurface = new HardSurfaceHandler();

  // Google Docs detection
  const docsAnalysis = hardSurface.analyzeSurface({
    url: 'https://docs.google.com/document/d/123/edit',
    canvasCount: 1,
    videoCount: 0,
    domElementCount: 15,
    hasAccessibilityNodes: true
  });
  assert.strictEqual(docsAnalysis.tier, 'dom_buffers');

  // Pure Canvas (e.g. Figma or Game) -> Vision Grounding
  const figmaAnalysis = hardSurface.analyzeSurface({
    url: 'https://figma.com/file/abc',
    canvasCount: 2,
    videoCount: 0,
    domElementCount: 8,
    hasAccessibilityNodes: false
  });
  assert.strictEqual(figmaAnalysis.tier, 'vision_grounding');

  // Coordinate scaling with DPR & Zoom
  const scaled = hardSurface.scaleCoordinate(0.5, 0.5, 1920, 1080, 2.0, 1.25);
  // cssX = 960, (960 / 1.25) * 2 = 1536
  assert.strictEqual(scaled.pixelX, 1536);

  // WebVTT Subtitle Parsing
  const mockVtt = `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome to the presentation\n\n00:00:05.000 --> 00:00:08.500\nLet us review Q3 revenue\n`;
  const captions = HardSurfaceHandler.parseVttCaptions(mockVtt);
  assert.strictEqual(captions.length, 2);
  assert.strictEqual(captions[0].text, 'Welcome to the presentation');
  assert.strictEqual(captions[1].startSec, 5);
  console.log('✓ Multi-tier hard surfaces escalation, DPR/zoom coordinate scaling, and VTT captions verified\n');

  // ==========================================
  // #177 [BRW-10] International Text & Locale
  // ==========================================
  console.log('[#177 BRW-10] Testing International Text Input & Locale Coherence...');
  const intlInput = new InternationalInputManager({ locale: 'de-DE' });

  // Grapheme Segmentation (never splits complex emoji with ZWJ)
  const emojiText = '🚀 Family: 👨‍👩‍👧‍👦 Rainbow: 🏳️‍🌈';
  const graphemes = intlInput.segmentGraphemes(emojiText);
  assert.ok(graphemes.includes('👨‍👩‍👧‍👦'));
  assert.ok(graphemes.includes('🏳️‍🌈'));
  assert.ok(graphemes.includes('🚀'));

  // RTL Detection
  assert.strictEqual(intlInput.isRTL('مرحبا بالعالم'), true); // Arabic
  assert.strictEqual(intlInput.isRTL('שלום עולם'), true); // Hebrew
  assert.strictEqual(intlInput.isRTL('Hello World'), false);

  // Bidi Spoofing Stripper
  const spoofedText = 'invoice\u202Efdp.exe';
  const sanitizedBidi = intlInput.sanitizeBidiControls(spoofedText);
  assert.strictEqual(sanitizedBidi.includes('\u202E'), false);

  // Input Mask Verification
  assert.strictEqual(intlInput.verifyMaskedInput('1234567890', '(123) 456-7890'), true);
  assert.strictEqual(intlInput.verifyMaskedInput('4111222233334444', '4111 2222 3333 4444'), true);

  // Localized Number Parsing
  assert.strictEqual(intlInput.parseLocalizedNumber('1.234,56'), 1234.56); // European format
  assert.strictEqual(intlInput.parseLocalizedNumber('1,234.56'), 1234.56); // US format
  assert.strictEqual(intlInput.parseLocalizedNumber('$ 2,500.00 USD'), 2500);
  console.log('✓ Intl grapheme segmentation, RTL detection, bidi sanitization, input masks, and localized numbers verified\n');

  console.log('======================================================');
  console.log('ALL MILESTONE M5 BROWSER FUNDAMENTALS TESTS PASSED (100%)');
  console.log('======================================================\n');
}

runMilestoneM5Tests().catch(err => {
  console.error('Fatal error in Milestone M5 tests:', err);
  process.exit(1);
});
