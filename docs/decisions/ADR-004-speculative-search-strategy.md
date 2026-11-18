# ADR-004: Speculative Search, Backtracking, and Decision on MCTS

## Context & Problem Statement
Earlier prototype documentation referenced "test-time MCTS planning" for autonomous browser navigation. However, systematic testing and web architecture realities demonstrate that web environments differ fundamentally from closed-world game simulations (e.g. Chess, Go):
1. **Web State is Non-Resettable:** Unlike in-memory games, web applications maintain state across HTTP cookies, server-side sessions, shopping carts, database mutations, and anti-fraud rate limiters. Cloning an Electron tab does not clone server-side database state.
2. **Action Irreversibility:** Clicks that trigger side effects (POST requests, checkout confirmations, deletions, account logins) cannot be undone via Monte Carlo rollouts.
3. **Token & Latency Explosion:** Performing tree search rollouts over web DOM states multiplies LLM token consumption by 8x-15x and introduces prohibitive latency (30-60 seconds per step).

## Evaluated Candidate Strategies
We evaluated four candidate exploration strategies on fixture web workflows:
1. **Candidate A: Classic MCTS Action Rollouts:**
   - *Outcome:* Disqualified. High failure rate due to server state desynchronization and catastrophic hazard of premature side effects during rollout simulations.
2. **Candidate B: Best-of-N Independent Plans with Verifier Adjudication:**
   - *Outcome:* Effective for research/extraction tasks, but token cost scales linearly ($O(N)$) without sharing intermediate page findings.
3. **Candidate C: Single-Worker Backtracking via History & ActionLedger:**
   - *Outcome:* Highly effective for recovering from navigation dead-ends (`404`, wrong search result, dead links) using browser navigation history and ActionLedger rollback.
4. **Candidate D: Speculative Read-Only Branching with Evidence Scoring & Best-of-N Selection (Winner):**
   - *Outcome:* Combines the parallel exploration benefits of Best-of-N with strict safety constraints and shared evidence.

## Decision: Speculative Read-Only Branching Engine
We officially adopt **Speculative Read-Only Branching with Evidence Scoring & Local Backtracking**, implementing the following architectural guarantees:
1. **Strict Read-Only Invariant:** Speculative exploration branches are strictly gated to `read` effect-class actions (navigation, DOM inspection, scrolling, reading text). Any side-effecting action (`write-non-idempotent`, `financial`) halts exploration and requires explicit branch commitment.
2. **Evidence-Based State Scoring:** Candidate exploration paths are scored based on corroborated evidence posted to the Shared Blackboard and goal keyword relevance.
3. **Cost-Bounded Exploration:** Branching is capped by default to at most 3 branches and a token budget ceiling ($0.05).
4. **Deprecation of Classic MCTS:** The legacy `MCTSPlanner` stub is deprecated and refactored into the `SpeculativeBranchingEngine`. All marketing claims of "MCTS" are replaced with truthful descriptions of "Speculative Branching & Verification".

## Status
Accepted and Implemented in Milestone M3 (#154).
