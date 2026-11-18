import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppPaths } from './paths.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  missionId?: string;
  workerId?: string;
  stepId?: string;
  subsystem?: string;
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const REDACT_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'set-cookie'
]);

function redactValue(key: string, val: any): any {
  if (val === null || val === undefined) return val;
  if (REDACT_KEYS.has(key.toLowerCase())) {
    return '[REDACTED]';
  }
  if (typeof val === 'string') {
    // Redact bearer tokens
    if (val.toLowerCase().startsWith('bearer ')) {
      return 'Bearer [REDACTED]';
    }
    // Redact basic auth
    if (val.toLowerCase().startsWith('basic ')) {
      return 'Basic [REDACTED]';
    }
  }
  if (typeof val === 'object' && !Array.isArray(val)) {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      clean[k] = redactValue(k, v);
    }
    return clean;
  }
  return val;
}

export class Logger {
  private subsystem: string;
  private logFilePath: string | null = null;
  private minLevel: LogLevel = 'info';

  private static levelOrder: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
  };

  constructor(subsystem: string = 'app') {
    this.subsystem = subsystem;
    try {
      const paths = getAppPaths();
      this.logFilePath = path.join(paths.logs, 'app.log');
    } catch {
      // In case getAppPaths() not yet initialized
      this.logFilePath = null;
    }
  }

  public child(subsystem: string): Logger {
    const child = new Logger(`${this.subsystem}:${subsystem}`);
    child.logFilePath = this.logFilePath;
    child.minLevel = this.minLevel;
    return child;
  }

  public setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return Logger.levelOrder[level] >= Logger.levelOrder[this.minLevel];
  }

  private write(level: LogLevel, message: string, context?: LogContext, err?: Error): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context ? redactValue('context', { subsystem: this.subsystem, ...context }) : { subsystem: this.subsystem }
    };

    if (err) {
      entry.error = {
        name: err.name,
        message: err.message,
        stack: err.stack
      };
    }

    const jsonLine = JSON.stringify(entry);

    // Console output for development visibility
    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${this.subsystem}]`;
    if (level === 'error') {
      console.error(prefix, message, context || '', err || '');
    } else if (level === 'warn') {
      console.warn(prefix, message, context || '');
    } else {
      console.log(prefix, message, context || '');
    }

    // Persist to log file if path is available
    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, jsonLine + '\n', 'utf-8');
      } catch {
        // Prevent recursive errors if file write fails
      }
    }
  }

  public debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  public warn(message: string, context?: LogContext, err?: Error): void {
    this.write('warn', message, context, err);
  }

  public error(message: string, err?: Error, context?: LogContext): void {
    this.write('error', message, context, err);
  }
}

export const rootLogger = new Logger('main');
export const logger = rootLogger;
