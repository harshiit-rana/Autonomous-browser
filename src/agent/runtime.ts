import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ViewManager, TabView } from '../main/view_manager.js';
import { ModelProviderFactory } from '../models/provider_factory.js';
import { IModelProvider, CanonicalMessage, ContentBlock } from '../models/types.js';
import { PerceptionEngine, PageSnapshot } from './perception.js';
import { BROWSER_TOOLS, ToolExecutor, ToolExecutionResult } from './tools.js';
import { ActionTaxonomy } from './errors.js';
import { IPC_CHANNELS, WorkerEventPayload, EvidenceEventPayload, MissionStatusPayload, TelemetryEventPayload } from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';
import { getSettings } from '../infrastructure/settings.js';
import { getAppPaths } from '../infrastructure/paths.js';
import { UsageLedger } from '../models/pricing.js';
import { globalGovernor } from '../models/governor.js';
import {
  PromptRegistry,
  MidRunSteeringQueue,
  ActionLedger,
  SteeringClass
} from './steering_and_reversibility.js';
import { SwarmCoordinator } from '../swarm/coordinator.js';
import { SwarmManager } from '../swarm/swarm_manager.js';
import { SharedBlackboard } from '../swarm/blackboard.js';
import { MissionRecorder } from '../infrastructure/mission_recorder.js';
import { ActionPolicyEngine } from '../security/action_policy.js';
import { GlobalKillSwitch, AuditLog } from '../security/audit_log.js';
import { PromptIsolationEngine } from '../security/prompt_isolation.js';
import { PrivacyGovernor } from '../security/privacy_governor.js';
import { SecretVault } from '../security/secret_vault.js';
import { BotChallengeBridge } from '../security/bot_detection.js';

const logger = rootLogger.child('agent-runtime');

export type MissionState =
  | 'idle'
  | 'planning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Mission {
  id: string;
  prompt: string;
  model: string;
  state: MissionState;
  stepCount: number;
  maxSteps: number;
  history: CanonicalMessage[];
  tabId?: string;
  result?: string;
  error?: string;
  evidenceCollected: string[];
}

const SYSTEM_PROMPT = `
You are Aegis, an industry-grade autonomous AI web browsing agent.
You interact with web pages through typed tools: navigate, click, type, press_key, scroll, wait, ask_user, done, fail.

Rules:
1. Always base actions on the current page URL, title, and interactive element refs ([e1], [e2], ...).
2. To click or type, specify the opaque element ref (e.g. click(ref="e1"), type(ref="e2", text="query", pressEnter=true)).
3. Verify your results on the page before declaring success.
4. When you have satisfied the user prompt, call the done tool with the final result and supporting evidence.
5. If you encounter a blocking issue you cannot overcome, call the fail tool with an explanation.
`.trim();

export class AgentRuntime {
  private static instance: AgentRuntime | null = null;
  private activeMission: Mission | null = null;
  private abortController: AbortController | null = null;
  private isPaused: boolean = false;
  private pausePromiseResolve: (() => void) | null = null;
  private usageLedger: UsageLedger = new UsageLedger();
  private actionLedger: ActionLedger = new ActionLedger();
  private steeringQueue: MidRunSteeringQueue = new MidRunSteeringQueue();

  private viewManager: ViewManager;
  private window: BrowserWindow;

  private constructor(window: BrowserWindow, viewManager: ViewManager) {
    this.window = window;
    this.viewManager = viewManager;
  }

  public static initialize(window: BrowserWindow, viewManager: ViewManager): AgentRuntime {
    if (!AgentRuntime.instance) {
      AgentRuntime.instance = new AgentRuntime(window, viewManager);
    }
    return AgentRuntime.instance;
  }

  public static getInstance(): AgentRuntime {
    if (!AgentRuntime.instance) {
      throw new Error('AgentRuntime not yet initialized');
    }
    return AgentRuntime.instance;
  }

  public getActiveMission(): Mission | null {
    return this.activeMission;
  }

