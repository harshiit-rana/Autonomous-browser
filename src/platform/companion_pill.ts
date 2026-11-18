/**
 * Project Aegis - Floating Companion Pill & Voice Input UX (Issue #187 - [PLT-03])
 * 
 * Features:
 * - Floating quick-action companion pill (always-on-top micro-widget showing active mission status,
 *   step progress, quick pause/stop buttons, and pending approval alerts)
 * - Global shortcut registration with OS conventions (Ctrl+Shift+Space on Windows/Linux, Cmd+Shift+Space on macOS)
 * - Push-to-talk voice input interface (strictly zero always-listening background audio recording)
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('companion-pill');

export interface CompanionPillState {
  visible: boolean;
  activeMissionId?: string;
  status: 'idle' | 'running' | 'paused' | 'awaiting_approval' | 'done';
  prompt: string;
  progressPercent: number;
  currentStepTitle?: string;
  hasPendingApproval: boolean;
  position: { x: number; y: number };
}

export class CompanionPillManager {
  private state: CompanionPillState;
  private isVoiceRecording: boolean = false;

  constructor() {
    this.state = {
      visible: false,
      status: 'idle',
      prompt: '',
      progressPercent: 0,
      hasPendingApproval: false,
      position: { x: 50, y: 50 }
    };
  }

  public getState(): CompanionPillState {
    return { ...this.state };
  }

  public setVisible(visible: boolean): void {
    this.state.visible = visible;
    logger.info('Companion pill visibility toggled', { visible });
  }

  public updateMissionStatus(patch: Partial<CompanionPillState>): void {
    Object.assign(this.state, patch);
    if (this.state.hasPendingApproval) {
      this.state.visible = true; // Auto-surface pill when approval is needed
    }
  }

  /**
   * Returns the recommended global shortcut for summoning the browser composer
   * based on the current host operating system
   */
  public static getRecommendedGlobalShortcut(platform: string = process.platform): string {
    return platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space';
  }

  /**
   * Push-to-talk voice interface:
   * Only activates when explicitly triggered by user; never continuously listens.
   */
  public startPushToTalk(): { recording: boolean; message: string } {
    this.isVoiceRecording = true;
    logger.info('Push-to-talk voice recording activated');
    return {
      recording: true,
      message: 'Listening... release to transcribe.'
    };
  }

  public stopPushToTalk(simulatedAudioText: string = ''): { recording: boolean; transcribedPrompt: string } {
    this.isVoiceRecording = false;
    logger.info('Push-to-talk voice recording completed', { transcribedPrompt: simulatedAudioText });
    return {
      recording: false,
      transcribedPrompt: simulatedAudioText.trim()
    };
  }
}
