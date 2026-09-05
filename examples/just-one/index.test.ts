import { describe, expect, test } from "vitest";
import { getStateMeta, runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { type GuesserEvent, idlePrompt, justOneMachine, PERSONAS } from "./index.js";

/** Every request the scripted clue-giver saw, as the executor received it. */
interface CapturedRequest {
  name?: string;
  system?: string;
  prompt?: string;
  serialized: string;
}

/**
 * Scripted clue-givers: one clue per persona, per round. The executor routes on
 * the persona name in the prompt — the only thing that distinguishes the three
 * otherwise identical requests.
 */
function createClueGivers(script: Record<string, string[]>, captured: CapturedRequest[] = []) {
  const counts = new Map<string, number>();
  const executor: AgentRequestExecutor = async (request) => {
    captured.push({
      name: request.name,
      system: request.system,
      prompt: request.prompt,
      serialized: JSON.stringify(request),
    });
    const persona = PERSONAS.find((entry) => request.prompt?.includes(`You are ${entry.name}.`));
    if (!persona) throw new Error(`unrecognized clue request: ${request.prompt}`);
    const round = counts.get(persona.name) ?? 0;
    counts.set(persona.name, round + 1);
    const clue = script[persona.name]?.[round] ?? "";
    return { output: { clue, reasoning: `${persona.name} round ${round + 1}` } };
  };
  return { executor, captured };
}

interface PlayOptions {
  input: { rounds: number; deck?: string[] };
  script: Record<string, string[]>;
  /** Consumed in order on each idle settle. */
  guesserEvents: GuesserEvent[];
  captured?: CapturedRequest[];
}

/** Drives the machine through its idle-resume loop, recording each idle prompt. */
async function play(options: PlayOptions) {
  const queued = [...options.guesserEvents];
  const prompts: string[] = [];
  const { executor } = createClueGivers(options.script, options.captured);
  const shared = { executors: { generateText: executor } };

  let result = await runAgent(justOneMachine, { input: options.input, ...shared });

  while (result.status === "idle") {
    // Every idle state must advertise how a host can unblock it.
    const interaction = getStateMeta(result.snapshot).interaction;
    expect(
      interaction,
      `no interaction meta on ${JSON.stringify(result.snapshot.value)}`,
    ).toBeDefined();
    prompts.push(idlePrompt(result.snapshot));

    const event = queued.shift();
    if (!event) throw new Error(`ran out of guesser events at: ${prompts.at(-1)}`);
    expect(result.snapshot.can(event as never)).toBe(true);

    result = await runAgent(justOneMachine, {
      snapshot: result.persist(),
      event,
      ...shared,
    });
  }

  if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);
  return { result, prompts };
}

