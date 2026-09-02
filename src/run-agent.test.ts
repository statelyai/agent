import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createAsyncLogic, setup, toPromise, type Snapshot } from "xstate";
import { createDecisionLogic } from "./decision.js";
import {
  AGENT_TRACE_SCHEMA_VERSION,
  AgentError,
  AgentIdleError,
  createAgentSchemas,
  createTextLogic,
  AgentIllegalResumeEventError,
  inspectTransitions,
  runAgent,
  setupAgent,
  type AgentDecisionRequest,
  type AgentTextRequest,
  type AgentTools,
  type AgentTraceEvent,
  type ChosenEvent,
} from "./index.js";
import { createAgentActor, generateResult } from "./run-agent.js";
import { getMachineStructuralHash } from "./index.js";

describe("runAgent", () => {
  test("done path: completes with typed output from a TextLogic invoke", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ answer: z.string() }),
    });

    const answerQuestion = createTextLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: z.object({ answer: z.string() }),
      },
      model: "test-model",
      prompt: ({ input }) => input.prompt,
    });

    const agent = setupAgent({ schemas, actors: { answerQuestion } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, answer: null }),
      initial: "answering",
      states: {
        answering: {
          invoke: {
            id: "answer",
            src: "answerQuestion",
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: "done",
              context: { answer: output.answer },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ answer: context.answer ?? "" }),
        },
      },
    });

    const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => ({
      output: { answer: `Answered: ${request.prompt}` },
    });

    const observedEvents: string[] = [];
    const result = await runAgent(machine, {
      input: { prompt: "why state machines?" },
      executors: {
        generateText,
      },
      onTransition: (_snapshot, event) => observedEvents.push(event.type),
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({
      answer: "Answered: why state machines?",
    });
    expect(observedEvents).toContain("@xstate.init");
    expect(observedEvents).toContain("xstate.done.actor");
  });

  test("idle + resume: settles idle waiting for an event, then completes on resume", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), draft: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ draft: z.string() }),
      events: { APPROVE: z.object({}) },
    });

    const draftText = createTextLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: z.string(),
      },
      model: "test-model",
      prompt: ({ input }) => input.prompt,
    });

    const agent = setupAgent({ schemas, actors: { draftText } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            id: "draft",
            src: "draftText",
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: "awaitingApproval",
              context: { draft: output },
            }),
          },
        },
        awaitingApproval: {
          on: { APPROVE: { target: "done" } },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ draft: context.draft ?? "" }),
        },
      },
    });

    const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => ({
      output: `Draft: ${request.prompt}`,
    });

    const first = await runAgent(machine, {
      input: { prompt: "release notes" },
      executors: {
        generateText,
      },
    });

    expect(first.status).toBe("idle");
    if (first.status !== "idle") {
      throw new Error("expected idle");
    }
    expect(first.snapshot.value).toBe("awaitingApproval");

    const second = await runAgent(machine, {
      snapshot: first.persist(),
      event: { type: "APPROVE" },
      executors: {
        generateText,
      },
    });

    expect(second.status).toBe("done");
    expect(second.status === "done" ? second.output : undefined).toEqual({
      draft: "Draft: release notes",
    });
  });

  test("onTransition observes raised events and timer deliveries", async () => {
    const raisedMachine = setup({}).createMachine({
      id: "raised-events",
      initial: "starting",
      states: {
        starting: {
          entry: (_args, enqueue) => enqueue.raise({ type: "CONTINUE" }),
          on: { CONTINUE: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    const raisedEvents: string[] = [];
    const raised = await runAgent(raisedMachine, {
      input: undefined,
      executors: {},
      onTransition: (_snapshot, event) => raisedEvents.push(event.type),
    });
    expect(raised.status).toBe("done");
    expect(raisedEvents).toEqual(["@xstate.init"]);

    const timerMachine = setup({}).createMachine({
      id: "timer-events",
      initial: "waiting",
      states: {
        waiting: { after: { 5: { target: "done" } } },
        done: { type: "final" },
      },
    });

    const timerEvents: string[] = [];
    const timed = await runAgent(timerMachine, {
      input: undefined,
      executors: {},
      onTransition: (_snapshot, event) => timerEvents.push(event.type),
    });
    expect(timed.status).toBe("done");
    expect(timerEvents).toContain("xstate.timer");
  });

  test("idle + resume: pre-idle side effects and model calls run exactly once, never re-executed on resume", async () => {
    // LangGraph's documented HITL gotcha: code before an inline interrupt()
    // re-executes when the node resumes, so side effects must be manually
    // isolated. Idle-first HITL cannot have this failure mode: the resumed
    // snapshot starts AT the idle state, so states before it never re-enter.
    // This test pins that guarantee.
    let sideEffectRuns = 0;
    let modelCalls = 0;

    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string(), draft: z.string().nullable() }),
      input: z.object({ topic: z.string() }),
      output: z.object({ draft: z.string() }),
      events: { APPROVE: z.object({}), REJECT: z.object({}) },
    });

    const draftText = createTextLogic({
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.string(),
      },
      model: "test-model",
      prompt: ({ input }) => input.topic,
    });

    const agent = setupAgent({
      schemas,
      actors: {
        draftText,
        recordAudit: createAsyncLogic<{ recorded: boolean }, unknown>({
          run: async () => {
            sideEffectRuns += 1;
            return { recorded: true };
          },
        }),
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, draft: null }),
      initial: "auditing",
      states: {
        auditing: {
          invoke: {
            id: "audit",
            src: "recordAudit",
            onDone: { target: "drafting" },
          },
        },
        drafting: {
          invoke: {
            id: "draft",
            src: "draftText",
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: "awaitingApproval",
              context: { draft: output },
            }),
          },
        },
        awaitingApproval: {
          on: {
            APPROVE: { target: "done" },
            REJECT: { target: "drafting" },
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ draft: context.draft ?? "" }),
        },
      },
    });

    const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => {
      modelCalls += 1;
      return { output: `Draft about ${request.prompt}` };
    };

    const first = await runAgent(machine, {
      input: { topic: "incident recap" },
      executors: {
        generateText,
      },
    });
    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");
    expect(sideEffectRuns).toBe(1);
    expect(modelCalls).toBe(1);

    // Full JSON round-trip: the resume must not depend on live actor state.
    const persisted = JSON.parse(JSON.stringify(first.snapshot));

    const second = await runAgent(machine, {
      snapshot: persisted,
      event: { type: "APPROVE" },
      executors: {
        generateText,
      },
    });

    expect(second.status).toBe("done");
    expect(sideEffectRuns).toBe(1); // audit never re-ran
    expect(modelCalls).toBe(1); // draft never re-billed
    expect(second.status === "done" ? second.output : undefined).toEqual({
      draft: "Draft about incident recap",
    });

    // The loop is still real: an explicit REJECT deliberately re-enters
    // drafting, so the model runs again by AUTHORED choice, not by accident.
    const third = await runAgent(machine, {
      snapshot: persisted,
      event: { type: "REJECT" },
      executors: {
        generateText,
      },
    });
    expect(third.status).toBe("idle");
    expect(sideEffectRuns).toBe(1); // audit STILL exactly once
    expect(modelCalls).toBe(2); // redraft was an explicit transition
  });

  test("decision path: guard-rejected event retried, then completes; canTake wired through the live actor", async () => {
    const attackSchema = z.object({ target: z.string() });
    const healSchema = z.object({});

    const schemas = createAgentSchemas({
      context: z.object({ hp: z.number() }),
      input: z.object({}),
      events: { ATTACK: attackSchema, HEAL: healSchema },
    });

    const chooseMove = createDecisionLogic({
      model: "test-model",
      prompt: "Choose a move.",
      allowedEvents: ["ATTACK", "HEAL"] as const,
    });

    const agent = setupAgent({ schemas, actors: { chooseMove } });
    const machine = agent.createMachine({
      context: { hp: 10 },
      initial: "choosingMove",
      states: {
        choosingMove: {
          invoke: {
            id: "choosingMove",
            src: "chooseMove",
            input: {},
            onError: { target: "fumbled" },
          },
          on: {
            // HEAL only legal when hp < 5 — guard rejects it at hp = 10.
            HEAL: ({ context }) => (context.hp < 5 ? { target: "healed" } : undefined),
            ATTACK: { target: "attacked" },
          },
        },
        attacked: { type: "final" },
        healed: {},
        fumbled: {},
      },
    });

    let callCount = 0;
    const requestsSeen: AgentDecisionRequest[] = [];
    const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      requestsSeen.push(request);
      callCount += 1;
      if (callCount === 1) {
        // Type + payload legal, but guard-rejected (hp is not < 5).
        return { event: { type: "HEAL" } };
      }
      return { event: { type: "ATTACK", target: "goblin" } };
    };

    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
        decide,
      },
    });

    expect(result.status).toBe("done");
    expect(callCount).toBe(2);
    expect(requestsSeen[1]!.attempts[0]!.failure).toBe("rejected-by-guard");
  });

  test("maxModelCalls: exceeding the budget settles a max-model-calls error", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ count: z.number() }),
      input: z.object({}),
      output: z.object({ count: z.number() }),
    });

    const step = createTextLogic({
      schemas: {
        input: z.object({}),
        output: z.number(),
      },
      model: "test-model",
      prompt: "step",
    });

    const agent = setupAgent({ schemas, actors: { step } });
    const machine = agent.createMachine({
      context: { count: 0 },
      initial: "looping",
      states: {
        looping: {
          invoke: {
            id: "step",
            src: "step",
            input: {},
            onDone: ({ output }) => ({
              target: "looping",
              reenter: true,
              context: { count: output as number },
            }),
          },
        },
      },
    });

    let calls = 0;
    const result = await runAgent(machine, {
      input: {},
      maxModelCalls: 3,
      executors: {
        generateText: async () => {
          calls += 1;
          return { output: calls };
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("max-model-calls");
  });

  test("maxModelCalls: the overrun is a typed AgentError an invoke's onError can branch on", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ calls: z.number(), budgetSpent: z.boolean() }),
      input: z.object({}),
      output: z.object({ calls: z.number(), budgetSpent: z.boolean() }),
    });

    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.number() },
      model: "test-model",
      prompt: "step",
    });

    const agent = setupAgent({ schemas, actors: { step } });
    const machine = agent.createMachine({
      context: { calls: 0, budgetSpent: false },
      initial: "looping",
      states: {
        looping: {
          invoke: {
            id: "step",
            src: "step",
            input: {},
            onDone: ({ context }) => ({
              target: "looping",
              reenter: true,
              context: { calls: context.calls + 1 },
            }),
            // The budget breach is branchable: a typed AgentError whose `code`
            // is the same string the settled result's `cause` uses.
            onError: ({ event }) =>
              (event.error as { code?: string })?.code === "max-model-calls"
                ? { target: "budgetSpent", context: { budgetSpent: true } }
                : { target: "failed" },
          },
        },
        budgetSpent: {
          type: "final",
          output: ({ context }) => context,
        },
        failed: { type: "final", output: ({ context }) => context },
      },
    });

    let calls = 0;
    const result = await runAgent(machine, {
      input: {},
      maxModelCalls: 2,
      executors: {
        generateText: async () => {
          calls += 1;
          return { output: calls };
        },
      },
    });

    // Handled: the run completes normally instead of settling an error.
    expect(result.status).toBe("done");
    expect(result.status === "done" && result.output).toEqual({ calls: 2, budgetSpent: true });
    expect(calls).toBe(2);
  });

  test("abort: a pre-aborted signal settles an aborted error", async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: "test-model",
      prompt: "work",
    });
    const agent = setupAgent({ schemas, actors: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: "working",
      states: {
        working: {
          invoke: { id: "step", src: "step", input: {}, onDone: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    const controller = new AbortController();
    controller.abort();

    const result = await runAgent(machine, {
      input: {},
      signal: controller.signal,
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("aborted");
  });

  test("abort: aborting mid-run settles an aborted error", async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: "test-model",
      prompt: "work",
    });
    const agent = setupAgent({ schemas, actors: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: "working",
      states: {
        working: {
          invoke: { id: "step", src: "step", input: {}, onDone: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    const controller = new AbortController();
    const resultPromise = runAgent(machine, {
      input: {},
      signal: controller.signal,
      executors: {
        generateText: () =>
          new Promise((resolveExec) => {
            setTimeout(() => resolveExec({ output: {} }), 50);
          }),
      },
    });
    setTimeout(() => controller.abort(), 5);

    const result = await resultPromise;
    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("aborted");
  });

  test("machine error: an executor throw with no onError settles a machine error", async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: "test-model",
      prompt: "work",
    });
    const agent = setupAgent({ schemas, actors: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: "working",
      states: {
        working: {
          invoke: { id: "step", src: "step", input: {}, onDone: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => {
          throw new Error("boom");
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("machine");
    expect(
      result.status === "error" && result.error instanceof Error ? result.error.message : undefined,
    ).toBe("boom");
  });

  describe("bind-time throws", () => {
    test("a direct-object src with its own executor binds fine (no throw)", async () => {
      const summarize = createTextLogic(
        {
          schemas: {
            input: z.object({ topic: z.string() }),
            output: z.string(),
          },
          model: "test-model",
          prompt: ({ input }) => input.topic,
        },
        async () => ({ output: "a summary" }),
      );

      const machine = setup({}).createMachine({
        id: "direct-object",
        initial: "working",
        states: {
          working: {
            invoke: {
              id: "summarize",
              src: summarize,
              input: { topic: "state machines" },
              onDone: { target: "done" },
            },
          },
          done: { type: "final" },
        },
      });

      const result = await runAgent(machine, {
        executors: {
          generateText: async () => ({ output: {} }),
        },
      });
      expect(result.status).toBe("done");
    });

    test("a machine invoking a decision with no decide option throws naming the source", async () => {
      const schemas = createAgentSchemas({
        context: z.object({}),
        input: z.object({}),
        events: { ATTACK: z.object({}) },
      });
      const chooseMove = createDecisionLogic({ model: "test-model" });
      const agent = setupAgent({ schemas, actors: { chooseMove } });
      const machine = agent.createMachine({
        context: {},
        initial: "choosingMove",
        states: {
          choosingMove: {
            invoke: { id: "choosingMove", src: "chooseMove", input: {} },
            on: { ATTACK: { target: "done" } },
          },
          done: { type: "final" },
        },
      });

      await expect(
        runAgent(machine, { input: {}, executors: { generateText: async () => ({ output: {} }) } }),
      ).rejects.toThrow(/chooseMove/);
    });

    test("a machine invoking agent.userInput with no userInput option settles idle with pendingUserInputs (blessed placeholder, not a bind error)", async () => {
      const schemas = createAgentSchemas({
        context: z.object({ feedback: z.string().nullable() }),
        input: z.object({}),
        output: z.object({}),
      });
      const agent = setupAgent({ schemas });
      const machine = agent.createMachine({
        context: { feedback: null },
        initial: "asking",
        states: {
          asking: {
            invoke: {
              id: "ask",
              src: "agent.userInput",
              input: { prompt: "How was it?" },
              onDone: { target: "done" },
            },
          },
          done: { type: "final" },
        },
      });

      const result = await runAgent(machine, {
        input: {},
        executors: {
          generateText: async () => ({ output: {} }),
        },
      });

      expect(result.status).toBe("idle");
      if (result.status !== "idle") throw new Error("expected idle");
      expect(result.pendingUserInputs).toEqual([{ id: "ask", input: { prompt: "How was it?" } }]);
      expect(result.persist()).toBeDefined();
    });

    test("a machine invoking an unregistered string src throws naming the source", async () => {
      const machine = setup({}).createMachine({
        id: "unregistered",
        initial: "working",
        states: {
          working: {
            invoke: {
              id: "x",
              src: "notRegistered",
              onDone: { target: "done" },
            } as never,
          },
          done: { type: "final" },
        },
      });

      await expect(
        runAgent(machine, {
          input: undefined,
          executors: { generateText: async () => ({ output: {} }) },
        }),
      ).rejects.toThrow(/notRegistered/);
    });

    test("a STREAM-mode TextLogic invoke with no streamText option throws naming the source", async () => {
      const streamSummary = createTextLogic({
        mode: "stream",
        schemas: { input: z.object({}), output: z.string() },
        model: "test-model",
        prompt: "summarize",
      });
      const agent = setupAgent({
        schemas: createAgentSchemas({ context: z.object({}), input: z.object({}) }),
        actors: { streamSummary },
      });
      const machine = agent.createMachine({
        context: {},
        initial: "streaming",
        states: {
          streaming: {
            invoke: {
              id: "streamSummary",
              src: "streamSummary",
              input: {},
              onDone: { target: "done" },
            },
          },
          done: { type: "final" },
        },
      });

      await expect(
        runAgent(machine, { input: {}, executors: { generateText: async () => ({ output: {} }) } }),
      ).rejects.toThrow(/streamSummary/);
    });

    test("a direct-object invoke src that is an agent logic WITHOUT its own executor throws", async () => {
      const summarize = createTextLogic({
        schemas: { input: z.object({ topic: z.string() }), output: z.string() },
        model: "test-model",
        prompt: ({ input }) => input.topic,
      });

      const machine = setup({}).createMachine({
        id: "direct-object-no-executor",
        initial: "working",
        states: {
          working: {
            invoke: {
              id: "summarize",
              src: summarize,
              input: { topic: "state machines" },
              onDone: { target: "done" },
            },
          },
          done: { type: "final" },
        },
      });

      await expect(
        runAgent(machine, { executors: { generateText: async () => ({ output: {} }) } }),
      ).rejects.toThrow(/direct-object/);
    });

    // A child machine whose states invoke agent requests is opaque to the
    // parent-level source walk. Child requests do NOT inherit the parent
    // runAgent's executors at runtime (verified by probe: an unbound child
    // request settles the run 'error'/parks it), so the bind walk must
    // descend into invoked child machines and fail fast when a child request
    // has no host execution of its own.
    describe("child-machine recursion", () => {
      // Builds a child machine that invokes `researchTopic` by name. When
      // `bindChildRequest` is true, the request carries its own executor
      // (via nested `.provide` + `.withExecutor`) so it runs itself.
      const makeChildMachine = (bindChildRequest: boolean, depth = 1) => {
        const researchTopic = createTextLogic({
          schemas: { input: z.object({ topic: z.string() }), output: z.string() },
          model: "test-model",
          prompt: ({ input }) => input.topic,
        });
        const childAgent = setupAgent({
          context: z.object({ topic: z.string(), research: z.string().nullable() }),
          input: z.object({ topic: z.string() }),
          output: z.object({ research: z.string() }),
          actors: { researchTopic },
        });
        let childMachine = childAgent.createMachine({
          id: `child-${depth}`,
          context: ({ input }) => ({ topic: input.topic, research: null }),
          initial: "researching",
          states: {
            researching: {
              invoke: {
                src: "researchTopic",
                input: ({ context }) => ({ topic: context.topic }),
                onDone: ({ output }) => ({
                  target: "done",
                  context: { research: output },
                }),
              },
            },
            done: {
              type: "final",
              output: ({ context }) => ({ research: context.research ?? "" }),
            },
          },
        });
        if (bindChildRequest) {
          childMachine = childMachine.provide({
            actors: {
              researchTopic: researchTopic.withExecutor(async ({ input }) => ({
                output: `Research: ${input.topic}`,
              })),
            },
          });
        }
        return childMachine;
      };

      const makeParentMachine = (childMachine: ReturnType<typeof makeChildMachine>) => {
        const parentAgent = setupAgent({
          context: z.object({ topic: z.string(), research: z.string().nullable() }),
          input: z.object({ topic: z.string() }),
          output: z.object({ research: z.string() }),
          actors: { child: childMachine },
        });
        return parentAgent.createMachine({
          id: "parent",
          context: ({ input }) => ({ topic: input.topic, research: null }),
          initial: "delegating",
          states: {
            delegating: {
              invoke: {
                src: "child",
                input: ({ context }: { context: { topic: string } }) => ({
                  topic: context.topic,
                }),
                onDone: ({ output }) => ({
                  target: "done",
                  context: { research: (output as { research: string }).research },
                }),
              },
            },
            done: {
              type: "final",
              output: ({ context }) => ({ research: context.research ?? "" }),
            },
          },
        });
      };

      test("(1) an UNBOUND child request inherits the parent generateText and runs to done", async () => {
        const parentMachine = makeParentMachine(makeChildMachine(false));

        const result = await runAgent(parentMachine, {
          input: { topic: "agents" },
          executors: {
            generateText: async ({ prompt }) => ({ output: `parent-ran: ${prompt}` }),
          },
        });

        expect(result.status).toBe("done");
        expect(result.status === "done" ? result.output : undefined).toEqual({
          research: "parent-ran: agents",
        });
      });

      test("(2) a child with its own .withExecutor keeps it (parent generateText NOT called for it)", async () => {
        const parentMachine = makeParentMachine(makeChildMachine(true));

        let parentCalls = 0;
        const result = await runAgent(parentMachine, {
          input: { topic: "agents" },
          executors: {
            generateText: async () => {
              parentCalls += 1;
              return { output: "unused" };
            },
          },
        });

        expect(result.status).toBe("done");
        expect(result.status === "done" ? result.output : undefined).toEqual({
          research: "Research: agents",
        });
        expect(parentCalls).toBe(0);
      });

      test("(3) grandchild depth: an unbound request in a child-of-child inherits and runs to done", async () => {
        // Grandchild (depth 2) has an unbound request; child (depth 1)
        // invokes the grandchild; parent invokes the child.
        const grandchild = makeChildMachine(false, 2);

        const midAgent = setupAgent({
          context: z.object({ topic: z.string(), research: z.string().nullable() }),
          input: z.object({ topic: z.string() }),
          output: z.object({ research: z.string() }),
          actors: { grandchild },
        });
        const midMachine = midAgent.createMachine({
          id: "mid",
          context: ({ input }) => ({ topic: input.topic, research: null }),
          initial: "delegating",
          states: {
            delegating: {
              invoke: {
                src: "grandchild",
                input: ({ context }: { context: { topic: string } }) => ({
                  topic: context.topic,
                }),
                onDone: ({ output }) => ({
                  target: "done",
                  context: { research: (output as { research: string }).research },
                }),
              },
            },
            done: {
              type: "final",
              output: ({ context }) => ({ research: context.research ?? "" }),
            },
          },
        });

        const parentMachine = makeParentMachine(
          midMachine as unknown as ReturnType<typeof makeChildMachine>,
        );

        // The grandchild's unbound `researchTopic` inherits the top-level
        // generateText through parent > mid > grandchild (all string-keyed).
        const result = await runAgent(parentMachine, {
          input: { topic: "agents" },
          executors: {
            generateText: async ({ prompt }) => ({ output: `depth: ${prompt}` }),
          },
        });

        expect(result.status).toBe("done");
        expect(result.status === "done" ? result.output : undefined).toEqual({
          research: "depth: agents",
        });
      });

      test("(4) a recursively self-invoking machine does not infinite-loop the bind walk", async () => {
        // A machine that invokes itself by name (cycle). The bind walk must
        // terminate via the visited-set guard rather than recurse forever.
        const selfAgent = setupAgent({
          context: z.object({ n: z.number() }),
          input: z.object({ n: z.number() }),
          output: z.object({}),
        });
        const selfMachine = selfAgent.createMachine({
          id: "self",
          context: ({ input }) => ({ n: input.n }),
          initial: "looping",
          states: {
            looping: {
              invoke: {
                src: "self",
                input: ({ context }: { context: { n: number } }) => ({ n: context.n - 1 }),
                onDone: { target: "done" },
              } as never,
            },
            done: { type: "final", output: {} },
          },
        });
        // Make the 'self' source resolve to the machine itself, creating a
        // genuine identity cycle for the bind walk to guard against. Mutating
        // sources in place (rather than .provide, which returns a new
        // object) keeps the invoked source === the machine being walked.
        (selfMachine.sources.actors as Record<string, unknown>).self = selfMachine;

        // The point under test is the BIND walk (the visited-set guard): it
        // must return rather than recurse forever on the identity cycle. A
        // pre-aborted signal settles the run right after binding, so reaching
        // any settled result at all proves the bind walk terminated (an
        // infinite bind loop would throw a RangeError / hang before this).
        const result = await runAgent(selfMachine, {
          input: { n: 0 },
          signal: AbortSignal.abort(),
          executors: {
            generateText: async () => ({ output: "x" }),
          },
        });
        expect(["done", "idle", "error"]).toContain(result.status);
      });

      test("(5) child requests count toward maxModelCalls and appear in onTrace", async () => {
        const parentMachine = makeParentMachine(makeChildMachine(false));

        // The child's single inherited model call shows up in onTrace with the
        // child request's own src.
        const trace: AgentTraceEvent<typeof parentMachine>[] = [];
        const ok = await runAgent(parentMachine, {
          input: { topic: "agents" },
          onTrace: (event) => trace.push(event),
          executors: {
            generateText: async () => ({ output: "y" }),
          },
        });
        expect(ok.status).toBe("done");
        expect(
          trace
            .filter((event) => event.type === "request.start")
            .map((event) => (event.request as { src?: string }).src),
        ).toContain("researchTopic");

        // ...and it draws from the SAME shared budget: capping at 0 makes the
        // child's model call exceed it, settling a max-model-calls error.
        const capped = await runAgent(parentMachine, {
          input: { topic: "agents" },
          maxModelCalls: 0,
          executors: {
            generateText: async () => ({ output: "y" }),
          },
        });
        expect(capped.status).toBe("error");
        expect(capped.status === "error" ? capped.cause : undefined).toBe("max-model-calls");
      });

      test("(6) a missing streamText for a child STREAM request throws at bind naming the chain", async () => {
        const streamResearch = createTextLogic({
          mode: "stream",
          schemas: { input: z.object({ topic: z.string() }), output: z.string() },
          model: "test-model",
          prompt: ({ input }) => input.topic,
        });
        const childAgent = setupAgent({
          context: z.object({ topic: z.string(), research: z.string().nullable() }),
          input: z.object({ topic: z.string() }),
          output: z.object({ research: z.string() }),
          actors: { streamResearch },
        });
        const streamChild = childAgent.createMachine({
          id: "stream-child",
          context: ({ input }) => ({ topic: input.topic, research: null }),
          initial: "researching",
          states: {
            researching: {
              invoke: {
                src: "streamResearch",
                input: ({ context }) => ({ topic: context.topic }),
                onDone: ({ output }) => ({ target: "done", context: { research: output } }),
              },
            },
            done: {
              type: "final",
              output: ({ context }) => ({ research: context.research ?? "" }),
            },
          },
        });
        const parentMachine = makeParentMachine(
          streamChild as unknown as ReturnType<typeof makeChildMachine>,
        );

        // generateText is present but streamText is not — the child's stream
        // request has no executor to inherit, so bind fails naming the chain.
        await expect(
          runAgent(parentMachine, {
            input: { topic: "agents" },
            executors: {
              generateText: async () => ({ output: "x" }),
            },
          }),
        ).rejects.toThrow(/child machine.*streamText/s);
      });
    });
  });

  test("after-timer: a pending after transition is not idle; runAgent resolves done", async () => {
    const machine = setup({}).createMachine({
      id: "after-timer",
      initial: "waiting",
      states: {
        waiting: {
          after: { 20: { target: "done-state" } },
        },
        "done-state": { type: "final" },
      },
    });

    const result = await runAgent(machine, {
      input: undefined,
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });

    expect(result.status).toBe("done");
  });

  test("onTransition: fires with the causing event type at least once", async () => {
    const machine = setup({}).createMachine({
      id: "transition-observed",
      initial: "a",
      states: {
        a: { on: { GO: { target: "b" } } },
        b: { type: "final" },
      },
    });

    const seenEventTypes: string[] = [];
    const result = await runAgent(machine, {
      input: undefined,
      event: { type: "GO" },
      onTransition: (_snapshot, event) => {
        seenEventTypes.push(event.type);
      },
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });

    // A machine with no invokes and only an `on: { GO }` handler settles
    // idle before the event is sent unless sent as part of this same run;
    // runAgent sends options.event right after start(), so GO is applied.
    expect(result.status === "done" || result.status === "idle").toBe(true);
    expect(seenEventTypes).toContain("GO");
  });

  test("userInput: the userInput option resolves agent.userInput and the machine consumes it", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ feedback: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ feedback: z.string() }),
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: { feedback: null },
      initial: "asking",
      states: {
        asking: {
          invoke: {
            id: "ask",
            src: "agent.userInput",
            input: { prompt: "How was it?" },
            onDone: ({ output }) => ({
              target: "done",
              context: { feedback: output },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ feedback: context.feedback ?? "" }),
        },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      userInput: async (input) => {
        expect(input).toEqual(expect.objectContaining({ prompt: "How was it?" }));
        return "great";
      },
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({
      feedback: "great",
    });
  });

  describe('omitted allowedEvents: "all currently-legal events"', () => {
    const attackSchema = z.object({ target: z.string() });
    const healSchema = z.object({});

    const schemas = createAgentSchemas({
      context: z.object({ hp: z.number(), messages: z.array(z.unknown()) }),
      input: z.object({}),
      events: { ATTACK: attackSchema, HEAL: healSchema },
    });

    test("runAgent + inline agent.decide with allowedEvents omitted: candidates are exactly the legal events, with inputSchema attached", async () => {
      const agent = setupAgent({ schemas });
      const machine = agent.createMachine({
        context: { hp: 10, messages: [] },
        on: {
          "agent.messages": agent.appendMessages(),
        },
        initial: "choosingMove",
        states: {
          choosingMove: {
            invoke: {
              id: "choosingMove",
              // No allowedEvents — omitted means "all currently-legal events."
              src: "agent.decide",
              input: { model: "test-model", prompt: "Choose a move." },
              onError: { target: "fumbled" },
            },
            on: {
              // HEAL only legal when hp < 5 — type-legal but guard-narrowed here.
              HEAL: ({ context }) => (context.hp < 5 ? { target: "healed" } : undefined),
              ATTACK: { target: "attacked" },
            },
          },
          attacked: { type: "final" },
          healed: {},
          fumbled: {},
        },
      });

      let seenEvents: readonly { type: string; inputSchema?: unknown }[] = [];
      const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
        seenEvents = request.events;
        return { event: { type: "ATTACK", target: "goblin" } };
      };

      const result = await runAgent(machine, {
        input: {},
        executors: {
          generateText: async () => ({ output: {} }),
          decide,
        },
      });

      expect(result.status).toBe("done");
      expect(seenEvents.map((event) => event.type).sort()).toEqual(["ATTACK", "HEAL"]);
      expect(seenEvents.map((event) => event.type)).not.toContain("agent.messages");
      expect(seenEvents.find((event) => event.type === "ATTACK")?.inputSchema).toBe(attackSchema);
      expect(seenEvents.find((event) => event.type === "HEAL")?.inputSchema).toBe(healSchema);
    });

    test("runAgent + createDecisionLogic actor with allowedEvents omitted: candidates are exactly the legal events", async () => {
      const chooseMove = createDecisionLogic({
        model: "test-model",
        prompt: "Choose a move.",
        // allowedEvents omitted.
      });

      const agent = setupAgent({ schemas, actors: { chooseMove } });
      const machine = agent.createMachine({
        context: { hp: 10, messages: [] },
        initial: "choosingMove",
        states: {
          choosingMove: {
            invoke: {
              id: "choosingMove",
              src: "chooseMove",
              input: {},
              onError: { target: "fumbled" },
            },
            on: {
              HEAL: ({ context }) => (context.hp < 5 ? { target: "healed" } : undefined),
              ATTACK: { target: "attacked" },
            },
          },
          attacked: { type: "final" },
          healed: {},
          fumbled: {},
        },
      });

      let seenEvents: readonly { type: string }[] = [];
      const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
        seenEvents = request.events;
        return { event: { type: "ATTACK", target: "goblin" } };
      };

      const result = await runAgent(machine, {
        input: {},
        executors: {
          generateText: async () => ({ output: {} }),
          decide,
        },
      });

      expect(result.status).toBe("done");
      expect(seenEvents.map((event) => event.type).sort()).toEqual(["ATTACK", "HEAL"]);
    });

    test("guard-narrowing still intact: a type-legal event offered as a candidate can still be canTake-rejected", async () => {
      const agent = setupAgent({ schemas });
      const machine = agent.createMachine({
        context: { hp: 10, messages: [] },
        initial: "choosingMove",
        states: {
          choosingMove: {
            invoke: {
              id: "choosingMove",
              src: "agent.decide",
              input: { model: "test-model", prompt: "Choose a move." },
              onError: { target: "fumbled" },
            },
            on: {
              // HEAL is type-legal (a declared event) but guard-narrowed:
              // illegal at hp = 10, so the function-transition returns
              // undefined. It must still appear as a candidate (§2.7
              // type-only filter) even though canTake later rejects it
              // (mode-3).
              HEAL: ({ context }) => (context.hp < 5 ? { target: "healed" } : undefined),
              ATTACK: { target: "attacked" },
            },
          },
          attacked: { type: "final" },
          healed: {},
          fumbled: {},
        },
      });

      let callCount = 0;
      const requestsSeen: AgentDecisionRequest[] = [];
      const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
        requestsSeen.push(request);
        callCount += 1;
        if (callCount === 1) {
          return { event: { type: "HEAL" } };
        }
        return { event: { type: "ATTACK", target: "goblin" } };
      };

      const result = await runAgent(machine, {
        input: {},
        executors: {
          generateText: async () => ({ output: {} }),
          decide,
        },
      });

      expect(result.status).toBe("done");
      expect(requestsSeen[0]!.events.map((event) => event.type).sort()).toEqual(["ATTACK", "HEAL"]);
      expect(requestsSeen[1]!.attempts[0]!.failure).toBe("rejected-by-guard");
    });

    test("bare createActor + .withExecutor + allowedEvents omitted: rejects immediately with guidance, not AgentDecisionExhaustedError", async () => {
      const chooseMove = createDecisionLogic(
        {
          model: "test-model",
          prompt: "Choose a move.",
          // allowedEvents omitted — unresolvable without a snapshot-aware host.
        },
        async () => ({ event: { type: "ATTACK", target: "goblin" } }),
      );

      const actor = createActor(chooseMove, { input: {} });
      actor.subscribe({ error: () => {} });
      actor.start();

      await expect(toPromise(actor)).rejects.toThrow(
        /omitted `allowedEvents`.*snapshot-aware host/s,
      );
    });
  });

  test("auto-delivery: the decided event is delivered exactly once despite transition-fn re-evaluation", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ attackCount: z.number() }),
      input: z.object({}),
      events: { ATTACK: z.object({}) },
    });

    const chooseMove = createDecisionLogic({
      model: "test-model",
      prompt: "Choose a move.",
      allowedEvents: ["ATTACK"] as const,
    });

    const agent = setupAgent({ schemas, actors: { chooseMove } });
    const machine = agent.createMachine({
      context: { attackCount: 0 },
      initial: "choosingMove",
      states: {
        choosingMove: {
          invoke: {
            id: "choosingMove",
            src: "chooseMove",
            input: {},
          },
          on: {
            // Counts how many times ATTACK is actually processed as an
            // event by the machine — the auto-delivery send happens once
            // inside the decision actor's own async run, so transition-fn
            // re-evaluation (spike S3: 8x) cannot multiply delivery.
            ATTACK: ({ context }) => ({
              target: "attacked",
              context: { attackCount: context.attackCount + 1 },
            }),
          },
        },
        attacked: { type: "final" },
      },
    });

    let attackEventsObserved = 0;
    const result = await runAgent(machine, {
      input: {},
      onTransition: (_snapshot, event) => {
        if (event.type === "ATTACK") {
          attackEventsObserved += 1;
        }
      },
      executors: {
        generateText: async () => ({ output: {} }),
        decide: async () => ({ event: { type: "ATTACK" } }),
      },
    });

    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.snapshot.context.attackCount : undefined).toBe(1);
    expect(attackEventsObserved).toBe(1);
  });

  test("chosen event whose transition stays in-state: the invoke completes and onDone observes the chosen event as output", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ noted: z.boolean(), notedType: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ noted: z.boolean(), notedType: z.string().nullable() }),
      events: { NOTE: z.object({}) },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: { noted: false, notedType: null },
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: {
              model: "test-model",
              prompt: "Note it.",
              allowedEvents: ["NOTE"] as const,
            },
            // NOTE is an INTERNAL transition (no target): it updates context but
            // stays in `deciding`, so the auto-delivered event does NOT cancel
            // the invoke. The invoke completes and this onDone fires with the
            // chosen event as its output.
            onDone: ({ output }) => ({
              target: "recorded",
              context: { notedType: (output as { type: string }).type },
            }),
          },
          on: {
            NOTE: ({ context: _context }) => ({ context: { noted: true } }),
          },
        },
        recorded: {
          type: "final",
          output: ({ context }) => ({ noted: context.noted, notedType: context.notedType }),
        },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
        decide: async (): Promise<{ event: ChosenEvent }> => ({ event: { type: "NOTE" } }),
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // Auto-delivery ran the in-state NOTE transition (context.noted set true)…
    expect(result.output.noted).toBe(true);
    // …and because NOTE stayed in-state the invoke completed, so onDone saw the
    // chosen event as its output.
    expect(result.output.notedType).toBe("NOTE");
  });

  test("decision inside an invoked child machine delivers to the child (invokingActorOf)", async () => {
    const childSchemas = createAgentSchemas({
      context: z.object({ move: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ move: z.string() }),
      events: { ATTACK: z.object({}), FLEE: z.object({}) },
    });
    const childAgent = setupAgent({ schemas: childSchemas });
    const childMachine = childAgent.createMachine({
      context: { move: null },
      initial: "choosing",
      states: {
        choosing: {
          invoke: {
            src: "agent.decide",
            input: {
              model: "test-model",
              prompt: "Choose a move.",
              allowedEvents: ["ATTACK", "FLEE"] as const,
            },
            onError: { target: "stuck" },
          },
          on: {
            // The chosen event must be delivered to THIS child actor (not the
            // root) to drive it to `done` — that is what invokingActorOf covers.
            ATTACK: ({ context: _context }) => ({ target: "done", context: { move: "ATTACK" } }),
            FLEE: ({ context: _context }) => ({ target: "done", context: { move: "FLEE" } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ move: context.move ?? "?" }) },
        stuck: {},
      },
    });

    const parentSchemas = createAgentSchemas({
      context: z.object({ childMove: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ childMove: z.string().nullable() }),
    });
    const parentAgent = setupAgent({
      schemas: parentSchemas,
      actors: { child: childMachine },
    });
    const parentMachine = parentAgent.createMachine({
      context: { childMove: null },
      initial: "delegating",
      states: {
        delegating: {
          invoke: {
            src: "child",
            input: {},
            onDone: ({ output }) => ({
              target: "done",
              context: { childMove: (output as { move: string }).move },
            }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ childMove: context.childMove }) },
      },
    });

    const result = await runAgent(parentMachine, {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
        decide: async (): Promise<{ event: ChosenEvent }> => ({ event: { type: "ATTACK" } }),
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // The child transitioned to its own `done` off the delivered ATTACK and
    // produced that output — proof the event reached the child, not the root.
    expect(result.output.childMove).toBe("ATTACK");
  });
});

describe("agent.userInput as a pending placeholder (durable parallel HITL)", () => {
  const schemas = createAgentSchemas({
    context: z.object({
      summary: z.string().nullable(),
      feedback: z.string().nullable(),
    }),
    input: z.object({}),
    output: z.object({ summary: z.string(), feedback: z.string() }),
  });

  const agent = setupAgent({
    schemas,
    requests: {
      summarize: {
        schemas: { input: z.object({}), output: z.string() },
        model: "m",
        prompt: () => "summarize",
      },
    },
  });

  const machine = agent.createMachine({
    context: { summary: null, feedback: null },
    type: "parallel",
    output: ({ context }) => ({
      summary: context.summary ?? "",
      feedback: context.feedback ?? "",
    }),
    states: {
      working: {
        initial: "summarizing",
        states: {
          summarizing: {
            invoke: {
              id: "sum",
              src: "summarize",
              input: {},
              onDone: ({ output }) => ({
                target: "summarized",
                context: { summary: output },
              }),
            },
          },
          summarized: { type: "final" },
        },
      },
      reviewing: {
        initial: "asking",
        states: {
          asking: {
            invoke: {
              id: "askHuman",
              src: "agent.userInput",
              input: { prompt: "Feedback?" },
              onDone: ({ output }) => ({
                target: "received",
                context: { feedback: output },
              }),
            },
          },
          received: { type: "final" },
        },
      },
    },
  });

  test("a sibling region finishes its model call, then the run settles idle with the pending user input", async () => {
    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: "a summary" }),
      },
    });

    expect(result.status).toBe("idle");
    if (result.status !== "idle") throw new Error("expected idle");
    // The sibling region's work ran to completion before settling.
    expect((result.snapshot.context as { summary: string | null }).summary).toBe("a summary");
    expect(result.pendingUserInputs).toEqual([{ id: "askHuman", input: { prompt: "Feedback?" } }]);
    expect(result.persist()).toBeDefined();
  });

  test("the persisted snapshot JSON round-trips and resumes with a userInput handler to done", async () => {
    const first = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: "a summary" }),
      },
    });
    if (first.status !== "idle" || !first.persist()) {
      throw new Error("expected idle with persistedSnapshot");
    }

    const stored = JSON.parse(JSON.stringify(first.persist()));

    const second = await runAgent(machine, {
      snapshot: stored,
      userInput: async (input) => {
        expect(input).toEqual({ prompt: "Feedback?" });
        return "ship it";
      },
      executors: {
        generateText: async () => {
          throw new Error("no model call expected on resume");
        },
      },
    });

    expect(second.status).toBe("done");
    if (second.status !== "done") throw new Error("expected done");
    expect(second.output).toEqual({ summary: "a summary", feedback: "ship it" });
  });

  test("resuming without a handler settles idle again with the same pending input", async () => {
    const first = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: "a summary" }),
      },
    });
    if (first.status !== "idle" || !first.persist()) {
      throw new Error("expected idle with persistedSnapshot");
    }

    const again = await runAgent(machine, {
      snapshot: JSON.parse(JSON.stringify(first.persist())),
      executors: {
        generateText: async () => ({ output: "unused" }),
      },
    });

    expect(again.status).toBe("idle");
    if (again.status !== "idle") throw new Error("expected idle");
    expect(again.pendingUserInputs).toEqual([{ id: "askHuman", input: { prompt: "Feedback?" } }]);
  });
});

