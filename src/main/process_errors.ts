/**
 * Process-level error handlers for the main process (#226 step 4). An error that escapes a promise or a callback is
 * logged and the app keeps running: a failed mission is reported through the mission state machine, not by dying.
 */
export interface ProcessLike {
  on(event: 'uncaughtException', listener: (err: Error) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

export interface ErrorLog {
  error(message: string, err?: unknown, extra?: Record<string, unknown>): void;
}

export function installProcessErrorHandlers(proc: ProcessLike, log: ErrorLog): void {
  proc.on('uncaughtException', (err: Error) => {
    log.error('Uncaught Exception in main process', err);
  });
  proc.on('unhandledRejection', (reason: unknown) => {
    log.error('Unhandled Promise Rejection in main process', undefined, { reason: reason instanceof Error ? reason.stack || reason.message : String(reason) });
  });
}
