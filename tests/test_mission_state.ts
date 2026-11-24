/**
 * Issue #226 (RUN-04): the mission state machine. Every one of the 11 x 11 state pairs is exercised against an
 * independently written list of legal edges (the issue's chain), so a wrong table in mission_state.ts fails here.
 */
import { strict as assert } from 'node:assert';
import {
  ALL_STATES, MissionState, MissionStateMachine, MissionStatusEvent, IllegalTransitionError, isTerminal, LEGAL_TRANSITIONS
} from '../src/agent/mission_state.js';

console.log('--- #226 RUN-04: mission state machine ---');

// idle -> planning -> running <-> paused | waiting_user | waiting_approval | takeover -> completed | completed_unverified | failed | cancelled
const EXPECTED_LEGAL = new Set<string>([
  'idle>planning',
  'planning>running', 'planning>failed', 'planning>cancelled',
  'running>paused', 'running>waiting_user', 'running>waiting_approval', 'running>takeover',
  'running>completed', 'running>completed_unverified', 'running>failed', 'running>cancelled',
  'paused>running', 'paused>takeover', 'paused>failed', 'paused>cancelled',
  'waiting_user>running', 'waiting_user>failed', 'waiting_user>cancelled',
  'waiting_approval>running', 'waiting_approval>failed', 'waiting_approval>cancelled',
  'takeover>running', 'takeover>failed', 'takeover>cancelled'
]);

/** Walks a fresh machine to `state` along legal edges. */
const PATH_TO: Record<MissionState, MissionState[]> = {
  idle: [],
  planning: ['planning'],
  running: ['planning', 'running'],
  paused: ['planning', 'running', 'paused'],
  waiting_user: ['planning', 'running', 'waiting_user'],
  waiting_approval: ['planning', 'running', 'waiting_approval'],
  takeover: ['planning', 'running', 'takeover'],
  completed: ['planning', 'running', 'completed'],
  completed_unverified: ['planning', 'running', 'completed_unverified'],
  failed: ['planning', 'failed'],
  cancelled: ['planning', 'cancelled']
};

function machineAt(state: MissionState, strict: boolean, events: MissionStatusEvent[] = [], illegal: string[] = []): MissionStateMachine {
  const m = new MissionStateMachine({
    missionId: 'm1', strict,
    onTransition: e => events.push(e),
    onIllegal: (f, t, r) => illegal.push(`${f}>${t}:${r}`)
  });
  for (const s of PATH_TO[state]) assert.equal(m.transition(s, 'setup'), true, `setup edge to ${s}`);
  assert.equal(m.state, state);
  events.length = 0;
  illegal.length = 0;
  return m;
}

let legal = 0, illegalCount = 0, same = 0;
for (const from of ALL_STATES) {
  for (const to of ALL_STATES) {
    const key = `${from}>${to}`;
    if (from === to) {
      // Re-entering the current state is an idempotent no-op in both modes: no event, no throw.
      for (const strict of [true, false]) {
        const ev: MissionStatusEvent[] = [];
        const m = machineAt(from, strict, ev);
        assert.equal(m.transition(to, 'again'), false, `${key} strict=${strict} is a no-op`);
        assert.equal(ev.length, 0, `${key}: no event for a same-state call`);
        assert.equal(m.state, from);
      }
      same++;
    } else if (EXPECTED_LEGAL.has(key)) {
      for (const strict of [true, false]) {
        const ev: MissionStatusEvent[] = [];
        const m = machineAt(from, strict, ev);
        assert.equal(m.transition(to, 'why'), true, `${key} must be legal (strict=${strict})`);
        assert.equal(m.state, to);
        assert.equal(ev.length, 1, `${key}: exactly one mission:status event`);
        assert.equal(ev[0].state, to);
        assert.equal(ev[0].reason, 'why');
        assert.equal(ev[0].missionId, 'm1');
      }
      legal++;
    } else {
      // Dev (strict): throws and the state does not move. Production: logged through onIllegal, ignored, no event.
      {
        const ev: MissionStatusEvent[] = [];
        const m = machineAt(from, true, ev);
        assert.throws(() => m.transition(to, 'bad'), (e: any) => e instanceof IllegalTransitionError && e.from === from && e.to === to, `${key} must throw in dev`);
        assert.equal(m.state, from, `${key}: state unchanged after the throw`);
        assert.equal(ev.length, 0, `${key}: no event for an illegal transition`);
      }
      {
        const ev: MissionStatusEvent[] = [];
        const bad: string[] = [];
        const m = machineAt(from, false, ev, bad);
        assert.equal(m.transition(to, 'bad'), false, `${key} is ignored in prod`);
        assert.equal(m.state, from);
        assert.equal(ev.length, 0);
        assert.deepEqual(bad, [`${from}>${to}:bad`], `${key} is reported through onIllegal`);
      }
      illegalCount++;
    }
  }
}
assert.equal(legal, EXPECTED_LEGAL.size, 'every expected legal edge was exercised');
assert.equal(legal + illegalCount + same, ALL_STATES.length ** 2);
console.log(`✓ all ${ALL_STATES.length ** 2} state pairs: ${legal} legal, ${illegalCount} illegal (throw in dev, log+ignore in prod), ${same} same-state no-ops`);

// The exported table is the same relation as the independent list (guards the table the runtime really uses).
{
  const fromTable = new Set<string>();
  for (const f of ALL_STATES) for (const t of LEGAL_TRANSITIONS[f]) fromTable.add(`${f}>${t}`);
  assert.deepEqual([...fromTable].sort(), [...EXPECTED_LEGAL].sort());
  for (const s of ALL_STATES) assert.equal(isTerminal(s), ['completed', 'completed_unverified', 'failed', 'cancelled'].includes(s));
  for (const s of ALL_STATES) if (isTerminal(s)) assert.equal(LEGAL_TRANSITIONS[s].length, 0, `${s} is absorbing`);
  console.log('✓ exported table equals the specified chain; terminal states are absorbing');
}

// Event shape: {state, reason, ts, seq}, seq = 1,2,3..., ts never goes backwards even if the clock does.
{
  const ev: MissionStatusEvent[] = [];
  const clock = [1000, 2000, 1500, 3000, 2999];
  let i = 0;
  const m = new MissionStateMachine({ missionId: 'x', strict: true, onTransition: e => ev.push(e), now: () => clock[i++] });
  m.transition('planning', 'a');
  m.transition('running', 'b');
  m.transition('paused', 'c');
  m.transition('running', 'd');
  m.transition('completed', 'e');
  assert.deepEqual(ev.map(e => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(ev.map(e => e.state), ['planning', 'running', 'paused', 'running', 'completed']);
  assert.deepEqual(ev.map(e => e.reason), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ev.map(e => e.ts), [1000, 2000, 2000, 3000, 3000], 'ts is clamped to be non-decreasing');
  assert.equal(m.eventCount, 5);
  assert.equal(m.terminal, true);
  console.log('✓ events carry {state, reason, ts, seq}; seq is gapless, ts is monotonic');
}

// A listener that throws must not corrupt the machine's own bookkeeping (the state is set before the callback).
{
  const m = new MissionStateMachine({ strict: true, onTransition: () => { throw new Error('listener bug'); } });
  assert.throws(() => m.transition('planning', 'x'), /listener bug/);
  assert.equal(m.state, 'planning');
  assert.equal(m.eventCount, 1);
  console.log('✓ the state is committed before the listener runs');
}