describe("emitted events (runAgent `on`)", () => {
  const agent = setupAgent({
    context: z.object({ topic: z.string(), draft: z.string().nullable() }),
    input: z.object({ topic: z.string() }),
    output: z.object({ draft: z.string() }),
    emitted: {
      DRAFTING_STARTED: z.object({ topic: z.string() }),
      DRAFTED: z.object({ length: z.number() }),
    },
    requests: {
      draft: {
        schemas: { input: z.object({ topic: z.string() }), output: z.string() },
        model: "writer",
        prompt: ({ input }) => `Draft: ${input.topic}`,
      },
    },
  });

  const machine = agent.createMachine({
    context: ({ input }) => ({ topic: input.topic, draft: null }),
    initial: "drafting",
    states: {
      drafting: {
        entry: ({ context }, enq) => {
          enq.emit({ type: "DRAFTING_STARTED", topic: context.topic });
        },
        invoke: {
          src: "draft",
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }, enq) => {
            enq.emit({ type: "DRAFTED", length: output.length });
            return { target: "done", context: { draft: output } };
          },
        },
      },
      done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
    },
  });

  test("`on` handlers fire per type, including events emitted during the initial transition", async () => {
    const started: string[] = [];
    const drafted: number[] = [];

    const result = await runAgent(machine, {
      input: { topic: "rivers" },
      on: {
        DRAFTING_STARTED: (emitted) => started.push(emitted.topic),
        DRAFTED: (emitted) => drafted.push(emitted.length),
      },
      executors: {
        generateText: async () => ({ output: "a draft" }),
      },
    });

    expect(result.status).toBe("done");
    expect(started).toEqual(["rivers"]);
    expect(drafted).toEqual(["a draft".length]);
  });

  test("'*' catches every emitted event", async () => {
    const seen: string[] = [];

    await runAgent(machine, {
      input: { topic: "rivers" },
      on: { "*": (emitted) => seen.push(emitted.type) },
      executors: {
        generateText: async () => ({ output: "a draft" }),
      },
    });

    expect(seen).toEqual(["DRAFTING_STARTED", "DRAFTED"]);
  });

  test("onTrace emits an ordered run/request/transition/emit/end stream", async () => {
    const trace: AgentTraceEvent<typeof machine>[] = [];

    const result = await runAgent(machine, {
      input: { topic: "rivers" },
      onTrace: (event) => trace.push(event),
      executors: {
        generateText: async () => ({ output: "a draft", usage: { totalTokens: 3 } }),
      },
    });

    expect(result.status).toBe("done");
    expect(trace.map((event) => event.seq)).toEqual(trace.map((_, index) => index + 1));
    expect(trace[0]).toEqual(expect.objectContaining({ type: "run.start", seq: 1 }));
    expect(trace.at(-1)).toEqual(expect.objectContaining({ type: "run.end", status: "done" }));
    expect(trace.at(-1)).not.toHaveProperty("events");
    expect(trace.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "emit",
        "machine.transition",
        "request.start",
        "request.end",
        "run.end",
      ]),
    );
    expect(trace.filter((event) => event.type === "emit").map((event) => event.event.type)).toEqual(
      ["DRAFTING_STARTED", "DRAFTED"],
    );
    expect(trace.find((event) => event.type === "request.end")).toEqual(
      expect.objectContaining({
        type: "request.end",
        output: "a draft",
        raw: { output: "a draft", usage: { totalTokens: 3 } },
      }),
    );

    // Every trace event carries the run's identity (version === structural hash)
    // and the versioned schema stamp.
    const version = getMachineStructuralHash(machine);
    expect(trace.length).toBeGreaterThan(0);
    for (const event of trace) {
      expect(event.schemaVersion).toBe(AGENT_TRACE_SCHEMA_VERSION);
      expect(event.machineId).toEqual(expect.any(String));
      expect(event.machineVersion).toBe(version);
    }
    // All share the same runId across the stream.
    expect(new Set(trace.map((event) => event.runId)).size).toBe(1);
  });

  test("the machine's own version (not the structural hash) fills every trace event", async () => {
    const trace: AgentTraceEvent[] = [];
    const versioned = setup({}).createMachine({
      id: "versionedTrace",
      version: "v-declared",
      context: {},
      initial: "done",
      states: { done: { type: "final" } },
    } as never);

    await runAgent(versioned, {
      onTrace: (event) => trace.push(event),
      executors: {
        generateText: async () => ({ output: "a draft" }),
      },
    });

    expect(trace.length).toBeGreaterThan(0);
    for (const event of trace) {
      expect(event.machineVersion).toBe("v-declared");
    }
  });
});

