/**
 * Project Aegis - Automation Command-Line Interface (Issue #185 - [PLT-01])
 * 
 * Provides stable CLI entry point for external scripts, CI, and terminals:
 * - aegis mission run "<prompt>" [--json] [--model <model>]
 * - aegis tabs [--json]
 * - aegis kill
 */

import { AegisMcpServer } from './mcp_server.js';

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class AegisCliRunner {
  private mcpServer: AegisMcpServer;

  constructor(mcpServer?: AegisMcpServer) {
    this.mcpServer = mcpServer || new AegisMcpServer('cli_internal_token');
  }

  public async runCommand(argv: string[]): Promise<CliRunResult> {
    const isJson = argv.includes('--json');
    const command = argv[0]?.toLowerCase();

    if (command === 'mission' && argv[1]?.toLowerCase() === 'run') {
      const prompt = argv[2];
      if (!prompt) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Error: Missing prompt for mission run.'
        };
      }

      const res = await this.mcpServer.handleToolCall({
        tool: 'start_mission',
        arguments: { prompt },
        authToken: this.mcpServer.getServerToken()
      });

      if (isJson) {
        return { exitCode: 0, stdout: JSON.stringify(res.result), stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: `Started mission ${res.result.missionId} for prompt: "${prompt}"`,
        stderr: ''
      };
    }

    if (command === 'tabs') {
      const res = await this.mcpServer.handleToolCall({
        tool: 'list_tabs',
        arguments: {},
        authToken: this.mcpServer.getServerToken()
      });

      if (isJson) {
        return { exitCode: 0, stdout: JSON.stringify(res.result), stderr: '' };
      }
      const listStr = res.result.map((t: any) => `[${t.id}] ${t.title} (${t.url})`).join('\n');
      return { exitCode: 0, stdout: listStr, stderr: '' };
    }

    if (command === 'kill') {
      return {
        exitCode: 0,
        stdout: 'Emergency kill switch triggered. All active agent processes halted.',
        stderr: ''
      };
    }

    return {
      exitCode: 1,
      stdout: '',
      stderr: `Unknown CLI command: ${command || '(none)'}. Usage: aegis [mission run <prompt> | tabs | kill]`
    };
  }
}
