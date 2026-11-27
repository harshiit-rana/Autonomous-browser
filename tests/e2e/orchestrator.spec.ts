/**
 * #228 [SWX-02] acceptance in the real Electron app:
 *  - Orchestrator decides single vs swarm (no regex routing) using `submit_plan`
 *  - UI plan preview shows mode badge, justification, editable steps, Switch to Single-Agent toggle, and skipLowRiskPlanPreview setting
 *  - Invalid orchestrator plan after 1 repair cleanly transitions to `failed` with the validation error
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { test, expect } from './fixtures.js';
import { openUrl, startMission, waitForStatus, verifierPasses } from './helpers.js';

test.describe('orchestrator single-agent decision', () => {
  test.use({
    orchestratorScript: {
      build: ({ arenaUrl }) => [{
        expectTools: ['submit_plan'],
        respond: {
          tool: 'submit_plan',
          args: {
            mode: 'single',
            justification: 'A single target page heading lookup does not need multiple workers.',
            stages: [{
              name: 'read',
              parallelism: 1,
              tasks: [{
                id: 't1',
                name: 'Read page heading',
                role: 'researcher',
                goal: 'what is the heading on this page?',
                startUrl: `${arenaUrl}/products`,
                dependsOn: [],
                effectClass: 'read'
              }]
            }]
          }
        }
      }]
    },
    script: {
      build: () => [{
        expectTools: ['done'],
        respond: { tool: 'done', args: { result: 'The heading is Products Catalog.', evidence: ['Products Catalog'] } }
      }]
    },
    verifierScript: {
      build: () => [verifierPasses('Products Catalog')]
    }
  });

  test('routes simple single-page question to mode=single via submit_plan and renders preview badge & justification', async ({ app, arena }) => {
    const { chromePage } = app;
    const goal = 'what is the heading on the arena products page';
    await openUrl(app, `${arena.baseUrl}/products`);
    await chromePage.locator('#omnibar-input').fill(`/do ${goal}`);
    await chromePage.locator('#swarm-run-btn').click();
    await expect(chromePage.locator('#plan-preview-modal')).not.toHaveClass(/hidden/);
    await expect(chromePage.locator('#plan-mode-badge')).toHaveText('SINGLE AGENT');
    await expect(chromePage.locator('#plan-justification-text')).toContainText('single target page heading lookup');
    await chromePage.locator('#execute-plan-btn').click();
    await expect(chromePage.locator('#plan-preview-modal')).toHaveClass(/hidden/);

    const end = await waitForStatus(app, ['completed', 'failed', 'cancelled'], 60_000);
    expect(end.status, end.message).toBe('completed');
    const snap = await app.snapshot();
    // Single-agent mode runs AgentLoop (worker-agent-1 without workerId), never SwarmManager workers
    expect(Object.values(snap.workers).filter(w => w.workerId)).toHaveLength(0);
  });
});

test.describe('orchestrator invalid plan fails cleanly after one repair', () => {
  test.use({
    orchestratorScript: {
      build: () => [
        {
          expectTools: ['submit_plan'],
          respond: { text: 'I refuse to use a tool and wrote plain prose instead.' }
        },
        {
          expectTools: ['submit_plan'],
          respond: {
            tool: 'submit_plan',
            args: {
              mode: 'swarm',
              justification: 'Impossible parallelism',
              stages: [{
                name: 'extract',
                parallelism: 99,
                tasks: [{ id: 't1', name: 'Bad', role: 'extractor', goal: 'Read', dependsOn: [], effectClass: 'read' }]
              }]
            }
          }
        }
      ]
    },
    script: { build: () => [] },
    verifierScript: { build: () => [] }
  });

  test('fails cleanly when orchestrator exhausts single repair turn', async ({ app, arena }) => {
    await openUrl(app, `${arena.baseUrl}/products`);
    const { chromePage } = app;
    await chromePage.locator('#omnibar-input').fill('/do invalid plan mission');
    await chromePage.locator('#swarm-run-btn').click();
    // preview fails cleanly and leaves modal closed with notice in timeline
    await expect(chromePage.locator('#plan-preview-modal')).toHaveClass(/hidden/, { timeout: 15_000 });
    const toast = chromePage.locator('.aegis-toast');
    await expect(toast).toContainText('settings.maxWorkers');
  });
});

test.describe('orchestrator UI preview switch-to-single and skip-low-risk setting', () => {
  test.use({
    orchestratorScript: {
      build: ({ arenaUrl }) => [
        // 1st preview: orchestrator proposes swarm -> user edits & clicks Switch to Single-Agent
        {
          expectTools: ['submit_plan'],
          respond: {
            tool: 'submit_plan',
            args: {
              mode: 'swarm',
              justification: 'Parallel read across catalog pages.',
              stages: [{
                name: 'extract',
                parallelism: 2,
                tasks: [
                  { id: 't1', name: 'Task 1', role: 'extractor', goal: 'Read part 1', startUrl: `${arenaUrl}/products`, dependsOn: [], effectClass: 'read' },
                  { id: 't2', name: 'Task 2', role: 'extractor', goal: 'Read part 2', startUrl: `${arenaUrl}/products`, dependsOn: [], effectClass: 'read' }
                ]
              }]
            }
          }
        },
        // 2nd preview (after enabling skipLowRiskPlanPreview): read-only single skips modal immediately
        {
          expectTools: ['submit_plan'],
          respond: {
            tool: 'submit_plan',
            args: {
              mode: 'single',
              justification: 'Low-risk read lookup.',
              stages: [{
                name: 'read',
                parallelism: 1,
                tasks: [{ id: 's1', name: 'Lookup', role: 'researcher', goal: 'Check page title', startUrl: `${arenaUrl}/products`, dependsOn: [], effectClass: 'read' }]
              }]
            }
          }
        }
      ]
    },
    script: {
      build: () => [
        { expectTools: ['done'], respond: { tool: 'done', args: { result: 'Switched single-agent summary ready.', evidence: ['Products'] } } },
        { expectTools: ['done'], respond: { tool: 'done', args: { result: 'Skipped preview single-agent summary ready.', evidence: ['Products'] } } }
      ]
    },
    verifierScript: {
      build: () => [
        verifierPasses('Switched single-agent summary ready'),
        verifierPasses('Skipped preview single-agent summary ready')
      ]
    }
  });

  test('Switch to Single-Agent converts swarm plan and skipLowRiskPlanPreview bypasses preview on read-only single', async ({ app, arena }) => {
    const { chromePage } = app;
    await openUrl(app, `${arena.baseUrl}/products`);

    // 1. Open preview for swarm plan, toggle Switch to Single-Agent, execute, wait for completion
    await chromePage.locator('#omnibar-input').fill('/do compare across two views');
    await chromePage.locator('#swarm-run-btn').click();
    await expect(chromePage.locator('#plan-preview-modal')).not.toHaveClass(/hidden/);
    await expect(chromePage.locator('#plan-mode-badge')).toHaveText('SWARM');
    await expect(chromePage.locator('#plan-justification-text')).toContainText('Parallel read across catalog pages');
    await chromePage.locator('#switch-single-plan-btn').click();
    await expect(chromePage.locator('#plan-mode-badge')).toHaveText('SINGLE AGENT');
    await chromePage.locator('#execute-plan-btn').click();
    await expect(chromePage.locator('#plan-preview-modal')).toHaveClass(/hidden/);

    const firstEnd = await waitForStatus(app, ['completed', 'failed', 'cancelled'], 60_000);
    expect(firstEnd.status, firstEnd.message).toBe('completed');

    // Capture evidence screenshot if AEGIS_E2E_EVIDENCE_DIR is set
    const evDir = process.env.AEGIS_E2E_EVIDENCE_DIR;
    if (evDir) {
      fs.mkdirSync(evDir, { recursive: true });
      await chromePage.screenshot({ path: path.join(evDir, 'orchestrator-single-complete.png') });
    }

    // 2. Enable skipLowRiskPlanPreview in Settings and run another read-only single mission -> skips modal!
    await chromePage.locator('#settings-btn').click();
    await expect(chromePage.locator('#settings-modal')).not.toHaveClass(/hidden/);
    await chromePage.locator('#settings-skip-low-risk-preview').check();
    await chromePage.locator('#save-settings-btn').click();
    await expect(chromePage.locator('#settings-modal')).toHaveClass(/hidden/);

    await chromePage.locator('#omnibar-input').fill('/do read the catalog title');
    await chromePage.locator('#swarm-run-btn').click();
    // Modal never stays open; mission starts directly and completes
    await expect(chromePage.locator('#plan-preview-modal')).toHaveClass(/hidden/);
    await expect.poll(async () => (await app.snapshot()).statusHistory.filter(s => s.status === 'completed').length, { timeout: 60_000 }).toBe(2);
  });
});