describe("onTrace stream chunks", () => {
  test("stream chunks are traced with their request", async () => {
    const agent = setupAgent({
      context: z.object({ joke: z.string().nullable() }),
      output: z.object({ joke: z.string() }),
      requests: {
        joke: {
          schemas: { input: z.object({}), output: z.string() },
          model: "m",
          mode: "stream",
          prompt: () => "joke",
        },
      },
    });

    const machine = agent.createMachine({
      context: { joke: null },
      initial: "writing",
      states: {
        writing: {
          invoke: {
            src: "joke",
            input: () => ({}),
            onDone: ({ output }) => ({ target: "done", context: { joke: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ joke: context.joke ?? "" }) },
      },
    });

    const trace: AgentTraceEvent<typeof machine>[] = [];
    const result = await runAgent(machine, {
      onTrace: (event) => trace.push(event),
      executors: {
        generateText: async () => ({ output: {} }),
        streamText: async (_request, info) => {
          info?.onChunk?.("a");
          info?.onChunk?.("b");
          return { output: "ab" };
        },
      },
    });

    expect(result.status).toBe("done");
    expect(
      trace
        .filter((event) => event.type === "stream.chunk")
        .map((event) => [event.chunk, event.request.src]),
    ).toEqual([
      ["a", "joke"],
      ["b", "joke"],
    ]);
  });
});

describe("sugar callbacks are projections of onTrace", () => {
  test("onChunk/onResult/onTransition keep their position around the matching trace event", async () => {
    const agent = setupAgent({
      context: z.object({ joke: z.string().nullable() }),
      output: z.object({ joke: z.string() }),
      requests: {
        joke: {
          schemas: { input: z.object({}), output: z.string() },
          model: "m",
          mode: "stream",
          prompt: () => "joke",
        },
      },
    });

    const machine = agent.createMachine({
      context: { joke: null },
      initial: "writing",
      states: {
        writing: {
          invoke: {
            src: "joke",
            input: () => ({}),
            onDone: ({ output }) => ({ target: "done", context: { joke: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ joke: context.joke ?? "" }) },
      },
    });

    // One interleaved log: every trace event and every sugar callback, in order.
    const log: string[] = [];
    const result = await runAgent(machine, {
      onTrace: (event) => log.push(`trace:${event.type}`),
      onChunk: (chunk, info) => log.push(`chunk:${chunk}:${info.request.src}`),
      onResult: (_request, { output }) => log.push(`result:${String(output)}`),
      onTransition: (_snapshot, event) => log.push(`transition:${event.type}`),
      executors: {
        streamText: async (_request, info) => {
          info?.onChunk?.("a");
          info?.onChunk?.("b");
          return { output: "ab" };
        },
      },
    });

    expect(result.status).toBe("done");

    // onChunk fires immediately AFTER its stream.chunk trace.
    const chunkTraces = log.flatMap((entry, i) => (entry === "trace:stream.chunk" ? [i] : []));
    expect(chunkTraces).toHaveLength(2);
    expect(chunkTraces.map((i) => log[i + 1])).toEqual(["chunk:a:joke", "chunk:b:joke"]);

    // onResult fires immediately BEFORE its request.end trace.
    const endTraces = log.flatMap((entry, i) => (entry === "trace:request.end" ? [i] : []));
    expect(endTraces).toHaveLength(1);
    expect(log[endTraces[0]! - 1]).toBe("result:ab");

    // onTransition fires immediately AFTER its machine.transition trace.
    const transitionTraces = log.flatMap((entry, i) =>
      entry === "trace:machine.transition" ? [i] : [],
    );
    expect(transitionTraces.length).toBeGreaterThan(0);
    for (const i of transitionTraces) {
      expect(log[i + 1]).toMatch(/^transition:/);
    }
    // No sugar callback fires without its trace event.
    expect(log.filter((entry) => entry.startsWith("transition:"))).toHaveLength(
      transitionTraces.length,
    );
  });
});

describe("onResult raw pass-through", () => {
  test("extra executor-envelope keys (usage, ...) reach onResult.raw verbatim", async () => {
    const agent = setupAgent({
      context: z.object({ answer: z.string().nullable() }),
      output: z.object({ answer: z.string() }),
      requests: {
        ask: {
          schemas: { input: z.object({}), output: z.string() },
          model: "m",
          prompt: () => "q",
        },
      },
    });

    const machine = agent.createMachine({
      context: { answer: null },
      initial: "asking",
      states: {
        asking: {
          invoke: {
            src: "ask",
            input: () => ({}),
            onDone: ({ output }) => ({ target: "done", context: { answer: output } }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ answer: context.answer ?? "" }) },
      },
    });

    const raws: unknown[] = [];
    const result = await runAgent(machine, {
      onResult: (_request, { raw }) => raws.push(raw),
      executors: {
        generateText: async () => ({
          output: "42",
          usage: { inputTokens: 7, outputTokens: 3 },
          finishReason: "stop",
        }),
      },
    });

    expect(result.status).toBe("done");
    expect(raws).toEqual([
      { output: "42", usage: { inputTokens: 7, outputTokens: 3 }, finishReason: "stop" },
    ]);
  });

  test("reasoning on the raw executor result reaches onResult.raw and the request.end trace", async () => {
    const agent = setupAgent({
      context: z.object({ answer: z.string().nullable() }),
      output: z.object({ answer: z.string() }),
      requests: {
        ask: {
          schemas: { input: z.object({}), output: z.object({ answer: z.string() }) },
          model: "m",
          includeReasoning: true,
          prompt: () => "q",
        },
      },
    });

    const machine = agent.createMachine({
      context: { answer: null },
      initial: "asking",
      states: {
        asking: {
          invoke: {
            src: "ask",
            input: () => ({}),
            onDone: ({ output }) => ({
              target: "done",
              context: { answer: (output as { answer: string }).answer },
            }),
          },
        },
        done: { type: "final", output: ({ context }) => ({ answer: context.answer ?? "" }) },
      },
    });

    const raws: unknown[] = [];
    const trace: AgentTraceEvent[] = [];
    const result = await runAgent(machine, {
      onResult: (_request, { raw }) => raws.push(raw),
      onTrace: (event) => trace.push(event),
      executors: {
        // Executor surfaces reasoning alongside the (already-unwrapped) output —
        // exactly what createAiSdkExecutors returns from the envelope.
        generateText: async () => ({ output: { answer: "42" }, reasoning: "carefully" }),
      },
    });

    expect(result.status).toBe("done");
    // reasoning stays out of machine context/output.
    expect(result.status === "done" ? result.output : undefined).toEqual({ answer: "42" });
    // reasoning reaches onResult via raw.
    expect(raws).toEqual([{ output: { answer: "42" }, reasoning: "carefully" }]);
    // reasoning is lifted onto the request.end trace event as a field.
    const end = trace.find(
      (event): event is Extract<AgentTraceEvent, { type: "request.end" }> =>
        event.type === "request.end",
    );
    expect(end?.reasoning).toBe("carefully");
  });
});

describe("inspect passthrough (system-wide visibility)", () => {
  test("child machine transitions are observable with their actorRef, unlike onTransition", async () => {
    const child = setupAgent({
      context: z.object({}),
      output: z.object({ ok: z.boolean() }),
    }).createMachine({
      id: "child",
      context: {},
      initial: "working",
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({ run: async () => "done" }),
            onDone: { target: "finished" },
          },
        },
        finished: { type: "final", output: () => ({ ok: true }) },
      },
    });

    const parent = setupAgent({
      context: z.object({}),
      output: z.object({ ok: z.boolean() }),
      actors: { child },
    }).createMachine({
      id: "parent",
      context: {},
      initial: "delegating",
      states: {
        delegating: {
          invoke: {
            src: "child",
            onDone: { target: "done" },
          },
        },
        done: { type: "final", output: () => ({ ok: true }) },
      },
    });

    const rootTransitions: string[] = [];
    const inspected: Array<{ actorId: string; value: unknown }> = [];

    const result = await runAgent(parent, {
      onTransition: (snapshot) => rootTransitions.push(JSON.stringify(snapshot.value)),
      inspect: (event) => {
        if (event.type !== "@xstate.transition") return;
        const snapshot = event.snapshot as { value?: unknown };
        if (snapshot.value === undefined) return;
        inspected.push({
          actorId: (event.actorRef as { id?: string }).id ?? "",
          value: snapshot.value,
        });
      },
      executors: {
        generateText: async () => ({ output: "" }),
      },
    });

    expect(result.status).toBe("done");
    // onTransition saw only the root machine's states...
    expect(rootTransitions).toEqual(['"delegating"', '"done"']);
    // ...while inspect saw the invoked child machine's states too, attributed
    // to the child's actorRef.
    const childValues = inspected
      .filter(
        (entry) => entry.actorId !== "parent" && !rootTransitions.includes(`"${entry.value}"`),
      )
      .map((entry) => entry.value);
    expect(childValues).toContain("working");
    expect(childValues).toContain("finished");
  });

  test("inspect accepts an observer object ({ next }), like createActor", async () => {
    const machine = setupAgent({
      context: z.object({}),
      output: z.object({ ok: z.boolean() }),
    }).createMachine({
      id: "observed",
      context: {},
      initial: "working",
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({ run: async () => "done" }),
            onDone: { target: "finished" },
          },
        },
        finished: { type: "final", output: () => ({ ok: true }) },
      },
    });

    const seen: string[] = [];
    const result = await runAgent(machine, {
      // The observer shape ({ next }), not a function.
      inspect: { next: (event) => seen.push(event.type) },
      executors: { generateText: async () => ({ output: "" }) },
    });

    expect(result.status).toBe("done");
    expect(seen).toContain("@xstate.transition");
  });
});