  public async startMission(prompt: string, modelName?: string): Promise<{ ok: boolean; missionId?: string; error?: string }> {
    if (this.activeMission && (this.activeMission.state === 'running' || this.activeMission.state === 'planning')) {
      return {
        ok: false,
        error: 'A mission is already currently running. Please wait or cancel the active mission.'
      };
    }

    const settings = getSettings();
    const targetModel = modelName || settings.modelName || 'gemini-2.0-flash';

    // Verify credential availability upfront
    if (!settings.demoMode && !targetModel.includes('deepseek') && settings.modelProvider !== 'ollama') {
      if (targetModel.startsWith('gemini') || settings.modelProvider === 'gemini') {
        const key = settings.apiKeys?.gemini || process.env.GEMINI_API_KEY;
        if (!key) {
          return {
            ok: false,
            error: 'Google Gemini API key is not configured. Please open Settings (gear icon) to configure your API key.'
          };
        }
      } else if (targetModel.startsWith('gpt-') || settings.modelProvider === 'openai') {
        const key = settings.apiKeys?.openai || process.env.OPENAI_API_KEY;
        if (!key) {
          return {
            ok: false,
            error: 'OpenAI API key is not configured. Please open Settings (gear icon) to configure your API key.'
          };
        }
      }
    }

    const missionId = `m_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.abortController = new AbortController();
    this.isPaused = false;
    this.usageLedger.reset();

    let targetTab = this.viewManager.getActiveTab();
    if (!targetTab) {
      targetTab = this.viewManager.createTab('https://duckduckgo.com', false, `agent:${missionId}`);
    }

    this.activeMission = {
      id: missionId,
      prompt,
      model: targetModel,
      state: 'planning',
      stepCount: 0,
      maxSteps: 20,
      history: [],
      tabId: targetTab.id,
      evidenceCollected: []
    };
    MissionRecorder.checkpoint(this.activeMission); // mission row must exist before its first event (FK)

    logger.info('Starting mission', { missionId, prompt, model: this.activeMission.model, tabId: targetTab.id });

    // Emit initial status
    this.emitMissionStatus('planning', `Planning goal: "${prompt.slice(0, 50)}..."`);
    this.emitWorkerEvent({
      id: 'worker-agent-1',
      name: 'Agent [Planner]',
      task: `Analyzing goal: "${prompt.slice(0, 40)}"`,
      progress: 10,
      status: 'running'
    });
    this.emitEvidence(`[Mission ${missionId}] Initialized with goal: "${prompt}"`);

    // Run execution loop asynchronously
    this.runLoop().catch(err => {
      logger.error('Unhandled error in agent execution loop', err);
      this.finishMission('failed', undefined, err.message);
    });

    return { ok: true, missionId };
  }

  public pause(): void {
    if (this.activeMission && this.activeMission.state === 'running') {
      this.isPaused = true;
      this.activeMission.state = 'paused';
      this.emitMissionStatus('paused', 'Mission paused by user');
      this.emitEvidence('[Agent] Execution paused');
      logger.info('Mission paused', { missionId: this.activeMission.id });
    }
  }

  public resume(): void {
    if (this.activeMission && this.activeMission.state === 'paused') {
      this.isPaused = false;
      this.activeMission.state = 'running';
      if (this.pausePromiseResolve) {
        this.pausePromiseResolve();
        this.pausePromiseResolve = null;
      }
      this.emitMissionStatus('running', 'Mission resumed');
      this.emitEvidence('[Agent] Execution resumed');
      logger.info('Mission resumed', { missionId: this.activeMission.id });
    }
  }

  public takeover(): void {
    if (this.activeMission && this.activeMission.state === 'running') {
      this.pause();
      this.emitEvidence('[Manual Takeover] Human operator took manual control of the browser.');
      this.emitMissionStatus('paused', 'Manual human takeover active');
    }
  }

  public async handBack(): Promise<void> {
    if (this.activeMission && this.activeMission.state === 'paused') {
      this.emitEvidence('[Hand Back] Human operator returned control to agent. Reconciling page state...');
      const tab = this.viewManager.getActiveTab();
      if (tab) {
        await this.waitForSettle(tab);
        const snapshot = await PerceptionEngine.captureSnapshot(tab.view.webContents, false);
        this.activeMission.history.push({
          role: 'user',
          content: `[Operator Hand Back] The user completed manual interaction and returned control. Current page state:\nURL: ${snapshot.url}\nTitle: ${snapshot.title}\nInteractive Elements:\n${snapshot.formattedTree}`
        });
      }
      this.resume();
    }
  }

  public cancel(): void {
    if (this.activeMission) {
      logger.info('Cancelling mission', { missionId: this.activeMission.id });
      this.abortController?.abort();
      if (this.pausePromiseResolve) {
        this.pausePromiseResolve();
        this.pausePromiseResolve = null;
      }
      this.finishMission('cancelled', undefined, 'Mission cancelled by user');
    }
  }

  public steer(message: string, type: SteeringClass = 'steering'): void {
    this.steeringQueue.enqueue(type, message);
    this.emitEvidence(`[Steering Queued] ${type}: ${message}`);
  }

  public async undoLastAction(): Promise<{ ok: boolean; message: string }> {
    return this.actionLedger.undoLast(this.viewManager);
  }

  public getActionLedger(): ActionLedger {
    return this.actionLedger;
  }

  private async runSwarmLoop(mission: Mission): Promise<void> {
    const coordinator = new SwarmCoordinator({
      swarm: new SwarmManager({ maxWorkers: 6 }),
      blackboard: new SharedBlackboard({ missionId: mission.id })
    });

    coordinator.on('stageStarted', (ev: any) => {
      this.emitEvidence(`[Swarm Stage Started] ${ev.stageName} (${ev.taskCount} tasks)`);
      this.emitMissionStatus('running', `Stage: ${ev.stageName}`);
    });

    coordinator.on('taskStarted', (ev: any) => {
      this.emitWorkerEvent({
        id: ev.workerId,
        name: `Agent [${ev.role}]`,
        task: `Executing task ${ev.taskId}`,
        progress: 30,
        status: 'running'
      });
    });

    coordinator.on('taskCompleted', (ev: any) => {
      this.emitWorkerEvent({
        id: ev.workerId,
        name: `Agent [Worker]`,
        task: `Completed task ${ev.taskId}`,
        progress: 100,
        status: 'idle'
      });
    });

    coordinator.getBlackboard().on('evidence', (evItem: any) => {
      const cite = `[${evItem.entity} - ${evItem.attribute}: ${evItem.normalized.text || evItem.value}] from ${evItem.source.url}`;
      mission.evidenceCollected.push(cite);
      this.emitEvidence(`[Blackboard Evidence] ${cite}`);
    });

    coordinator.getBlackboard().on('conflict', (conf: any) => {
      this.emitEvidence(`[Blackboard Conflict Detected] ${conf.entity}::${conf.attribute} has contradictory claims. Escalating to verifier.`);
    });

    coordinator.getBlackboard().on('conflictResolved', (conf: any) => {
      this.emitEvidence(`[Blackboard Conflict Resolved] ${conf.entity}::${conf.attribute} resolved to "${conf.resolvedValue}" via ${conf.resolutionMethod}.`);
    });

    const result = await coordinator.executeMission(mission.id, mission.prompt);
    if (result.success) {
      this.finishMission('completed', result.deliverableMarkdown);
    } else {
      this.finishMission('failed', undefined, result.errors.join('; '));
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.activeMission) return;
    const mission = this.activeMission;
    mission.state = 'running';

    if (mission.prompt.startsWith('/swarm') || mission.prompt.startsWith('/research') || /compare.*across/i.test(mission.prompt)) {
      await this.runSwarmLoop(mission);
      return;
    }

    const tab = this.viewManager.getTab(mission.tabId || '') || this.viewManager.getActiveTab();
    if (!tab) {
      throw new Error('No active browser tab found to operate on');
    }

    // Attach CDP for realistic input execution
    try {
      await tab.executor.attachCDP();
    } catch {}

    const provider: IModelProvider = ModelProviderFactory.createProvider(mission.model);

    // Seed initial user prompt
    mission.history.push({
      role: 'user',
      content: `User Goal: ${mission.prompt}`
    });

    const actionSignatures: string[] = [];

    while (mission.state === 'running' && mission.stepCount < mission.maxSteps) {
      if (this.abortController?.signal.aborted) {
        this.finishMission('cancelled', undefined, 'Mission aborted');
        return;
      }

      // Check pause
      if (this.isPaused) {
        await new Promise<void>(resolve => {
          this.pausePromiseResolve = resolve;
        });
        if (this.abortController?.signal.aborted) return;
      }

      mission.stepCount++;
      const currentStep = mission.stepCount;
      const progressPercent = Math.min(90, Math.round((currentStep / mission.maxSteps) * 100));

      logger.info(`Step ${currentStep} starting`, { missionId: mission.id, step: currentStep });

      this.emitWorkerEvent({
        id: 'worker-agent-1',
        name: 'Agent [Operator]',
        task: `Executing step ${currentStep} of ${mission.maxSteps}`,
        progress: progressPercent,
        status: 'running'
      });

      // Drain mid-run steering messages (Issue #211)
      const steeringMsgs = this.steeringQueue.drain();
      for (const sm of steeringMsgs) {
        this.emitEvidence(`[User Steering - ${sm.type.toUpperCase()}] ${sm.text}`);
        mission.history.push({
          role: 'user',
          content: `[User Steering Instruction]: ${sm.text}`
        });
      }

      // Settle page loading and DOM stability (Issue #121)
      await this.waitForSettle(tab);

      // Context Management: prune older full-page snapshots to keep token growth bounded (Issue #123)
      this.pruneHistory(mission.history);

      // 1. Observe: Capture current page snapshot
      const snapshot: PageSnapshot = await PerceptionEngine.captureSnapshot(tab.view.webContents, false);

      // Roadblock and error detection (Issue #125)
      const roadblock = ActionTaxonomy.detectPageRoadblocks(snapshot.title, snapshot.url, snapshot.formattedTree);
      if (roadblock) {
        this.emitEvidence(`[Roadblock Detected] ${roadblock.message}`);
        this.emitEvidence(`[Action Required] ${roadblock.suggestedRecovery}`);
        this.pause();
        this.emitMissionStatus('paused', roadblock.suggestedRecovery);
        await new Promise(r => setTimeout(r, 600));
        continue;
      }

      // Bot Challenge Detection (Issue #162)
      const challenge = BotChallengeBridge.detectChallenge(snapshot.title, snapshot.formattedTree);
      if (challenge.detected) {
        this.emitEvidence(`[Anti-Bot Challenge Detected] ${challenge.message}`);
        this.pause();
        this.emitMissionStatus('paused', `Human verification required: ${challenge.provider}`);
        continue;
      }

      // Privacy & PII Redaction + Secret Masking (Issues #157, #160, #166)
      const privacyGovernor = new PrivacyGovernor('Careful');
      const piiRedactedTree = privacyGovernor.redactPII(snapshot.formattedTree).cleaned;
      const maskedTree = SecretVault.maskHighEntropyTokens(piiRedactedTree);
      const safeTitle = PromptIsolationEngine.escapeXml(snapshot.title);

      const observationText = `
[Page State - Isolated Data Channel]
URL: ${snapshot.url}
Title: ${safeTitle}
Interactive Elements:
${maskedTree}
`.trim();

      // Append observation to history as user/environment feedback
      mission.history.push({
        role: 'user',
        content: observationText
      });

      // 2. Decide: Call model
      this.emitEvidence(`[Step ${currentStep}] Observing: "${snapshot.title}" (${snapshot.elements.size} elements)`);

      let response;
      try {
        response = await globalGovernor.executeSafe(provider, {
          messages: mission.history,
          tools: BROWSER_TOOLS,
          systemPrompt: PromptRegistry.getInstance().getEffectivePrompt('actor').systemPrompt,
          abortSignal: this.abortController?.signal,
          missionId: mission.id,
          stepId: `step_${currentStep}`
        });
      } catch (err: any) {
        if (this.abortController?.signal.aborted) return;
        logger.error('Model call failed', err);
        this.emitEvidence(`[Error] Model invocation failed: ${err.message}`);
        this.finishMission('failed', undefined, `Model error: ${err.message}`);
        return;
      }

      if (response.thinking) {
        this.emitEvidence(`[Thought Stream] ${response.thinking}`);
      }

      if (response.finishReason === 'refusal') {
        this.emitEvidence(`[Refusal] Model refused to perform action: ${response.text}`);
        this.finishMission('failed', undefined, `Safety refusal: ${response.text}`);
        return;
      }

      // Record real token usage and cost (Issue #132)
      if (response.usage) {
        const stats = this.usageLedger.recordUsage(
          mission.model,
          response.usage.promptTokens,
          response.usage.completionTokens,
          response.usage.cacheReadTokens || 0
        );
        this.emitTelemetry({
          tokensTotal: stats.tokensTotal,
          costTotal: stats.costTotal,
          stepTokens: response.usage.promptTokens + response.usage.completionTokens,
          stepCost: stats.stepCost
        });
      }

      // Record assistant turn in history
      const assistantBlocks: ContentBlock[] = [];
      if (response.text) {
        assistantBlocks.push({ type: 'text', text: response.text });
        this.emitEvidence(`[Agent Thought] ${response.text.slice(0, 140)}`);
      }

      for (const tc of response.toolCalls) {
        assistantBlocks.push({
          type: 'tool_call',
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        });
      }

      mission.history.push({
        role: 'assistant',
        content: assistantBlocks.length > 0 ? assistantBlocks : (response.text || '...')
      });

      // 3. Act: Execute tool calls
      if (response.toolCalls.length === 0) {
        logger.warn('Model returned no tool calls', { text: response.text });
        this.emitEvidence('[Agent] No action chosen; prompting for next move');
        mission.history.push({
          role: 'user',
          content: 'Please choose an action tool to proceed towards the goal or call done/fail.'
        });
        await new Promise(r => setTimeout(r, 600));
        continue;
      }

      let isFinished = false;
      for (const toolCall of response.toolCalls) {
        if (this.abortController?.signal.aborted) return;

        // Emergency Kill Switch Check (Issue #164)
        if (GlobalKillSwitch.getInstance().isTriggered()) {
          this.finishMission('cancelled', undefined, 'Mission halted by Emergency Kill Switch');
          return;
        }

        // Policy Decision Point (PDP) Action Gating (Issue #158)
        const pdp = new ActionPolicyEngine();
        const auditLog = new AuditLog();
        const targetElement = toolCall.arguments?.ref ? snapshot.elements.get(toolCall.arguments.ref) : undefined;

        const policyEvaluation = pdp.evaluateAction({
          missionId: mission.id,
          userGoal: mission.prompt,
          allowedOrigins: [snapshot.url],
          currentUrl: snapshot.url,
          actionName: toolCall.name,
          actionArgs: toolCall.arguments,
          targetFacts: {
            label: targetElement?.name,
            type: targetElement?.type || targetElement?.tagName,
            role: targetElement?.role || targetElement?.tagName
          }
        });

        // Audit log action evaluation (Issue #164)
        auditLog.logAction({
          missionId: mission.id,
          actor: 'policy',
          action: toolCall.name,
          decision: policyEvaluation.decision,
          targetOrigin: snapshot.url,
          details: { riskClass: policyEvaluation.riskClass, reason: policyEvaluation.reason }
        });

        if (policyEvaluation.decision === 'deny') {
          this.emitEvidence(`[Security Policy Denied] ${policyEvaluation.reason}`);
          mission.history.push({
            role: 'user',
            content: `Tool Execution Denied by Security Policy: ${policyEvaluation.reason}`
          });
          continue;
        }

        if (policyEvaluation.decision === 'ask') {
          this.emitEvidence(`[Human Approval Required: ${policyEvaluation.riskClass}] ${policyEvaluation.reason}`);
          this.pause();
          this.emitMissionStatus('paused', `Awaiting user approval for ${policyEvaluation.riskClass}: ${policyEvaluation.reason}`);
          continue;
        }

        // Secret Placeholder Substitution at Execution Layer (Issue #160)
        if (toolCall.name === 'type' && typeof toolCall.arguments?.text === 'string' && toolCall.arguments.text.includes('{{secret:')) {
          const secretVault = new SecretVault();
          const subst = secretVault.substitutePlaceholder(toolCall.arguments.text, snapshot.url);
          if (subst.substituted && subst.resolvedValue) {
            toolCall.arguments.text = subst.resolvedValue;
          } else {
            this.emitEvidence(`[Secret Substitution Blocked] ${subst.reason}`);
            mission.history.push({
              role: 'user',
              content: `Failed to autofill secret: ${subst.reason}`
            });
            continue;
          }
        }

        // Loop / repetition detection (Issue #122)
        const sig = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
        actionSignatures.push(sig);
        const recent = actionSignatures.slice(-3);
        if (recent.length === 3 && recent.every(s => s === sig)) {
          this.emitEvidence(`[Loop Warning] Action "${toolCall.name}" repeated multiple times.`);
          mission.history.push({
            role: 'user',
            content: `[System Notice] You have repeated action ${toolCall.name} 3 times. Please try a different element or approach.`
          });
        }

        this.emitEvidence(`[Action] ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 80)})`);

        const execResult: ToolExecutionResult = await ToolExecutor.execute(
          toolCall.name,
          toolCall.arguments,
          { tab, snapshot }
        );

        // Record in Action Ledger for reversibility and audit (Issue #214)
        this.actionLedger.record(currentStep, toolCall.name, toolCall.arguments, tab.id);

        let outputText = execResult.output;
        if (!execResult.ok) {
          const classified = ActionTaxonomy.classify(execResult.error || execResult.output);
          outputText = `Error [${classified.code}]: ${classified.message} Suggested Recovery: ${classified.suggestedRecovery}`;
          this.emitEvidence(`[Recovery Policy: ${classified.code}] ${classified.suggestedRecovery}`);
        }

        // Append tool result block
        mission.history.push({
          role: 'tool',
          name: toolCall.name,
          content: [
            {
              type: 'tool_result',
              toolCallId: toolCall.id,
              output: outputText,
              isError: !execResult.ok
            }
          ]
        });

        if (execResult.effect?.evidence && Array.isArray(execResult.effect.evidence)) {
          for (const ev of execResult.effect.evidence) {
            mission.evidenceCollected.push(ev);
            this.emitEvidence(`[Evidence] ${ev}`);
          }
        }

        if (execResult.requiresUser) {
          this.emitEvidence(`[Human Assistance] ${execResult.output}`);
          this.pause();
          this.emitMissionStatus('paused', `Awaiting human assistance: ${execResult.output}`);
        }

        if (execResult.isTerminal) {
          isFinished = true;
          if (execResult.isDone) {
            this.finishMission('completed', execResult.output);
          } else {
            this.finishMission('failed', undefined, execResult.error || execResult.output);
          }
          return;
        }
      }

      // Save mission checkpoint after step (Issue #127)
      this.saveCheckpoint(mission);

      // Settle wait between steps for page render
      await new Promise(r => setTimeout(r, 600));
    }

    if (mission.state === 'running' && mission.stepCount >= mission.maxSteps) {
      this.finishMission('failed', undefined, `Exceeded maximum step budget of ${mission.maxSteps}`);
    }
  }

  private pruneHistory(history: CanonicalMessage[]): void {
    const observationIndices: number[] = [];
    history.forEach((msg, idx) => {
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('[Page State]')) {
        observationIndices.push(idx);
      }
    });

    if (observationIndices.length > 2) {
      const toPrune = observationIndices.slice(0, observationIndices.length - 2);
      for (const idx of toPrune) {
        const original = history[idx].content as string;
        const urlMatch = original.match(/URL:\s*(https?:\/\/[^\s\n]+)/);
        const titleMatch = original.match(/Title:\s*([^\n]+)/);
        const url = urlMatch ? urlMatch[1] : '';
        const title = titleMatch ? titleMatch[1] : '';
        history[idx].content = `[Page State Summary: Visited "${title}" (${url}) - DOM snapshot pruned to conserve context tokens]`;
      }
    }
  }

  private saveCheckpoint(mission: Mission): void {
    MissionRecorder.checkpoint(mission);
  }

  private saveDeliverableReport(mission: Mission): void {
    try {
      const paths = getAppPaths();
      const deliverablesDir = path.join(paths.userData, 'deliverables');
      if (!fs.existsSync(deliverablesDir)) {
        fs.mkdirSync(deliverablesDir, { recursive: true });
      }
      const filePath = path.join(deliverablesDir, `${mission.id}_report.md`);
      const md = `# Mission Report: ${mission.prompt}\n\n` +
        `**Status:** ${mission.state}\n` +
        `**Model:** ${mission.model}\n` +
        `**Steps Executed:** ${mission.stepCount}\n` +
        `**Date:** ${new Date().toISOString()}\n\n` +
        `## Deliverable Findings\n${mission.result || 'No final result recorded.'}\n\n` +
        `## Verified Evidence (${mission.evidenceCollected.length})\n` +
        mission.evidenceCollected.map((e, idx) => `${idx + 1}. ${e}`).join('\n') + '\n';
      fs.writeFileSync(filePath, md, 'utf-8');
      logger.info('Deliverable report saved', { filePath });
    } catch (err: any) {
      logger.warn('Failed to save deliverable report', { error: err.message });
    }
  }

  private async waitForSettle(tab: TabView, timeoutMs: number = 8000): Promise<void> {
    const start = Date.now();
    while (tab.state.isLoading && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
    }
    // Settle delay for dynamic DOM updates
    await new Promise(r => setTimeout(r, 400));
  }

  private finishMission(state: MissionState, result?: string, error?: string): void {
    if (!this.activeMission) return;
    this.activeMission.state = state;
    this.activeMission.result = result;
    this.activeMission.error = error;

    logger.info('Mission finished', { state, result, error });

    const statusText = state === 'completed'
      ? `Mission succeeded: ${result?.slice(0, 100) || 'Complete'}`
      : `Mission ${state}: ${error || 'Ended'}`;

    this.emitMissionStatus(state, statusText);

    // Native OS Notification (Issue #146: Background awareness)
    try {
      const { Notification } = require('electron');
      if (Notification && Notification.isSupported && Notification.isSupported()) {
        new Notification({
          title: `Aegis Mission ${state === 'completed' ? 'Completed' : 'Finished'}`,
          body: `Status: ${state} - "${this.activeMission.prompt.slice(0, 50)}"`
        }).show();
      }
    } catch {}

    this.emitWorkerEvent({
      id: 'worker-agent-1',
      name: 'Agent [Operator]',
      task: statusText,
      progress: state === 'completed' ? 100 : 0,
      status: state === 'completed' ? 'done' : 'failed'
    });
    this.emitEvidence(`[Mission Finished] ${statusText}`);

    // Persist final checkpoint and export structured deliverable (Issues #124, #127)
    this.saveCheckpoint(this.activeMission);
    if (state === 'completed') {
      this.saveDeliverableReport(this.activeMission);
    }
  }

  private emitMissionStatus(status: MissionStatusPayload['status'], message: string): void {
    try {
      if (!this.window.isDestroyed()) {
        const payload: MissionStatusPayload = {
          missionId: this.activeMission?.id,
          status,
          message
        };
        if (this.activeMission) MissionRecorder.checkpoint(this.activeMission);
        MissionRecorder.event(this.activeMission?.id, 'status', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_STATUS, payload);
      }
    } catch {}
  }

  private emitWorkerEvent(payload: WorkerEventPayload): void {
    try {
      if (!this.window.isDestroyed()) {
        MissionRecorder.event(this.activeMission?.id, 'worker', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_WORKER, payload);
      }
    } catch {}
  }

  private emitEvidence(text: string): void {
    try {
      if (!this.window.isDestroyed()) {
        const payload: EvidenceEventPayload = {
          text,
          timestamp: new Date().toTimeString().slice(0, 8)
        };
        MissionRecorder.event(this.activeMission?.id, 'evidence', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_EVIDENCE, payload);
      }
    } catch {}
  }

  private emitTelemetry(payload: TelemetryEventPayload): void {
    try {
      if (!this.window.isDestroyed()) {
        MissionRecorder.event(this.activeMission?.id, 'telemetry', payload);
        this.window.webContents.send(IPC_CHANNELS.EVENT_TELEMETRY, payload);
      }
    } catch {}
  }
}
