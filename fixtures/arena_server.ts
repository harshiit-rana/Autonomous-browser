export * from '../src/testing/arena_server.js';
import { WebArenaServer } from '../src/testing/arena_server.js';

// If executed directly via `npm run fixtures` or `tsx fixtures/arena_server.ts`
if (process.argv[1]?.endsWith('arena_server.ts') || process.argv[1]?.endsWith('arena_server.js')) {
  const server = new WebArenaServer();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3890;
  server.start(port).then(p => {
    console.log(`[Web Arena Server] Running at http://127.0.0.1:${p}`);
    console.log(`[Web Arena Server] Scenarios available: /shop, /forms, /content, /auth, /structure, /hostile, /chaos`);
    console.log(`[Web Arena Server] Oracle control API: GET /api/oracle/state, POST /api/oracle/reset`);
  }).catch(err => {
    console.error('[Web Arena Server] Failed to start:', err);
    process.exit(1);
  });
}
