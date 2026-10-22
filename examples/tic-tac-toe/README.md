# Tic-tac-toe

A plain XState game, an O player plugged in at the boundary, and a JSON policy that climbs from "play the first empty cell" to a policy that `canReach` proves never loses.

| File               | Layer       | What it holds                                                                               |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| `game.ts`          | Environment | `ticTacToeMachine`: turns, empty-cell guards, `xWins` / `oWins` / `draw`. No agent imports. |
| `play.ts`          | Boundary    | The host loop: `decideNext` for O over the empty cells, an opponent function for X.         |
| `features.ts`      | Vocabulary  | The low-level board features a policy may read, as sorted cell lists.                       |
| `policy.ts`        | Policy      | Lowers a JSON policy and runs it synchronously as a `decide` executor.                      |
| `proof.ts`         | Proof       | `canReach(game, "xWins")` with X over every empty cell and O over the policy's one move.    |
| `improve.ts`       | Climb       | The objective, the gates, the reflection prompt, and the rounds.                            |
| `benchmark.ts`     | Arms        | Raw model, Jev, v0, and every promoted round against random, greedy, and perfect X.         |
| `evaluate.ts`      | Measurement | Scores one policy file: gates, proof, losing lines, match, objective.                       |
| `policies/v0.json` | Policy      | The starting point: the first empty cell.                                                   |

`test-fixtures/optimal.json` is a hand-written reference policy. Tests use it to show the vocabulary can express a never-losing policy; no improver reads it.

## Running without keys

```bash
pnpm vitest run examples/tic-tac-toe
pnpm exec tsx examples/tic-tac-toe/evaluate.ts examples/tic-tac-toe/policies/v0.json
```

- The tests climb v0 → v1 → v2 → v3 with a scripted reflection model and end on a proven policy.
- `evaluate.ts` takes a candidate and, optionally, the current policy, and prints `PROMOTE` or `KEEP`.

## Running the climb with real models

```bash
# One proof of v0, then up to 4 rounds with gpt-6-luna as the reflection model.
OPENAI_API_KEY=... pnpm exec tsx examples/tic-tac-toe/index.ts

# Every arm: raw model, Jev (with TYPESAFE_AI_API_KEY), v0, and each promoted round.
OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... pnpm exec tsx examples/tic-tac-toe/benchmark.ts
```

## Running the climb with Claude Code

The [`improve-machine`](../../skills/improve-machine/SKILL.md) skill runs the same rounds with Claude Code as the reflection model and `evaluate.ts` as the measurement:

```bash
claude -p "Use the improve-machine skill on examples/tic-tac-toe. Environment: ticTacToeMachine in game.ts; never edit it, features.ts, improve.ts, or proof.ts. Policy: policies/v0.json; write each candidate as policies/v<n>.json and record every round in policies/CHANGELOG.md. Objective (confirmed): objective() in improve.ts; score a candidate with 'pnpm exec tsx examples/tic-tac-toe/evaluate.ts <candidate> <current>' and promote only on PROMOTE. Traces: the proof's losing games and the losing lines that evaluate.ts prints; there is no held-out split, because the proof covers every opponent. Vocabulary: the FEATURES table in features.ts; no invokes, model calls, named guards, or actions. Never open test-fixtures/ or test-doubles.ts. Stop when evaluate.ts prints 'PROVEN never to lose', or after 3 rounds without a promotion."
```
