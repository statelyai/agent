/**
 * Behavioral sweep: every demo-playable example, every starter chip, driven
 * through the demo's real server path (`startMachineChat`,
 * `resumeMachineChat`, `runExampleRunner`) with the provider layer replaced by
 * deterministic test doubles (`test-generic-models.ts`).
 *
 * Each example's transcript is a golden file under `__snapshots__/`. The sweep
 * pins what a user of the demo sees: the run's status, its transitions, the
 * response text, and what an idle machine asks for. A refactor of how runs are
 * driven must reproduce these files, or change them for a reason a reviewer
 * can read in the diff.
 *
 * The simulated user answers an idle machine by sending its primary-styled
 * event, else its free-text event, else the first event it accepts, with the
 * payload synthesized from the event's JSON Schema. At most MAX_TURNS turns.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Snapshot } from "xstate";
import {
  exampleBudgetMs,
  getExampleDetail,
  getExampleMachine,
  getExampleRunner,
  listExampleSummaries,
} from "./example-library.server";
import {
  resumeMachineChat,
  runExampleRunner,
  startMachineChat,
  type MachineChatResult,
} from "./machine-chat.server";
import type { AcceptedEvent, ChatIdle } from "./machine-ui";
import { resetGenericModels, synthesizeFromSchema } from "./test-generic-models";

vi.mock("@ai-sdk/openai", async () => {
  const { genericLanguageModel } = await import("./test-generic-models");
  const openai = Object.assign((modelId: string) => genericLanguageModel(modelId), {
    chat: (modelId: string) => genericLanguageModel(modelId),
    responses: (modelId: string) => genericLanguageModel(modelId),
  });
  return { openai, createOpenAI: () => openai };
});

vi.mock("@ai-sdk/typesafe-ai", async () => {
  const { genericEvaluationModel } = await import("./test-generic-models");
  const provider = { evaluationModel: () => genericEvaluationModel() };
  return { typeSafeAi: provider, createTypeSafeAi: () => provider };
});

const MAX_TURNS = 8;

beforeAll(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("TYPESAFE_AI_API_KEY", "test-typesafe-key");
  vi.stubEnv("OPENAI_MODEL", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

type TurnRecord = {
  sent: string;
  status: MachineChatResult["status"] | "threw";
  trace: string[];
  response: string;
  idle?: { prompt: string | null; events: string[]; textEvent: string | null };
};

/** Values that differ run to run by design: random ids and temp directories. */
function stable(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\S*stately-agent-snapshots-[A-Za-z0-9]+/g, "<tmpdir>");
}

/** One line per trace entry, with the wall-clock stamp dropped. */
function traceLines(result: MachineChatResult): string[] {
  return result.trace.map((entry) =>
    stable(`${entry.kind ?? "transition"} ${entry.event.type} -> ${JSON.stringify(entry.value)}`),
  );
}

function record(sent: string, result: MachineChatResult): TurnRecord {
  return {
    sent,
    status: result.status,
    trace: traceLines(result),
    response: stable(result.response),
    ...(result.idle
      ? {
          idle: {
            prompt: result.idle.prompt,
            events: result.idle.events.map((event) => event.type),
            textEvent: result.idle.textEvent
              ? `${result.idle.textEvent.type}.${result.idle.textEvent.field}`
              : null,
          },
        }
      : {}),
  };
}

/** The simulated user's reply to an idle machine. */
function replyTo(idle: ChatIdle): { type: string } & Record<string, unknown> {
  const primary = idle.events.find((event) => event.style === "primary");
  const textual = idle.textEvent
    ? idle.events.find((event) => event.type === idle.textEvent!.type)
    : undefined;
  const chosen: AcceptedEvent = primary ?? textual ?? idle.events[0]!;
  if (idle.textEvent && idle.textEvent.type === chosen.type) {
    return { type: chosen.type, [idle.textEvent.field]: "Yes, that works. Please continue." };
  }
  const payload = chosen.jsonSchema
    ? (synthesizeFromSchema(chosen.jsonSchema) as Record<string, unknown>)
    : {};
  return { ...payload, type: chosen.type };
}

const playable = listExampleSummaries().filter((summary) => summary.starters.length > 0);

describe.each(playable.map((summary) => [summary.id] as const))("%s", (id) => {
  test("every starter plays through the demo the same way", { timeout: 60_000 }, async () => {
    const detail = await getExampleDetail(id);
    expect(detail.importError).toBeNull();
    const budgetMs = exampleBudgetMs(id);
    const transcripts: Record<string, TurnRecord[]> = {};

    for (const starter of detail.starters) {
      resetGenericModels();
      const turns: TurnRecord[] = [];
      transcripts[starter.label] = turns;

      if (starter.kind === "runner") {
        const runner = await getExampleRunner(id, starter.exportName);
        turns.push(
          record(`runner ${starter.exportName}`, await runExampleRunner(runner, { budgetMs })),
        );
        continue;
      }

      const target = detail.machines[0];
      expect(target, `${id} exposes a machine`).toBeDefined();
      const machine = await getExampleMachine(id, target!.exportName);
      const input =
        starter.kind === "text"
          ? target!.promptField
            ? { [target!.promptField]: starter.text }
            : {}
          : starter.input;

      let result: MachineChatResult;
      try {
        result = await startMachineChat(machine, input, { budgetMs });
      } catch (error) {
        turns.push({ sent: "start", status: "threw", trace: [], response: String(error) });
        continue;
      }
      turns.push(record(`start ${JSON.stringify(input)}`, result));

      for (let turn = 1; turn < MAX_TURNS && result.status === "idle" && result.idle; turn++) {
        const event = replyTo(result.idle);
        try {
          result = await resumeMachineChat(
            machine,
            result.idle.snapshot as unknown as Snapshot<unknown>,
            event,
            { budgetMs },
          );
        } catch (error) {
          turns.push({
            sent: JSON.stringify(event),
            status: "threw",
            trace: [],
            response: String(error),
          });
          break;
        }
        turns.push(record(JSON.stringify(event), result));
      }
    }

    await expect(JSON.stringify(transcripts, null, 2) + "\n").toMatchFileSnapshot(
      `./__snapshots__/example-behavior/${id}.json`,
    );
  });
});
