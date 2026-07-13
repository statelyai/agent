/**
 * Compile-only type probes for the game-agent setup.
 *
 * Nothing here runs — the machine exists purely so `tsc` fails if the typed
 * root/final output stops being typed against `gameSchemas.output`. Kept out of
 * the runnable `game-agent/index.ts` so that file reads as a clean example.
 * Typechecked via `examples/tsconfig.json` (globs `examples/**`).
 */
import { z } from "zod";
import { setupAgent } from "../../src/index.js";
import { gameActors, gameSchemas, models } from "./index.js";

// Rebuild the same setup the runnable machine uses. Rebuilt (not imported) so
// index.ts need not export the setup — exporting its full inferred type trips
// the declaration serializer (TS7056) under the root tsconfig's `declaration`.
const nonNullSummaryContext = gameSchemas.context.extend({ lastSummary: z.string() });

const gameAgentSetup = setupAgent({
  schemas: gameSchemas,
  models,
  actorSources: gameActors,
  states: {
    choosingMove: {},
    summarizing: {},
    checkingOutcome: {},
    done: { schemas: { context: nonNullSummaryContext } },
    won: { schemas: { context: nonNullSummaryContext } },
    lost: { schemas: { context: nonNullSummaryContext } },
    fled: { schemas: { context: nonNullSummaryContext } },
    fumbled: {},
  },
});

// ─── Type probe: compilation fails if the root/final output stops being typed ───

gameAgentSetup.createMachine({
  context: {
    playerHp: 20,
    enemyHp: 15,
    defended: false,
    lastSummary: null,
  },
  // @ts-expect-error root machine output must match gameSchemas.output
  output: () => ({ wrong: true }),
  // `fumbled` (an unnarrowed declared state) — the setup's per-state schemas
  // block constrains machines to declared state keys, so this probe machine
  // must reuse one.
  initial: "fumbled",
  states: {
    fumbled: {
      type: "final",
      // @ts-expect-error top-level final state output must match gameSchemas.output
      output: () => ({ wrong: true }),
    },
  },
});
