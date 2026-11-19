import { describe, expect, test } from "vitest";
import { createAsyncLogic, setup } from "xstate";
import { consensusReviewMachine } from "../examples/consensus-review/index.js";
import { z } from "zod";
import { describeMachine } from "./describe-machine.js";
import { setupAgent } from "./setup-agent.js";
import type { StandardSchemaV1 } from "./types.js";
import type { SchemaCompiler } from "./workflow-config.js";

const compileSchema: SchemaCompiler = () =>
  ({
    "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
  }) as StandardSchemaV1;

// A transition that returns a helper's result names no target in its own source.
const pickRetry = (context: { retries: number }) =>
  context.retries > 1 ? { target: "uploading" as const } : undefined;

const uploadMachine = setupAgent({
  context: z.object({ retries: z.number() }),
  actors: { send: createAsyncLogic({ run: async () => "ok" }) },
  delays: { patience: 30_000 },
}).createMachine({
  id: "upload",
  context: { retries: 0 },
  initial: "idle",
  on: { CANCEL: { target: ".cancelled" } },
  states: {
    idle: { on: { START: { target: "uploading" } } },
    uploading: {
      type: "parallel",
      states: {
        file: {
          initial: "sending",
          states: {
            sending: {
              invoke: {
                src: "send",
                onDone: { target: "done" },
                onError: ({ context }) =>
                  context.retries < 3
                    ? { target: "sending", context: { retries: context.retries + 1 } }
                    : { target: "#upload.failed" },
              },
            },
            done: { type: "final" },
          },
        },
        thumbnail: {
          initial: "rendering",
          states: {
            rendering: { after: { patience: { target: "done" } } },
            done: { type: "final" },
          },
        },
      },
      onDone: { target: "checking" },
    },
    checking: {
      always: ({ context }) => (context.retries > 0 ? { target: "failed" } : { target: "done" }),
    },
    done: { type: "final" },
    failed: {
      on: {
        RETRY: ({ context }) => pickRetry(context),
        // A literal that names no state node (the types reject it, the runtime would too).
        SKIP: (() => ({ target: "nowhere" })) as never,
      },
    },
    cancelled: { type: "final" },
  },
});

