import { BrowserWindow } from 'electron';
import { ViewManager, TabView } from '../main/view_manager.js';
import { ModelProviderFactory } from '../models/provider_factory.js';
import { IModelProvider, CanonicalMessage, ContentBlock } from '../models/types.js';
import { PerceptionEngine, PageSnapshot } from './perception.js';
import { BROWSER_TOOLS, ToolExecutor, ToolExecutionResult } from './tools.js';
import { IPC_CHANNELS, WorkerEventPayload, EvidenceEventPayload, MissionStatusPayload } from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';
import { getSettings } from '../infrastructure/settings.js';

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
}

const SYSTEM_PROMPT = `
You are Aegis, an industry-grade autonomous AI web browsing agent.
You interact with web pages through typed tools: navigate, click, type, press_key, scroll, wait, done, fail.

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
      tabId: targetTab.id
    };

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

  private async runLoop(): Promise<void> {
    if (!this.activeMission) return;
    const mission = this.activeMission;
    mission.state = 'running';

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

      // Settle page loading and DOM stability (Issue #121)
      await this.waitForSettle(tab);

      // 1. Observe: Capture current page snapshot
      const snapshot: PageSnapshot = await PerceptionEngine.captureSnapshot(tab.view.webContents, false);
      const observationText = `
[Page State]
URL: ${snapshot.url}
Title: ${snapshot.title}
Interactive Elements:
${snapshot.formattedTree}
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
        response = await provider.generate({
          messages: mission.history,
          tools: BROWSER_TOOLS,
          systemPrompt: SYSTEM_PROMPT,
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

        this.emitEvidence(`[Action] ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 80)})`);

        const execResult: ToolExecutionResult = await ToolExecutor.execute(
          toolCall.name,
          toolCall.arguments,
          { tab, snapshot }
        );

        // Append tool result block
        mission.history.push({
          role: 'tool',
          name: toolCall.name,
          content: [
            {
              type: 'tool_result',
              toolCallId: toolCall.id,
              output: execResult.output,
              isError: !execResult.ok
            }
          ]
        });

        if (execResult.effect?.evidence && Array.isArray(execResult.effect.evidence)) {
          for (const ev of execResult.effect.evidence) {
            this.emitEvidence(`[Evidence] ${ev}`);
          }
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

      // Settle wait between steps for page render
      await new Promise(r => setTimeout(r, 800));
    }

    if (mission.state === 'running' && mission.stepCount >= mission.maxSteps) {
      this.finishMission('failed', undefined, `Exceeded maximum step budget of ${mission.maxSteps}`);
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
    this.emitWorkerEvent({
      id: 'worker-agent-1',
      name: 'Agent [Operator]',
      task: statusText,
      progress: state === 'completed' ? 100 : 0,
      status: state === 'completed' ? 'done' : 'failed'
    });
    this.emitEvidence(`[Mission Finished] ${statusText}`);
  }

  private emitMissionStatus(status: MissionStatusPayload['status'], message: string): void {
    try {
      if (!this.window.isDestroyed()) {
        const payload: MissionStatusPayload = {
          missionId: this.activeMission?.id,
          status,
          message
        };
        this.window.webContents.send(IPC_CHANNELS.EVENT_MISSION_STATUS, payload);
      }
    } catch {}
  }

  private emitWorkerEvent(payload: WorkerEventPayload): void {
    try {
      if (!this.window.isDestroyed()) {
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
        this.window.webContents.send(IPC_CHANNELS.EVENT_EVIDENCE, payload);
      }
    } catch {}
  }
}
