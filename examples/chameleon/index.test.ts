import { describe, expect, test } from "vitest";
import { getStateMeta, runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import {
  type AccuseEvent,
  chameleonMachine,
  idlePrompt,
  isCorrectGuess,
  PLAYERS,
} from "./index.js";

/** Every request the scripted players saw, as the executor received it. */
interface CapturedRequest {
  name?: string;
  system?: string;
  prompt?: string;
  serialized: string;
}

interface Script {
  /** One word per seat, in speaking order. */
  words: string[];
  /** What the chameleon says when it is caught. */
  guess?: string;
}

/**
 * Scripted players. `sayWord` requests arrive strictly in turn order, so the
 * executor can just take the next word off the script.
 */
function createPlayers(script: Script, captured: CapturedRequest[] = []) {
  let turn = 0;
  const executor: AgentRequestExecutor = async (request) => {
    captured.push({
      name: request.name,
      system: request.system,
      prompt: request.prompt,
      serialized: JSON.stringify(request),
    });
    if (request.name === "guessSecret") {
      return { output: { guess: script.guess ?? "", reasoning: "the words all circled it" } };
    }
    const word = script.words[turn] ?? "";
    turn += 1;
    return { output: { word, reasoning: `seat ${turn}` } };
  };
  return { executor, captured };
}

interface PlayOptions {
  input?: { category?: string; secretWord?: string; chameleonIndex?: number };
  script: Script;
  accuse: AccuseEvent;
  captured?: CapturedRequest[];
}

/** Runs the round, votes at the idle state, and returns the finished run. */
async function play(options: PlayOptions) {
  const { executor } = createPlayers(options.script, options.captured);
  const shared = { executors: { generateText: executor } };

  const idle = await runAgent(chameleonMachine, { input: options.input ?? {}, ...shared });
  expect(idle.status).toBe("idle");
  if (idle.status !== "idle") throw new Error(`expected idle, got ${idle.status}`);

  // The idle vote must advertise how a host can unblock it.
  expect(getStateMeta(idle.snapshot).interaction).toBeDefined();
  expect(idle.snapshot.can(options.accuse as never)).toBe(true);
  const prompt = idlePrompt(idle.snapshot);

  const result = await runAgent(chameleonMachine, {
    snapshot: idle.persist(),
    event: options.accuse,
    ...shared,
  });
  if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);
  return { result, prompt, idle };
}

const OCEAN: Script = { words: ["ink", "tentacle", "reef", "suction"], guess: "octopus" };