describe("Feature A: explicit suspension detection (isIdle)", () => {
  test("a machine-carried isIdle predicate settles idle and resumes to done", async () => {
    const agent = setupAgent({
      context: z.object({}),
      input: z.object({}),
      output: z.object({ approved: z.boolean() }),
      events: { APPROVE: z.object({}) },
      // The machine declares its own wait signal — a tag it chose.
      isIdle: (snapshot) => snapshot.hasTag("awaiting-review"),
    });
    const machine = agent.createMachine({
      context: {},
      initial: "reviewing",
      states: {
        reviewing: {
          tags: ["awaiting-review"],
          on: { APPROVE: { target: "done" } },
        },
        done: { type: "final", output: () => ({ approved: true }) },
      },
    });

    const first = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });
    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");
    expect(first.snapshot.value).toBe("reviewing");

    const second = await runAgent(machine, {
      snapshot: first.persist(),
      event: { type: "APPROVE" },
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });
    expect(second.status).toBe("done");
    expect(second.status === "done" ? second.output : undefined).toEqual({ approved: true });
  });

  test("a declared-suspension settle preserves invoked-child context written during the settling flush", async () => {
    // Regression: the settle-triggering root event comes FROM the invoked
    // child (child → parent), and the parent's handler sendTo's the child
    // back while the child's mailbox is mid-flush. A synchronous settle in
    // the inspect handler captured (and stopped) the child before that
    // delivery, so the persisted snapshot lost the child's context update.
    const childAgent = setupAgent({
      context: z.object({ notes: z.array(z.string()) }),
      events: {
        OBSERVE: z.object({ note: z.string() }),
        POKE: z.object({}),
      },
      requests: {
        tick: {
          schemas: { input: z.object({}), output: z.string() },
          model: "m",
          prompt: () => "tick",
        },
      },
    });
    const childMachine = childAgent.createMachine({
      id: "note-taker",
      context: { notes: [] },
      on: {
        OBSERVE: ({ context, event }) => ({
          context: { notes: [...context.notes, event.note] },
        }),
      },
      initial: "boot",
      states: {
        boot: {
          // Child-initiated event, sent as an action while the child is
          // processing its invoke's done event — so the child's own mailbox
          // flush is the active one when the parent handles READY.
          invoke: {
            src: "tick",
            input: {},
            onDone: ({ parent }, enq) => {
              if (parent) enq.sendTo(parent, { type: "READY" });
              return { target: "watching" };
            },
          },
        },
        watching: {
          on: {
            POKE: { target: "boot" },
          },
        },
      },
    });

    const agent = setupAgent({
      context: z.object({ readies: z.number() }),
      input: z.object({}),
      events: {
        READY: z.object({}),
        CONTINUE: z.object({}),
      },
      actors: { child: childMachine },
      isIdle: (snapshot) => snapshot.hasTag("waiting"),
    });
    const machine = agent.createMachine({
      context: { readies: 0 },
      initial: "running",
      states: {
        running: {
          invoke: { id: "child", src: "child" },
          initial: "starting",
          states: {
            starting: {
              on: {
                READY: ({ context, children }, enq) => {
                  enq.sendTo(children.child, {
                    type: "OBSERVE",
                    note: `ready-${context.readies + 1}`,
                  });
                  return { target: "waiting", context: { readies: context.readies + 1 } };
                },
              },
            },
            waiting: {
              tags: ["waiting"],
              on: {
                CONTINUE: ({ children }, enq) => {
                  enq.sendTo(children.child, { type: "POKE" });
                  return { target: "starting" };
                },
              },
            },
          },
        },
      },
    });

    const executors = { generateText: async () => ({ output: "tick" }) };

    const first = await runAgent(machine, { input: {}, executors });
    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");
    const persistedNotes = (
      first.persist() as {
        children?: { child?: { snapshot?: { context?: { notes?: string[] } } } };
      }
    ).children?.child?.snapshot?.context?.notes;
    expect(persistedNotes).toEqual(["ready-1"]);

    // Resume from the persisted snapshot: the child keeps accumulating.
    const second = await runAgent(machine, {
      snapshot: first.persist(),
      event: { type: "CONTINUE" },
      executors,
    });
    expect(second.status).toBe("idle");
    if (second.status !== "idle") throw new Error("expected idle");
    const secondNotes = (
      second.persist() as {
        children?: { child?: { snapshot?: { context?: { notes?: string[] } } } };
      }
    ).children?.child?.snapshot?.context?.notes;
    expect(secondNotes).toEqual(["ready-1", "ready-2"]);
  });

  test("a declared-suspension settle keeps every child delivery queued across an always-chain into the wait state", async () => {
    // Regression (game-loop shape): the child-originated event lands on a
    // handler that targets a transient state whose `always` fires a SECOND
    // sendTo to the child before resting in the tagged wait state — both
    // deliveries are still in the child's mailbox when the root transition
    // inspect fires, and both must be flushed before the idle persist.
    const childAgent = setupAgent({
      context: z.object({ notes: z.array(z.string()) }),
      events: {
        OBSERVE: z.object({ note: z.string() }),
      },
      requests: {
        tick: {
          schemas: { input: z.object({}), output: z.string() },
          model: "m",
          prompt: () => "tick",
        },
      },
    });
    const childMachine = childAgent.createMachine({
      id: "observer",
      context: { notes: [] },
      on: {
        OBSERVE: ({ context, event }) => ({
          context: { notes: [...context.notes, event.note] },
        }),
      },
      initial: "boot",
      states: {
        boot: {
          invoke: {
            src: "tick",
            input: {},
            onDone: ({ parent }, enq) => {
              if (parent) enq.sendTo(parent, { type: "MOVED" });
              return { target: "watching" };
            },
          },
        },
        watching: {},
      },
    });

    const agent = setupAgent({
      context: z.object({}),
      input: z.object({}),
      events: {
        MOVED: z.object({}),
        DONE: z.object({}),
      },
      actors: { child: childMachine },
      isIdle: (snapshot) => snapshot.hasTag("waiting"),
    });
    const machine = agent.createMachine({
      context: {},
      initial: "running",
      states: {
        running: {
          invoke: { id: "child", src: "child" },
          initial: "playing",
          states: {
            playing: {
              on: {
                MOVED: ({ children }, enq) => {
                  enq.sendTo(children.child, { type: "OBSERVE", note: "moved" });
                  return { target: "over" };
                },
              },
            },
            over: {
              always: ({ children }, enq) => {
                enq.sendTo(children.child, { type: "OBSERVE", note: "round-over" });
                return { target: "asking" };
              },
            },
            asking: {
              tags: ["waiting"],
              on: { DONE: { target: "#end" } },
            },
          },
        },
        end: { id: "end", type: "final", output: () => ({}) },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      executors: { generateText: async () => ({ output: "tick" }) },
    });
    expect(result.status).toBe("idle");
    if (result.status !== "idle") throw new Error("expected idle");
    const notes = (
      result.persist() as {
        children?: { child?: { snapshot?: { context?: { notes?: string[] } } } };
      }
    ).children?.child?.snapshot?.context?.notes;
    expect(notes).toEqual(["moved", "round-over"]);
  });

  test("a suspended region does not settle early while a sibling still has work in flight", async () => {
    const agent = setupAgent({
      context: z.object({ summary: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ summary: z.string() }),
      events: { APPROVE: z.object({}) },
      isIdle: (snapshot) => snapshot.hasTag("awaiting-review"),
      requests: {
        summarize: {
          schemas: { input: z.object({}), output: z.string() },
          model: "m",
          prompt: () => "summarize",
        },
      },
    });
    const machine = agent.createMachine({
      context: { summary: null },
      type: "parallel",
      states: {
        review: {
          initial: "waiting",
          states: {
            waiting: { tags: ["awaiting-review"], on: { APPROVE: { target: "approved" } } },
            approved: { type: "final" },
          },
        },
        work: {
          initial: "summarizing",
          states: {
            summarizing: {
              invoke: {
                id: "sum",
                src: "summarize",
                input: {},
                onDone: ({ output }) => ({ target: "summarized", context: { summary: output } }),
              },
            },
            summarized: { type: "final" },
          },
        },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: () =>
          new Promise((res) => setTimeout(() => res({ output: "done-summary" }), 10)),
      },
    });

    expect(result.status).toBe("idle");
    if (result.status !== "idle") throw new Error("expected idle");
    expect((result.snapshot.context as { summary: string | null }).summary).toBe("done-summary");
  });

  test("a resting state with an event handler is idle by default", async () => {
    const agent = setupAgent({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
      events: { GO: z.object({}) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "paused",
      states: {
        paused: { on: { GO: { target: "done" } } },
        done: { type: "final", output: () => ({}) },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });

    expect(result.status).toBe("idle");
    expect(result.status === "idle" ? result.snapshot.value : undefined).toBe("paused");
  });

  test("the machine-carried predicate survives machine.provide (executor rebinding)", async () => {
    const agent = setupAgent({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
      events: { GO: z.object({}) },
      isIdle: (snapshot) => snapshot.matches("paused"),
      requests: {
        noop: {
          schemas: { input: z.object({}), output: z.string() },
          model: "m",
          prompt: () => "noop",
        },
      },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "paused",
      states: {
        paused: { on: { GO: { target: "done" } } },
        done: { type: "final", output: () => ({}) },
      },
    });

    // A user-side provide returns a NEW machine object; the predicate is carried
    // on the shared root `config`, so it must still be found.
    const provided = machine.provide({});

    const result = await runAgent(provided, {
      input: {},
      executors: {
        generateText: async () => ({ output: "x" }),
      },
    });

    expect(result.status).toBe("idle");
    expect(result.status === "idle" ? result.snapshot.value : undefined).toBe("paused");
  });

  test("untagged machines still settle idle via the fallback heuristic (unchanged)", async () => {
    const agent = setupAgent({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
      events: { APPROVE: z.object({}) },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "reviewing",
      states: {
        // No tags, no custom detector — pure heuristic path.
        reviewing: { on: { APPROVE: { target: "done" } } },
        done: { type: "final", output: () => ({}) },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });
    expect(result.status).toBe("idle");
    expect(result.status === "idle" ? result.snapshot.value : undefined).toBe("reviewing");
  });
});

describe("Feature B: illegal resume event throws", () => {
  const agent = setupAgent({
    context: z.object({ ok: z.boolean() }),
    input: z.object({}),
    output: z.object({}),
    events: {
      APPROVE: z.object({}),
      REJECT: z.object({ reason: z.string() }),
      SUBMIT: z.object({}),
    },
  });
  const machine = agent.createMachine({
    context: { ok: false },
    initial: "reviewing",
    states: {
      reviewing: {
        on: {
          APPROVE: { target: "done" },
          REJECT: { target: "done" },
          // Type-legal but guard-narrowed: rejected while ok === false.
          SUBMIT: ({ context }) => (context.ok ? { target: "done" } : undefined),
        },
      },
      done: { type: "final", output: () => ({}) },
    },
  });

  const generateText = async () => ({ output: {} });

  test("resuming with an event the restored state cannot take throws AgentIllegalResumeEventError with acceptedTypes", async () => {
    const first = await runAgent(machine, { input: {}, executors: { generateText } });
    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");

    let caught: unknown;
    try {
      await runAgent(machine, {
        snapshot: first.persist(),
        event: { type: "NOPE" } as never,
        executors: {
          generateText,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentIllegalResumeEventError);
    const err = caught as AgentIllegalResumeEventError;
    expect(err.eventType).toBe("NOPE");
    expect(err.acceptedTypes.slice().sort()).toEqual(["APPROVE", "REJECT", "SUBMIT"]);
  });

  test("an illegal resume event always rejects (there is no opt-out)", async () => {
    const first = await runAgent(machine, { input: {}, executors: { generateText } });
    if (first.status !== "idle") throw new Error("expected idle");

    await expect(
      runAgent(machine, {
        snapshot: first.persist(),
        event: { type: "NOPE" } as never,
        executors: { generateText },
      }),
    ).rejects.toBeInstanceOf(AgentIllegalResumeEventError);
  });

  test("a type-legal event a guard rejects does not throw (settles per normal semantics)", async () => {
    const first = await runAgent(machine, { input: {}, executors: { generateText } });
    if (first.status !== "idle") throw new Error("expected idle");

    // SUBMIT is a declared, type-legal event; its guard rejects it here. This
    // is NOT an illegal resume event — no throw, machine takes no transition.
    const second = await runAgent(machine, {
      snapshot: first.persist(),
      event: { type: "SUBMIT" },
      executors: {
        generateText,
      },
    });

    expect(second.status).toBe("idle");
    expect(second.status === "idle" ? second.snapshot.value : undefined).toBe("reviewing");
  });
});

describe("runAgent error cause split", () => {
  // Builds a decision machine whose `decide` always returns an unknown event,
  // so resolveDecision exhausts its retries and throws AgentDecisionExhaustedError.
  function exhaustingDecisionMachine(withOnError: boolean) {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      events: { ATTACK: z.object({}), HEAL: z.object({}) },
    });
    const chooseMove = createDecisionLogic({
      model: "test-model",
      prompt: "Choose a move.",
      allowedEvents: ["ATTACK", "HEAL"] as const,
    });
    const agent = setupAgent({ schemas, actors: { chooseMove } });
    return agent.createMachine({
      context: {},
      initial: "choosing",
      states: {
        choosing: {
          invoke: {
            id: "choosing",
            src: "chooseMove",
            input: {},
            ...(withOnError ? { onError: { target: "fumbled" } } : {}),
          },
          on: { ATTACK: { target: "attacked" }, HEAL: { target: "healed" } },
        },
        attacked: { type: "final" },
        healed: { type: "final" },
        fumbled: {},
      },
    });
  }

  const alwaysUnknown = async (): Promise<{ event: ChosenEvent }> => ({
    event: { type: "BOGUS" },
  });

  test("unhandled AgentDecisionExhaustedError settles cause 'decision-exhausted'", async () => {
    const result = await runAgent(exhaustingDecisionMachine(false), {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
        decide: alwaysUnknown,
      },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("decision-exhausted");
  });

  test("a AgentDecisionExhaustedError handled by onError does NOT settle an error", async () => {
    const result = await runAgent(exhaustingDecisionMachine(true), {
      input: {},
      executors: {
        generateText: async () => ({ output: {} }),
        decide: alwaysUnknown,
      },
    });

    // onError routed it to `fumbled` — the run settles idle, not error.
    expect(result.status).not.toBe("error");
    expect(result.status === "idle" ? result.snapshot.value : undefined).toBe("fumbled");
  });

  test("a plain executor throw (not decision-exhausted) still settles cause 'machine'", async () => {
    const schemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
    });
    const step = createTextLogic({
      schemas: { input: z.object({}), output: z.object({}) },
      model: "test-model",
      prompt: "work",
    });
    const agent = setupAgent({ schemas, actors: { step } });
    const machine = agent.createMachine({
      context: {},
      initial: "working",
      states: {
        working: { invoke: { id: "step", src: "step", input: {}, onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });

    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async () => {
          throw new Error("boom");
        },
      },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("machine");
  });
});

describe("runAgent dev-mode serialization guard", () => {
  test("warns once, naming the path, when idle context holds a non-JSON value (Date)", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ createdAt: z.date() }),
      input: z.object({}),
      events: { GO: z.object({}) },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: () => ({ createdAt: new Date() }),
      initial: "waiting",
      states: {
        waiting: { on: { GO: { target: "done" } } },
        done: { type: "final" },
      },
    });

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const result = await runAgent(machine, {
        input: {},
        executors: {
          generateText: async () => ({ output: {} }),
        },
      });
      expect(result.status).toBe("idle");
    } finally {
      console.warn = original;
    }

    const serializationWarnings = warnings.filter((w) => w.includes("persist/resume"));
    expect(serializationWarnings).toHaveLength(1);
    expect(serializationWarnings[0]).toContain("context.createdAt (Date)");
  });

  test("does not warn when idle context is fully JSON-serializable", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ topic: z.string() }),
      input: z.object({}),
      events: { GO: z.object({}) },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: () => ({ topic: "cats" }),
      initial: "waiting",
      states: {
        waiting: { on: { GO: { target: "done" } } },
        done: { type: "final" },
      },
    });

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await runAgent(machine, {
        input: {},
        executors: { generateText: async () => ({ output: {} }) },
      });
    } finally {
      console.warn = original;
    }

    expect(warnings.filter((w) => w.includes("persist/resume"))).toHaveLength(0);
  });
});

