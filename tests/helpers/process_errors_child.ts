/** Child process for tests/test_mission_resume.ts: installs the app's process error handlers, then provokes both error kinds. */
import { installProcessErrorHandlers } from '../../src/main/process_errors.js';

installProcessErrorHandlers(process, {
  error: (message, err, extra) => console.log(`LOGGED ${message} ${err instanceof Error ? err.message : ''} ${JSON.stringify(extra ?? {})}`)
});

if (process.argv[2] === 'control') {
  // Control: without the handlers node must die on an unhandled rejection (proves the test can fail).
  // (An unhandled rejection with no listener is re-raised as an uncaught exception, so both are removed.)
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
}

void Promise.reject(new Error('rejected-and-forgotten'));
setTimeout(() => { throw new Error('thrown-from-a-timer'); }, 20);
setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 400);