describe("chameleon", () => {
  test("the chameleon's request never receives the secret word", async () => {
    const captured: CapturedRequest[] = [];
    await play({
      input: { category: "Ocean creatures", secretWord: "octopus", chameleonIndex: 2 },
      script: OCEAN,
      accuse: { type: "ACCUSE_P0" },
      captured,
    });

    const wordRequests = captured.filter((request) => request.name === "sayWord");
    expect(wordRequests).toHaveLength(4);

    // Exactly three requests carry the secret — never seat 2's.
    const carryingSecret = wordRequests
      .map((request, seat) => ({
        seat,
        leaks: request.serialized.toLowerCase().includes("octopus"),
      }))
      .filter((entry) => entry.leaks)
      .map((entry) => entry.seat);
    expect(carryingSecret).toEqual([0, 1, 3]);

    // The whole request — system, prompt, messages, everything — is checked.
    expect(wordRequests[2]!.serialized.toLowerCase()).not.toContain("octopus");
    expect(wordRequests[2]!.prompt).toContain("You do not know the secret word.");
    expect(wordRequests[2]!.system).toContain("You are the CHAMELEON");

    // The public record grows by turn order: seat N sees exactly N words.
    for (const [seat, request] of wordRequests.entries()) {
      expect(request.prompt).toContain(`You speak ${seat + 1} of 4.`);
      for (const [earlier, word] of OCEAN.words.slice(0, seat).entries()) {
        expect(request.prompt).toContain(`${PLAYERS[earlier]}: ${word}`);
      }
      // Nothing said after this seat is visible to it.
      for (const word of OCEAN.words.slice(seat + 1)) {
        expect(request.prompt).not.toContain(word);
      }
    }
  });

  test("a correct accusation gives the chameleon one guess; a wrong guess loses it", async () => {
    const captured: CapturedRequest[] = [];
    const { result, prompt } = await play({
      script: { ...OCEAN, guess: "jellyfish" },
      accuse: { type: "ACCUSE_P2" },
      captured,
    });

    expect(prompt).toBe(
      "Category: Ocean creatures. Ada: ink, Bruno: tentacle, Cleo: reef, Dev: suction. Who is the chameleon?",
    );
    // The steal attempt happens only because the accusation landed.
    const guessRequest = captured.find((request) => request.name === "guessSecret");
    expect(guessRequest).toBeDefined();
    // Even the caught chameleon's request never contains the secret.
    expect(guessRequest!.serialized.toLowerCase()).not.toContain("octopus");

    expect(result.output.outcome).toBe("detectives-win");
    expect(result.output.chameleon).toBe("Cleo");
    expect(result.output.accused).toBe("Cleo");
    expect(result.output.summary).toContain(
      'Detectives win. Cleo was the chameleon and could not name "octopus".',
    );
    expect(result.output.log).toEqual([
      "Category: Ocean creatures. One of Ada, Bruno, Cleo, Dev does not know the secret word.",
      "Words — Ada: ink, Bruno: tentacle, Cleo: reef, Dev: suction.",
      "You accused Cleo.",
      "Caught — Cleo was the chameleon, and gets one guess at the secret word.",
      'Cleo guessed "jellyfish" — wrong. The secret word was "octopus".',
    ]);
  });

  test("a caught chameleon that names the secret steals the win", async () => {
    const { result } = await play({ script: OCEAN, accuse: { type: "ACCUSE_P2" } });

    expect(result.output.outcome).toBe("chameleon-steals");
    expect(result.output.summary).toContain(
      'Chameleon steals it. Cleo was caught, then named "octopus".',
    );
    expect(result.output.log.at(-1)).toBe('Cleo guessed "octopus" — right, and steals the win.');
  });

  test("a wrong accusation lets the chameleon escape without guessing", async () => {
    const captured: CapturedRequest[] = [];
    const { result } = await play({
      script: OCEAN,
      accuse: { type: "ACCUSE_P3" },
      captured,
    });

    expect(captured.some((request) => request.name === "guessSecret")).toBe(false);
    expect(result.output.outcome).toBe("chameleon-escapes");
    expect(result.output.accused).toBe("Dev");
    expect(result.output.summary).toContain(
      "Chameleon escapes. Cleo was the chameleon; you accused Dev.",
    );
  });

  test("the vote snapshot round-trips as JSON and resumes with an accusation", async () => {
    const { executor } = createPlayers({
      words: ["stripes", "roar", "savanna", "whiskers"],
      guess: "lion",
    });
    const shared = { executors: { generateText: executor } };

    const idle = await runAgent(chameleonMachine, {
      input: { category: "Big cats", secretWord: "Lion", chameleonIndex: 0 },
      ...shared,
    });
    expect(idle.status).toBe("idle");
    if (idle.status !== "idle") throw new Error("expected idle");
    expect(idlePrompt(idle.snapshot)).toBe(
      "Category: Big cats. Ada: stripes, Bruno: roar, Cleo: savanna, Dev: whiskers. Who is the chameleon?",
    );

    // Persist mid-vote as JSON, then resume a fresh run from it.
    const resumed = await runAgent(chameleonMachine, {
      snapshot: JSON.parse(JSON.stringify(idle.persist())),
      event: { type: "ACCUSE_P0" },
      ...shared,
    });

    expect(resumed.status).toBe("done");
    if (resumed.status !== "done") throw new Error("expected done");
    // "lion" vs the secret "Lion": the machine normalizes before comparing.
    expect(resumed.output.outcome).toBe("chameleon-steals");
    expect(resumed.output.words.map((entry) => entry.word)).toEqual([
      "stripes",
      "roar",
      "savanna",
      "whiskers",
    ]);
  });

  test("the steal comparison ignores case, punctuation, and plurals", () => {
    expect(isCorrectGuess("Octopus", "octopus")).toBe(true);
    expect(isCorrectGuess("  octopus! ", "octopus")).toBe(true);
    expect(isCorrectGuess("octopuses", "octopus")).toBe(true);
    expect(isCorrectGuess("squid", "octopus")).toBe(false);
    expect(isCorrectGuess("", "octopus")).toBe(false);
    expect(isCorrectGuess("octopus", "")).toBe(false);
  });
});
