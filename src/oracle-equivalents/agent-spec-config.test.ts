import Ajv from "ajv";
import { describe, expect, test } from "vitest";
import { createActor, createAsyncLogic, waitFor } from "xstate";
import { setupAgent, type SchemaCompiler, type StandardSchemaV1 } from "../index.js";
// initialAgentStep is an internal step-envelope helper now (off the public
// /steps subpath); imported directly from ../steps.js.
import { initialAgentStep } from "../steps.js";

function ajvCompiler(): SchemaCompiler {
  const ajv = new Ajv({ strict: false });

  return (jsonSchema, name): StandardSchemaV1 => {
    const validateFn = ajv.compile(jsonSchema);

    return {
      "~standard": {
        version: 1,
        vendor: "ajv",
        validate(value: unknown) {
          if (validateFn(value)) {
            return { value };
          }
          return {
            issues: (validateFn.errors ?? []).map((error) => ({
              message: `${name}${error.instancePath} ${error.message}`,
            })),
          };
        },
        jsonSchema: { input: () => jsonSchema },
      },
    };
  };
}

describe("Oracle Agent Spec-style static workflows", () => {
  test("adapts branching and data-flow edges to state guards and assignments", () => {
    // Adapted from Oracle Agent Spec
    // pyagentspec/tests/agentspec_configs/example_serialized_flow_with_branching_node.yaml
    // Oracle Agent Spec is distributed under Apache-2.0 or UPL-1.0.
    const { machine } = setupAgent.fromConfig(
      {
        id: "oracle-branching-equivalent",
        schemas: {
          input: {
            type: "object",
            properties: {
              input1: { type: "string" },
              input2: { type: "string" },
            },
            required: ["input1", "input2"],
          },
          context: {
            type: "object",
            properties: {
              input1: { type: "string" },
              input2: { type: "string" },
              input1IsYes: { type: "boolean" },
              input1IsNo: { type: "boolean" },
              input2IsYes: { type: "boolean" },
              input2IsNo: { type: "boolean" },
              result: { type: "string" },
            },
            required: ["input1", "input2"],
          },
          output: {
            type: "object",
            properties: {
              result: { type: "string" },
            },
            required: ["result"],
          },
        },
        context: {
          input1: "{{ input.input1 }}",
          input2: "{{ input.input2 }}",
          input1IsYes: "{{ input.input1IsYes }}",
          input1IsNo: "{{ input.input1IsNo }}",
          input2IsYes: "{{ input.input2IsYes }}",
          input2IsNo: "{{ input.input2IsNo }}",
        },
        initial: "branchInput1",
        states: {
          branchInput1: {
            always: [
              {
                guard: "{{ context.input1IsYes }}",
                target: "yesEnd",
              },
              {
                guard: "{{ context.input1IsNo }}",
                target: "noEnd",
              },
              {
                target: "branchInput2",
              },
            ],
          },
          branchInput2: {
            always: [
              {
                guard: "{{ context.input2IsYes }}",
                target: "nestedYesEnd",
              },
              {
                guard: "{{ context.input2IsNo }}",
                target: "noEnd",
              },
              {
                target: "defaultEnd",
              },
            ],
          },
          yesEnd: {
            type: "final",
            output: {
              result: "{{ context.input1 }}",
            },
          },
          nestedYesEnd: {
            type: "final",
            output: {
              result: "{{ context.input2 }}",
            },
          },
          noEnd: {
            type: "final",
            output: {
              result: "no",
            },
          },
          defaultEnd: {
            type: "final",
            output: {
              result: "default",
            },
          },
        },
      },
      { compileSchema: ajvCompiler() },
    );

    const yesStep = initialAgentStep(machine, {
      input1: "yes",
      input2: "no",
      input1IsYes: true,
      input1IsNo: false,
      input2IsYes: false,
      input2IsNo: true,
    });
    expect(yesStep.done).toBe(true);
    expect(yesStep.snapshot.output).toEqual({ result: "yes" });

    const nestedStep = initialAgentStep(machine, {
      input1: "maybe",
      input2: "yes",
      input1IsYes: false,
      input1IsNo: false,
      input2IsYes: true,
      input2IsNo: false,
    });
    expect(nestedStep.done).toBe(true);
    expect(nestedStep.snapshot.output).toEqual({ result: "yes" });
  });

  test("adapts sequential LLM and tool nodes to invoked requests and host actors", async () => {
    // Adapted from Oracle Agent Spec
    // pyagentspec/tests/agentspec_configs/example_serialized_flow.yaml
    // Oracle Agent Spec is distributed under Apache-2.0 or UPL-1.0.
    const machine = setupAgent
      .fromConfig(
        {
          id: "oracle-linear-flow-equivalent",
          schemas: {
            context: {
              type: "object",
              properties: {
                firstText: { type: "string" },
                secondText: { type: "string" },
                forecast: { type: "string" },
              },
            },
            output: {
              type: "object",
              properties: {
                forecast: { type: "string" },
              },
              required: ["forecast"],
            },
          },
          context: {},
          requests: {
            node12: {
              model: "agi_model1",
              prompt: "something something",
              input: {
                type: "object",
                properties: {},
              },
              output: {
                type: "object",
                properties: {
                  generated_text: { type: "string" },
                },
                required: ["generated_text"],
              },
            },
            node3: {
              model: "agi_model1",
              prompt: "something something else",
              input: {
                type: "object",
                properties: {
                  previous: { type: "string" },
                },
                required: ["previous"],
              },
              output: {
                type: "object",
                properties: {
                  generated_text: { type: "string" },
                },
                required: ["generated_text"],
              },
            },
          },
          actors: {
            toolNode: {
              input: {
                type: "object",
                properties: {
                  city_name: { type: "string" },
                },
                required: ["city_name"],
              },
              output: {
                type: "object",
                properties: {
                  forecast: { type: "string" },
                },
                required: ["forecast"],
              },
            },
          },
          initial: "node12",
          states: {
            node12: {
              invoke: {
                id: "node12",
                src: "node12",
                input: {},
                onDone: {
                  target: "node3",
                  assign: {
                    firstText: "{{ event.output.generated_text }}",
                  },
                },
              },
            },
            node3: {
              invoke: {
                id: "node3",
                src: "node3",
                input: {
                  previous: "{{ context.firstText }}",
                },
                onDone: {
                  target: "toolNode",
                  assign: {
                    secondText: "{{ event.output.generated_text }}",
                  },
                },
              },
            },
            toolNode: {
              invoke: {
                id: "toolNode",
                src: "toolNode",
                input: {
                  city_name: "zurich",
                },
                onDone: {
                  target: "done",
                  assign: {
                    forecast: "{{ event.output.forecast }}",
                  },
                },
              },
            },
            done: {
              type: "final",
              output: {
                forecast: "{{ context.forecast }}",
              },
            },
          },
        },
        { compileSchema: ajvCompiler() },
      )
      .machine.provide({
        actors: {
          node12: createAsyncLogic({
            run: async () => ({
              generated_text: "first generated text",
            }),
          }),
          node3: createAsyncLogic({
            run: async ({ input }) => {
              expect(input).toEqual({ previous: "first generated text" });
              return { generated_text: "second generated text" };
            },
          }),
          toolNode: createAsyncLogic({
            run: async ({ input }) => {
              expect(input).toEqual({ city_name: "zurich" });
              return { forecast: "sunny" };
            },
          }),
        },
      });

    const actor = createActor(machine).start();
    await waitFor(actor, (snapshot) => snapshot.status === "done");

    expect(actor.getSnapshot().context).toEqual({
      firstText: "first generated text",
      secondText: "second generated text",
      forecast: "sunny",
    });
    expect(actor.getSnapshot().output).toEqual({ forecast: "sunny" });
  });
});