// ─── generateResult (item 1) ───
describe("generateResult", () => {
  const buildDraftMachine = () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), draft: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ draft: z.string() }),
      events: { APPROVE: z.object({}) },
    });
    const draftText = createTextLogic({
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.prompt,
    });
    const agent = setupAgent({ schemas, actors: { draftText } });
    return agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: "drafting",
      states: {
        drafting: {
          invoke: {
            id: "draft",
            src: "draftText",
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({ target: "awaitingApproval", context: { draft: output } }),
          },
        },
        awaitingApproval: { on: { APPROVE: { target: "done" } } },
        done: { type: "final", output: ({ context }) => ({ draft: context.draft ?? "" }) },
      },
    });
  };

  const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => ({
    output: `Draft: ${request.prompt}`,
  });

  test("done: resolves with the machine output", async () => {
    const machine = buildDraftMachine();
    const first = await runAgent(machine, {
      input: { prompt: "notes" },
      executors: { generateText },
    });
    if (first.status !== "idle") throw new Error("expected idle");

    const result = await generateResult(machine, {
      snapshot: first.persist(),
      event: { type: "APPROVE" },
      executors: {
        generateText,
      },
    });
    expect(result.status).toBe("done");
    expect(result.output).toEqual({ draft: "Draft: notes" });
    // generateText-style metadata rides along with the output:
    expect(result.snapshot.status).toBe("done");
    expect(result.persist()).toEqual(expect.objectContaining({ status: "done" }));
  });

  test("idle: throws AgentIdleError carrying snapshot + acceptedTypes", async () => {
    const machine = buildDraftMachine();
    await expect(
      generateResult(machine, { input: { prompt: "notes" }, executors: { generateText } }),
    ).rejects.toBeInstanceOf(AgentIdleError);

    let caught: AgentIdleError | undefined;
    try {
      await generateResult(machine, {
        input: { prompt: "notes" },
        executors: { generateText },
      });
    } catch (error) {
      caught = error as AgentIdleError;
    }
    expect(caught?.acceptedTypes).toContain("APPROVE");
    expect((caught?.snapshot as { value?: unknown }).value).toBe("awaitingApproval");
  });

  test("error (Error): rethrows the underlying Error as-is", async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({}),
    });
    const boom = createTextLogic({
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      model: "test-model",
      prompt: ({ input }) => input.prompt,
    });
    const agent = setupAgent({ schemas, actors: { boom } });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt }),
      initial: "working",
      states: {
        working: { invoke: { id: "boom", src: "boom", input: ({ context }) => context } },
      },
    });
    const thrown = new Error("executor exploded");
    await expect(
      generateResult(machine, {
        input: { prompt: "x" },
        executors: {
          generateText: async () => {
            throw thrown;
          },
        },
      }),
    ).rejects.toBe(thrown);
  });

  test("error (non-Error): wraps, preserving cause + raw error", async () => {
    const machine = buildDraftMachine();
    const controller = new AbortController();
    controller.abort("stringy-reason");

    let caught: (Error & { cause?: unknown; error?: unknown }) | undefined;
    try {
      await generateResult(machine, {
        input: { prompt: "notes" },
        signal: controller.signal,
        executors: {
          generateText,
        },
      });
    } catch (error) {
      caught = error as Error & { cause?: unknown; error?: unknown };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.cause).toBe("aborted");
    expect(caught?.error).toBe("stringy-reason");
  });
});

