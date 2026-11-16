/**
 * Project Aegis - Universal Model Context Protocol (MCP) Hub
 * 
 * Implements:
 * - Issue #11: M6.1 Universal Model Context Protocol (MCP) Hub & Client Integration
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface MCPToolDefinition {
  serverName: string;
  originalName: string;
  namespacedName: string;
  description?: string;
  inputSchema: Record<string, any>;
}

export interface MCPServerState {
  name: string;
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport;
  status: 'connected' | 'connecting' | 'error' | 'disconnected';
  tools: Map<string, MCPToolDefinition>;
  lastError?: string;
}

export class MCPHub {
  private servers: Map<string, MCPServerState> = new Map();
  private isShuttingDown = false;

  constructor() {}

  /**
   * Registers and connects an MCP stdio server.
   */
  public async registerServer(config: MCPServerConfig): Promise<boolean> {
    if (this.servers.has(config.name)) {
      await this.disconnectServer(config.name);
    }

    if (config.disabled) {
      return false;
    }

    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}) } as Record<string, string>
      });

      const client = new Client(
        {
          name: `aegis-browser-${config.name}`,
          version: '0.1.0'
        },
        {
          capabilities: {
            roots: { listChanged: true }
          }
        }
      );

      const serverState: MCPServerState = {
        name: config.name,
        config,
        client,
        transport,
        status: 'connecting',
        tools: new Map()
      };

      this.servers.set(config.name, serverState);

      await client.connect(transport);
      serverState.status = 'connected';

      // Discover tools
      await this.refreshServerTools(config.name);
      return true;
    } catch (err: any) {
      const state = this.servers.get(config.name);
      if (state) {
        state.status = 'error';
        state.lastError = err?.message || String(err);
      }
      return false;
    }
  }

  /**
   * Refreshes available tools from a specific connected server.
   */
  public async refreshServerTools(serverName: string): Promise<MCPToolDefinition[]> {
    const state = this.servers.get(serverName);
    if (!state || state.status !== 'connected') {
      return [];
    }

    try {
      const result = await state.client.listTools();
      state.tools.clear();

      for (const tool of result.tools) {
        const namespacedName = `mcp__${serverName}__${tool.name}`;
        const def: MCPToolDefinition = {
          serverName,
          originalName: tool.name,
          namespacedName,
          description: tool.description,
          inputSchema: (tool.inputSchema as Record<string, any>) || { type: 'object', properties: {} }
        };
        state.tools.set(namespacedName, def);
      }

      return Array.from(state.tools.values());
    } catch (err: any) {
      state.lastError = `Failed to list tools: ${err?.message || err}`;
      return [];
    }
  }

  /**
   * Retrieves all available tools across all connected MCP servers.
   */
  public getAllTools(): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = [];
    for (const state of this.servers.values()) {
      if (state.status === 'connected') {
        for (const tool of state.tools.values()) {
          tools.push(tool);
        }
      }
    }
    return tools;
  }

  /**
   * Executes an MCP tool by its namespaced name: mcp__<server>__<tool>.
   */
  public async executeTool(namespacedName: string, args: Record<string, any>): Promise<any> {
    const parts = namespacedName.split('__');
    if (parts.length !== 3 || parts[0] !== 'mcp') {
      throw new Error(`Invalid MCP tool identifier: "${namespacedName}". Expected format: "mcp__<server>__<tool>".`);
    }

    const serverName = parts[1];
    const toolName = parts[2];
    const server = this.servers.get(serverName);

    if (!server || server.status !== 'connected') {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }

    const tool = server.tools.get(namespacedName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found on MCP server "${serverName}".`);
    }

    const callResult = await server.client.callTool({
      name: toolName,
      arguments: args
    });

    const content = (callResult as any).content;
    if (callResult.isError) {
      const errText = Array.isArray(content)
        ? content.map((c: any) => ('text' in c ? c.text : JSON.stringify(c))).join('\n')
        : 'Tool execution failed';
      throw new Error(`MCP Tool Error [${namespacedName}]: ${errText}`);
    }

    return callResult.content;
  }

  /**
   * Disconnects a specific server.
   */
  public async disconnectServer(serverName: string): Promise<void> {
    const state = this.servers.get(serverName);
    if (!state) return;

    try {
      await state.client.close();
    } catch {
      // Ignore cleanup error
    } finally {
      state.status = 'disconnected';
      state.tools.clear();
      this.servers.delete(serverName);
    }
  }

  /**
   * Disconnects all servers and tears down transports.
   */
  public async disconnectAll(): Promise<void> {
    this.isShuttingDown = true;
    const names = Array.from(this.servers.keys());
    await Promise.all(names.map(name => this.disconnectServer(name)));
    this.servers.clear();
  }

  /**
   * Returns current health and tool count of all registered servers.
   */
  public getStatus(): Record<string, { status: string; toolCount: number; error?: string }> {
    const status: Record<string, { status: string; toolCount: number; error?: string }> = {};
    for (const [name, s] of this.servers.entries()) {
      status[name] = {
        status: s.status,
        toolCount: s.tools.size,
        error: s.lastError
      };
    }
    return status;
  }
}