describe("just-one", () => {
  test("colliding clues cancel each other before the guesser sees them", async () => {
    const { result, prompts } = await play({
      input: { rounds: 1, deck: ["volcano"] },
      script: { Iris: ["lava"], Milo: ["lava"], Nadia: ["eruption"] },
      guesserEvents: [{ type: "GUESS", guess: "volcano" }],
    });

    // Only the surviving clue reaches the guesser.
    expect(prompts).toEqual(["Clues: eruption. What is the secret word?"]);
    expect(result.output.score).toBe(1);
    expect(result.output.log).toEqual([
      'Round 1 — secret "volcano". Clues: lava [duplicate — cancelled], ' +
        "lava [duplicate — cancelled], eruption (Nadia).",
      'Guessed "volcano" — correct.',
    ]);
  });

  test("a round where every clue is struck is skipped without a guessing turn", async () => {
    const captured: CapturedRequest[] = [];
    const { executor } = createClueGivers(
      { Iris: ["magma"], Milo: ["magma"], Nadia: ["magma"] },
      captured,
    );

    const result = await runAgent(justOneMachine, {
      input: { rounds: 1, deck: ["volcano"] },
      executors: { generateText: executor },
    });

    // The run never settles idle: `judging` goes straight to `roundEnd`.
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.score).toBe(0);
    expect(result.output.log.at(-1)).toBe("All clues cancelled — round skipped.");
    expect(result.output.summary).toContain("Guessed 0 of 1 word.");
    expect(captured).toHaveLength(3);
  });

  test("a clue equal to (or containing) the secret word is struck", async () => {
    const { result, prompts } = await play({
      input: { rounds: 1, deck: ["piano"] },
      // Iris writes the secret word; Milo writes an inflected form of it.
      script: { Iris: ["Piano"], Milo: ["pianos"], Nadia: ["keys"] },
      guesserEvents: [{ type: "GUESS", guess: "piano" }],
    });

    expect(prompts).toEqual(["Clues: keys. What is the secret word?"]);
    expect(result.output.log[0]).toBe(
      'Round 1 — secret "piano". Clues: Piano [gives away the secret word], ' +
        "pianos [gives away the secret word], keys (Nadia).",
    );
    expect(result.output.score).toBe(1);
  });

  test("PASS advances the round, and a mid-guess snapshot round-trips", async () => {
    const { executor } = createClueGivers({
      Iris: ["lava", "sting"],
      Milo: ["crater", "bear"],
      Nadia: ["Vesuvius", "bee"],
    });
    const shared = { executors: { generateText: executor } };

    const firstIdle = await runAgent(justOneMachine, {
      input: { rounds: 2, deck: ["volcano", "honey"] },
      ...shared,
    });
    expect(firstIdle.status).toBe("idle");
    if (firstIdle.status !== "idle") throw new Error("expected idle");
    expect(idlePrompt(firstIdle.snapshot)).toBe(
      "Clues: lava, crater, Vesuvius. What is the secret word?",
    );

    // Pass on round 1: no score, and the round advances.
    const secondIdle = await runAgent(justOneMachine, {
      snapshot: firstIdle.persist(),
      event: { type: "PASS" },
      ...shared,
    });
    expect(secondIdle.status).toBe("idle");
    if (secondIdle.status !== "idle") throw new Error("expected idle");
    expect(secondIdle.snapshot.context.score).toBe(0);
    expect(idlePrompt(secondIdle.snapshot)).toBe(
      "Clues: sting, bear, bee. What is the secret word?",
    );

    // Persist mid-guess as JSON, then resume a fresh run from it.
    const serialized = JSON.stringify(secondIdle.persist());
    const resumed = await runAgent(justOneMachine, {
      snapshot: JSON.parse(serialized),
      event: { type: "GUESS", guess: "Honey!" },
      ...shared,
    });

    expect(resumed.status).toBe("done");
    if (resumed.status !== "done") throw new Error("expected done");
    expect(resumed.output.score).toBe(1);
    expect(resumed.output.log).toEqual([
      'Round 1 — secret "volcano". Clues: lava (Iris), crater (Milo), Vesuvius (Nadia).',
      'Passed — the word was "volcano".',
      'Round 2 — secret "honey". Clues: sting (Iris), bear (Milo), bee (Nadia).',
      'Guessed "Honey!" — correct.',
    ]);
  });

  test("isolation: no clue request ever carries another giver's clue", async () => {
    const captured: CapturedRequest[] = [];
    const clues = {
      Iris: ["lava", "sting"],
      Milo: ["crater", "bear"],
      Nadia: ["Vesuvius", "bee"],
    };

    await play({
      input: { rounds: 2, deck: ["volcano", "honey"] },
      script: clues,
      guesserEvents: [
        { type: "GUESS", guess: "volcano" },
        { type: "GUESS", guess: "honey" },
      ],
      captured,
    });

    expect(captured).toHaveLength(6);
    const allClues = Object.values(clues).flat();

    for (const request of captured) {
      expect(request.name).toBe("writeClue");
      // The whole request — system, prompt, messages, everything — is checked:
      // no clue text from ANY giver (including this one's other round) is in it.
      for (const clue of allClues) {
        expect(
          request.serialized.toLowerCase().includes(clue.toLowerCase()),
          `request leaked the clue "${clue}": ${request.prompt}`,
        ).toBe(false);
      }
      // What it does carry: the secret word and exactly one persona.
      expect(request.prompt).toMatch(/^Secret word: (volcano|honey)$/m);
      const personasNamed = PERSONAS.filter((persona) =>
        request.prompt?.includes(`You are ${persona.name}.`),
      );
      expect(personasNamed).toHaveLength(1);
    }
  });
});