// ─── Snapshot version stamping + migrate hook (item 2) ───
describe("restore semantics: pending requests and events-only resume", () => {
  // Shared two-phase machine: a request, an idle gate, then a second request.
  const buildMachine = () => {
    const agentSetup = setupAgent({
      context: z.object({ a: z.string().nullable(), b: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ a: z.string(), b: z.string() }),
      events: { GO: {} },
    });
    return agentSetup.createMachine({
      context: () => ({ a: null, b: null }),
      initial: "first",
      states: {
        first: {
          invoke: {
            src: "agent.generateText",
            input: () => ({ model: "m", prompt: "one" }),
            onDone: ({ event }) => ({
              target: "waiting",
              context: { a: String(event.output) },
            }),
          },
        },
        waiting: { on: { GO: { target: "second" } } },
        second: {
          invoke: {
            src: "agent.generateText",
            input: () => ({ model: "m", prompt: "two" }),
            onDone: ({ event }) => ({
              target: "done",
              context: { b: String(event.output) },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ a: context.a ?? "", b: context.b ?? "" }),
        },
      },
    });
  };

  test("a pending request round-trips through the persisted snapshot and re-executes idempotently on restore", async () => {
    const machine = buildMachine();
    const calls: string[] = [];

    // Capture a mid-flight persisted snapshot with a hanging executor.
    const bound = (await import("./index.js")).provideExecutors(machine, {
      generateText: async (request) => {
        calls.push(request.prompt ?? "");
        return new Promise(() => {}) as never;
      },
    });
    const actor = createActor(bound, { input: {} });
    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const persisted = actor.getPersistedSnapshot();
    actor.stop();
    expect(calls).toEqual(["one"]);

    // JSON round-trip, then restore with a resolving executor: the pending
    // request re-executes (XState restarts restored pending async logic).
    const resolving = {
      generateText: async (request: AgentTextRequest & { tools: AgentTools }) => {
        calls.push(`retry:${request.prompt}`);
        return { output: `ok:${request.prompt}` };
      },
    };
    const restored = await runAgent(machine, {
      snapshot: JSON.parse(JSON.stringify(persisted)),
      executors: resolving,
    });
    // First leg's call re-executed exactly once; run settled at the idle gate.
    expect(calls).toEqual(["one", "retry:one"]);
    expect(restored.status).toBe("idle");

    const finished = await runAgent(machine, {
      snapshot: restored.persist(),
      event: { type: "GO" },
      executors: resolving,
    });
    expect(calls).toEqual(["one", "retry:one", "retry:two"]);
    expect(finished.status).toBe("done");
    expect(finished.status === "done" ? finished.output : undefined).toEqual({
      a: "ok:one",
      b: "ok:two",
    });
  });

  test("executors receive runId and requestId correlation info", async () => {
    const machine = buildMachine();
    const seen: Array<{ runId?: string; requestId?: string }> = [];
    const result = await runAgent(machine, {
      input: {},
      executors: {
        generateText: async (request, info) => {
          seen.push({ runId: info?.runId, requestId: info?.requestId });
          return { output: `ok:${request.prompt}` };
        },
      },
    });
    expect(result.status).toBe("idle");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.runId).toMatch(/^run_\d+$/);
    expect(seen[0]?.requestId).toContain("first");
  });
});