describe("describeMachine format: mermaid", () => {
  test("text stays the default", () => {
    expect(describeMachine(uploadMachine, { format: "text" })).toBe(describeMachine(uploadMachine));
    expect(describeMachine(uploadMachine).startsWith("Machine upload")).toBe(true);
  });

  test("renders nested, parallel, final, always, after, invoke and unknown targets", () => {
    expect(describeMachine(uploadMachine, { format: "mermaid" })).toMatchInlineSnapshot(`
      "stateDiagram-v2
        [*] --> idle
        idle
        state uploading {
          state file {
            [*] --> sending
            sending
            state "done" as uploading_file_done
            uploading_file_done --> [*]
            sending --> uploading_file_done : send done
            sending --> sending : send error?
          }
          --
          state thumbnail {
            [*] --> rendering
            rendering
            state "done" as uploading_thumbnail_done
            uploading_thumbnail_done --> [*]
            rendering --> uploading_thumbnail_done : after patience (30s)
          }
        }
        checking
        done
        failed
        cancelled
        done --> [*]
        cancelled --> [*]
        state "any state" as any_state
        any_state --> cancelled : CANCEL
        idle --> uploading : START
        uploading --> checking : onDone
        sending --> failed : send error?
        checking --> failed : always?
        checking --> done : always?
        state "?" as failed_unknown
        failed --> failed_unknown : RETRY
        state "nowhere ?" as failed_unknown_2
        failed --> failed_unknown_2 : SKIP
        classDef unknown stroke-dasharray:5
        class failed_unknown,failed_unknown_2 unknown"
    `);
  });

  test("a choice state is a choice node; guards label its branches", () => {
    const { machine } = setupAgent.fromConfig(
      {
        id: "ticket",
        schemas: { context: { type: "object" } },
        context: {},
        initial: "checking",
        states: {
          checking: {
            type: "choice",
            choice: [
              { guard: "{{ context.approved }}", target: "sent" },
              { guard: "isRetryable", target: "checking" },
              { target: "escalated" },
            ],
          },
          sent: { type: "final", on: {} },
          escalated: { on: { "REOPEN: now": { target: "checking" } } },
        },
      },
      { compileSchema, guards: { isRetryable: () => true } },
    );
    expect(describeMachine(machine, { format: "mermaid" })).toMatchInlineSnapshot(`
      "stateDiagram-v2
        [*] --> checking
        state checking <<choice>>
        sent
        escalated
        sent --> [*]
        checking --> sent : [context.approved]
        checking --> checking : [isRetryable]
        checking --> escalated : else
        escalated --> checking : REOPEN#58; now"
    `);
  });

  test("ids are sanitized and labels escaped", () => {
    const machine = setup({}).createMachine({
      id: "odd",
      initial: "first step",
      states: {
        "first step": { on: { 'say "hi"; go': { target: "state" } } },
        state: { on: { "a<b>": { target: "2fa" } } },
        "2fa": {},
      },
    });
    expect(describeMachine(machine, { format: "mermaid" })).toMatchInlineSnapshot(`
      "stateDiagram-v2
        [*] --> first_step
        state "first step" as first_step
        state "state" as s_state
        state "2fa" as s_2fa
        first_step --> s_state : say #quot;hi#quot;#59; go
        s_state --> s_2fa : a#lt;b#gt;"
    `);
  });

  test("marks the active states from a snapshot", () => {
    const snapshot = uploadMachine.resolveState({
      value: { uploading: { file: "sending", thumbnail: "done" } },
      context: { retries: 0 },
    });
    const lines = describeMachine(uploadMachine, { format: "mermaid", snapshot }).split("\n");
    expect(lines.slice(-2)).toEqual([
      "  classDef active font-weight:bold,stroke-width:3px",
      "  class uploading,file,sending,thumbnail,uploading_thumbnail_done active",
    ]);
  });

  test("a parallel root is wrapped in a composite state", () => {
    const machine = setup({}).createMachine({
      id: "player",
      type: "parallel",
      states: {
        audio: {
          initial: "muted",
          states: { muted: { on: { UNMUTE: { target: "on" } } }, on: {} },
        },
        video: { initial: "paused", states: { paused: {} } },
      },
    });
    expect(describeMachine(machine, { format: "mermaid" })).toMatchInlineSnapshot(`
      "stateDiagram-v2
        state player {
          state audio {
            [*] --> muted
            muted
            on
            muted --> on : UNMUTE
          }
          --
          state video {
            [*] --> paused
            paused
          }
        }"
    `);
  });

  test("renders a realistic example machine", () => {
    expect(describeMachine(consensusReviewMachine, { format: "mermaid" })).toMatchInlineSnapshot(`
      "stateDiagram-v2
        [*] --> reviewing
        state reviewing {
          state security {
            [*] --> reviewing_security_working
            state "working" as reviewing_security_working
            state "done" as reviewing_security_done
            reviewing_security_done --> [*]
            state "?" as reviewing_security_working_unknown
            reviewing_security_working --> reviewing_security_working_unknown : security done
            reviewing_security_working --> reviewing_security_done : security error
          }
          --
          state reliability {
            [*] --> reviewing_reliability_working
            state "working" as reviewing_reliability_working
            state "done" as reviewing_reliability_done
            reviewing_reliability_done --> [*]
            state "?" as reviewing_reliability_working_unknown
            reviewing_reliability_working --> reviewing_reliability_working_unknown : reliability done
            reviewing_reliability_working --> reviewing_reliability_done : reliability error
          }
          --
          state maintainability {
            [*] --> reviewing_maintainability_working
            state "working" as reviewing_maintainability_working
            state "done" as reviewing_maintainability_done
            reviewing_maintainability_done --> [*]
            state "?" as reviewing_maintainability_working_unknown
            reviewing_maintainability_working --> reviewing_maintainability_working_unknown : maintainability done
            reviewing_maintainability_working --> reviewing_maintainability_done : maintainability error
          }
        }
        state counting <<choice>>
        humanReview
        accepted
        overridden
        rejected
        accepted --> [*]
        overridden --> [*]
        rejected --> [*]
        reviewing --> counting : onDone
        counting --> accepted
        counting --> humanReview
        humanReview --> overridden : APPROVE
        humanReview --> rejected : REJECT
        classDef unknown stroke-dasharray:5
        class reviewing_security_working_unknown,reviewing_reliability_working_unknown,reviewing_maintainability_working_unknown unknown"
    `);
  });
});