describe("createAgentActor (session mode)", () => {
  const buildMachine = () => {
    const agentSetup = setupAgent({
      context: z.object({ a: z.string().nullable(), b: z.string().nullable() }),
      input: z.object({}),
      output: z.object({ a: z.string(), b: z.string() }),
      events: { GO: {} },
    });
    return agentSetup.createMachine({
      context: () => ({ a: null, b: null }),
      initial: "first",
      states: {
        first: {
          invoke: {
            src: "agent.generateText",
            input: () => ({ model: "m", prompt: "one" }),
            onDone: ({ event }) => ({
              target: "waiting",
              context: { a: String(event.output) },
            }),
          },
        },
        waiting: { on: { GO: { target: "second" } } },
        second: {
          invoke: {
            src: "agent.generateText",
            input: () => ({ model: "m", prompt: "two" }),
            onDone: ({ event }) => ({
              target: "done",
              context: { b: String(event.output) },
            }),
          },
        },
        done: {
          type: "final",
          output: ({ context }) => ({ a: context.a ?? "", b: context.b ?? "" }),
        },
      },
    });
  };

  const executors = {
    generateText: async (request: AgentTextRequest & { tools: AgentTools }) => ({
      output: `ok:${request.prompt}`,
      usage: { totalTokens: 7 },
    }),
  };

  test("actor survives an idle settle; the next event re-opens the cycle", async () => {
    const machine = buildMachine();
    const session = createAgentActor(machine, { input: {}, executors });

    const first = await session.settled();
    expect(first.status).toBe("idle");
    expect(first.usage.modelCalls).toBe(1);

    // Same live actor, no snapshot round-trip: send the next turn's event.
    session.actor.send({ type: "GO" });
    const second = await session.settled();
    expect(second.status).toBe("done");
    expect(second.status === "done" ? second.output : undefined).toEqual({
      a: "ok:one",
      b: "ok:two",
    });

    // Usage is cumulative across cycles.
    expect(session.usage().modelCalls).toBe(2);
    expect(session.usage().totalTokens).toBe(14);

    // done is final: settled() keeps resolving with the final result.
    const again = await session.settled();
    expect(again.status).toBe("done");
  });

  test("settled() called while idle resolves immediately with the current result", async () => {
    const machine = buildMachine();
    const session = createAgentActor(machine, { input: {}, executors });
    const first = await session.settled();
    expect(first.status).toBe("idle");
    // A second call with no new events resolves with the same idle result.
    const sameCycle = await session.settled();
    expect(sameCycle.status).toBe("idle");
    expect(sameCycle.snapshot).toBe(first.snapshot);
    session.stop();
  });

  test("runAgent one-shot behavior is unchanged: idle settle stops the actor", async () => {
    const machine = buildMachine();
    const result = await runAgent(machine, { input: {}, executors });
    expect(result.status).toBe("idle");
    // The one-shot path resumes by snapshot, not by live actor.
    const resumed = await runAgent(machine, {
      snapshot: result.persist(),
      event: { type: "GO" },
      executors,
    });
    expect(resumed.status).toBe("done");
  });
});

describe("machine version prop (createMachine({ version }))", () => {
  const buildVersioned = (
    version: string,
    migrate?: (snapshot: Snapshot<unknown>, fromVersion: string | undefined) => Snapshot<unknown>,
  ) => {
    const agentSetup = setupAgent({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
      events: { GO: {} },
      isIdle: (snapshot) => snapshot.hasTag("waiting"),
    });
    return agentSetup.createMachine({
      version,
      ...(migrate ? { migrate } : {}),
      context: () => ({}),
      initial: "waiting",
      states: {
        waiting: { tags: ["waiting"], on: { GO: { target: "done" } } },
        done: { type: "final", output: () => ({}) },
      },
    });
  };

  test("XState's persisted version resumes under the same machine", async () => {
    const machine = buildVersioned("3");
    const first = await runAgent(machine, { input: {} });
    expect(first.status).toBe("idle");
    const resumed = await runAgent(machine, {
      snapshot: JSON.parse(JSON.stringify(first.persist())),
      event: { type: "GO" },
    });
    expect(resumed.status).toBe("done");
  });

  test("a snapshot persisted under v1 refuses to resume under v2 (via the XState version field)", async () => {
    const machineV1 = buildVersioned("1");
    const first = await runAgent(machineV1, { input: {} });
    expect(first.status).toBe("idle");
    const persisted = JSON.parse(JSON.stringify(first.persist())) as Snapshot<unknown>;

    const machineV2 = buildVersioned("2");
    const mismatched = await runAgent(machineV2, {
      snapshot: persisted,
      event: { type: "GO" },
    });
    expect(mismatched.status).toBe("error");
    expect(String(mismatched.status === "error" ? mismatched.error : "")).toMatch(
      /does not match machine version/,
    );

    const migratingV2 = buildVersioned("2", (snapshot) => ({ ...snapshot, version: "2" }));
    const migrated = await runAgent(migratingV2, {
      snapshot: persisted,
      event: { type: "GO" },
    });
    expect(migrated.status).toBe("done");
  });
});

// ─── inspectTransitions (item 4) ───
describe("inspectTransitions", () => {
  test("observes an invoked child machine's transitions with its actorRef", async () => {
    const childAgent = setupAgent({
      context: z.object({}),
      output: z.object({ ok: z.boolean() }),
    });
    const childMachine = childAgent.createMachine({
      id: "insp-child",
      context: () => ({}),
      output: () => ({ ok: true }),
      initial: "childWorking",
      states: {
        childWorking: { always: { target: "childDone" } },
        childDone: { type: "final" },
      },
    });
    const parentAgent = setupAgent({
      context: z.object({}),
      output: z.object({ ok: z.boolean() }),
      actors: { child: childMachine },
    });
    const parentMachine = parentAgent.createMachine({
      id: "insp-parent",
      context: () => ({}),
      output: () => ({ ok: true }),
      initial: "delegating",
      states: {
        delegating: { invoke: { id: "child", src: "child", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });

    const observed: Array<{ id: string; value: unknown }> = [];
    const result = await runAgent(parentMachine, {
      input: {},
      inspect: inspectTransitions((snapshot, actorRef) => {
        observed.push({ id: actorRef.id, value: snapshot.value });
      }),
      executors: {
        generateText: async () => ({ output: {} }),
      },
    });

    expect(result.status).toBe("done");
    expect(observed.some((entry) => entry.id === "child" && entry.value === "childDone")).toBe(
      true,
    );
  });
});

describe("runAgent usage aggregation", () => {
  const usageSchemas = createAgentSchemas({
    context: z.object({ first: z.string().nullable(), second: z.string().nullable() }),
    input: z.object({}),
    output: z.object({ first: z.string(), second: z.string() }),
    events: { APPROVE: z.object({}) },
  });

  const step = createTextLogic({
    schemas: { input: z.object({ label: z.string() }), output: z.string() },
    model: "test-model",
    prompt: ({ input }) => input.label,
  });

  const usageAgent = setupAgent({ schemas: usageSchemas, actors: { step } });

  // first -> second -> done: two sequential model calls.
  const twoCallMachine = usageAgent.createMachine({
    context: { first: null, second: null },
    initial: "first",
    states: {
      first: {
        invoke: {
          id: "first",
          src: "step",
          input: { label: "one" },
          onDone: ({ output }) => ({ target: "second", context: { second: null, first: output } }),
        },
      },
      second: {
        invoke: {
          id: "second",
          src: "step",
          input: { label: "two" },
          onDone: ({ output, context }) => ({
            target: "done",
            context: { first: context.first, second: output },
          }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({ first: context.first ?? "", second: context.second ?? "" }),
      },
    },
  });

  test("sums reported token usage across calls and counts modelCalls", async () => {
    const result = await runAgent(twoCallMachine, {
      input: {},
      executors: {
        generateText: async (request: AgentTextRequest & { tools: AgentTools }) => ({
          output: `out:${request.prompt}`,
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
            reasoningTokens: 2,
            cachedInputTokens: 1,
          },
        }),
      },
    });

    expect(result.status).toBe("done");
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
      reasoningTokens: 4,
      cachedInputTokens: 2,
      modelCalls: 2,
    });
  });

  test("partial usage: fields are summed over the calls that reported them", async () => {
    let call = 0;
    const result = await runAgent(twoCallMachine, {
      input: {},
      executors: {
        generateText: async () => {
          call += 1;
          // Only the FIRST call reports usage, and only two fields of it.
          return call === 1
            ? { output: "a", usage: { inputTokens: 5, totalTokens: 6 } }
            : { output: "b" };
        },
      },
    });

    expect(result.status).toBe("done");
    // `outputTokens` was never reported by ANY call, so it stays undefined;
    // reported fields are sums over the reporting subset.
    expect(result.usage).toEqual({ inputTokens: 5, totalTokens: 6, modelCalls: 2 });
    expect(result.usage.outputTokens).toBeUndefined();
  });

  test("counts model calls even when no executor reports usage", async () => {
    const result = await runAgent(twoCallMachine, {
      input: {},
      executors: { generateText: async () => ({ output: "x" }) },
    });

    expect(result.usage).toEqual({ modelCalls: 2 });
  });

  test("idle result carries the usage of the calls made before the pause", async () => {
    const idleMachine = usageAgent.createMachine({
      context: { first: null, second: null },
      initial: "first",
      states: {
        first: {
          invoke: {
            id: "first",
            src: "step",
            input: { label: "one" },
            onDone: ({ output }) => ({
              target: "waiting",
              context: { second: null, first: output },
            }),
          },
        },
        waiting: { on: { APPROVE: { target: "done" } } },
        done: {
          type: "final",
          output: ({ context }) => ({ first: context.first ?? "", second: "" }),
        },
      },
    });

    const result = await runAgent(idleMachine, {
      input: {},
      executors: {
        generateText: async () => ({
          output: "drafted",
          usage: { inputTokens: 9, outputTokens: 3 },
        }),
      },
    });

    expect(result.status).toBe("idle");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3, modelCalls: 1 });

    // A resumed run counts only ITS OWN calls, not the prior run's.
    const resumed = await runAgent(idleMachine, {
      snapshot: result.persist(),
      event: { type: "APPROVE" },
      executors: { generateText: async () => ({ output: "unused" }) },
    });
    expect(resumed.status).toBe("done");
    expect(resumed.usage).toEqual({ modelCalls: 0 });
  });

  test("error result carries the usage of the calls made before the failure", async () => {
    const result = await runAgent(twoCallMachine, {
      input: {},
      maxModelCalls: 1,
      executors: {
        generateText: async () => ({ output: "a", usage: { inputTokens: 11, totalTokens: 12 } }),
      },
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.cause : undefined).toBe("max-model-calls");
    // The over-budget call never reached the executor, so it is not counted.
    expect(result.usage).toEqual({ inputTokens: 11, totalTokens: 12, modelCalls: 1 });
  });

  test("decide usage is aggregated, and each retry counts as its own call", async () => {
    const decideSchemas = createAgentSchemas({
      context: z.object({}),
      input: z.object({}),
      output: z.object({}),
      events: { GO: z.object({}) },
    });
    const pick = createDecisionLogic({
      model: "test-model",
      prompt: "choose",
      allowedEvents: ["GO"],
    });
    const decideAgent = setupAgent({ schemas: decideSchemas, actors: { pick } });
    const decideMachine = decideAgent.createMachine({
      context: {},
      initial: "deciding",
      states: {
        deciding: {
          invoke: { id: "pick", src: "pick", input: {} },
          on: { GO: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    let attempt = 0;
    const result = await runAgent(decideMachine, {
      input: {},
      executors: {
        decide: async () => {
          attempt += 1;
          return attempt === 1
            ? // First attempt picks an illegal event -> retried.
              { event: { type: "NOPE" } as ChosenEvent, usage: { inputTokens: 3 } }
            : { event: { type: "GO" } as ChosenEvent, usage: { inputTokens: 4, outputTokens: 1 } };
        },
      },
    });

    expect(result.status).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 1, modelCalls: 2 });
  });

  test("per-call usage rides the request.end trace event", async () => {
    const trace: AgentTraceEvent<typeof twoCallMachine>[] = [];
    await runAgent(twoCallMachine, {
      input: {},
      onTrace: (event) => trace.push(event),
      executors: {
        generateText: async () => ({ output: "x", usage: { inputTokens: 2, outputTokens: 1 } }),
      },
    });

    const ends = trace.filter((event) => event.type === "request.end");
    expect(ends).toHaveLength(2);
    for (const end of ends) {
      expect(end).toHaveProperty("usage", { inputTokens: 2, outputTokens: 1 });
    }
  });

  test("generateResult resolves usage alongside output", async () => {
    const result = await generateResult(twoCallMachine, {
      input: {},
      executors: {
        generateText: async () => ({ output: "x", usage: { inputTokens: 6, outputTokens: 2 } }),
      },
    });

    expect(result.output).toEqual({ first: "x", second: "x" });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4, modelCalls: 2 });
  });
});

describe("machine input validation", () => {
  // A machine whose input schema defaults every field except `topic`, and whose
  // context simply mirrors what the factory was handed.
  const buildMachine = () =>
    setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ topic: z.string(), rounds: z.number(), tone: z.string() }),
        input: z.object({
          topic: z.string(),
          rounds: z.number().default(3),
          tone: z.string().default("neutral"),
        }),
        output: z.object({ topic: z.string(), rounds: z.number(), tone: z.string() }),
      }),
    }).createMachine({
      id: "input-defaults",
      context: ({ input }) => ({ topic: input.topic, rounds: input.rounds, tone: input.tone }),
      initial: "done",
      states: {
        done: {
          type: "final",
          output: ({ context }) => context,
        },
      },
    });

  test("fills schema defaults before the context factory runs", async () => {
    const result = await runAgent(buildMachine(), { input: { topic: "otters" } });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // `rounds`/`tone` were never passed; the schema supplied them.
    expect(result.output).toEqual({ topic: "otters", rounds: 3, tone: "neutral" });
  });

  test("defaulted fields are optional at the call site, required ones are not", async () => {
    // Compile-time half: `{ topic }` alone type-checks above because `rounds`
    // and `tone` are defaulted, while `topic` (no default) stays required.
    await expect(
      runAgent(buildMachine(), {
        // @ts-expect-error `topic` has no default, so it cannot be omitted
        input: { rounds: 1 },
      }),
    ).rejects.toThrow(AgentError);
  });

  test("explicit values win over defaults", async () => {
    const result = await runAgent(buildMachine(), {
      input: { topic: "otters", rounds: 9 },
    });

    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({ topic: "otters", rounds: 9, tone: "neutral" });
  });

  test("schema defaults reach the machine context", async () => {
    const result = await runAgent(buildMachine(), { input: { topic: "otters" } });
    expect(result.snapshot.context).toEqual({ topic: "otters", rounds: 3, tone: "neutral" });
  });

  test("invalid input rejects with an AgentError, like a bad resume snapshot", async () => {
    // Thrown, not settled: the actor never starts, so this is a bad call rather
    // than a machine failure.
    await expect(
      runAgent(buildMachine(), {
        // `rounds` is not a number.
        input: { topic: "otters", rounds: "nine" } as never,
      }),
    ).rejects.toThrow(AgentError);

    const error: unknown = await runAgent(buildMachine(), {
      input: { topic: "otters", rounds: "nine" } as never,
    }).catch((caught: unknown) => caught);
    expect((error as AgentError).code).toBe("invalid-machine-input");
  });

  test("omitted input stays omitted rather than being validated as {}", async () => {
    // A machine that tolerates no input at all: omitting it must not start
    // failing just because a schema with required fields is declared.
    const machine = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ topic: z.string() }),
        input: z.object({ topic: z.string() }),
        output: z.object({ topic: z.string() }),
      }),
    }).createMachine({
      id: "no-input",
      context: ({ input }) => ({ topic: input?.topic ?? "(none)" }),
      initial: "done",
      states: { done: { type: "final", output: ({ context }) => context } },
    });

    const result = await runAgent(machine, {});

    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({ topic: "(none)" });
  });

  test("a machine with no declared input schema passes input through untouched", async () => {
    const machine = setup({
      schemas: { context: z.object({ seen: z.unknown() }) },
    }).createMachine({
      id: "plain",
      context: ({ input }) => ({ seen: input }),
      initial: "done",
      states: { done: { type: "final", output: ({ context }) => context.seen } },
    });

    const result = await runAgent(machine, { input: { anything: 1 } as never });

    if (result.status !== "done") throw new Error("expected done");
    expect(result.output).toEqual({ anything: 1 });
  });
});
