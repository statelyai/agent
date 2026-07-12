/**
 * Machines as data — a support-ticket workflow authored entirely as JSON.
 *
 * `workflow.json` in this directory is a real `.json` file, validated by
 * `schemas/agent-workflow.json` — the kind of thing a database, a visual
 * editor, or an LLM could produce. `setupAgent.fromConfig(...)` lowers it to
 * the same XState machine `setupAgent(...)` (TS authoring) would build, and
 * `runAgent(...)` runs it exactly like any other agent machine:
 *
 *   - `agent.decide` (triaging): the model chooses ESCALATE or REPLY. JSON
 *     cannot express a function, so the lowering delivers the chosen event
 *     automatically (the same auto-delivery `agent.decide` does in TS authoring)
 *     — only `onError` is configurable from the config.
 *   - `draftReply` (drafting): a plain text request, same as any
 *     `setupAgent({ requests: {...} })` request.
 *   - `awaitingApproval`: an idle state — no invoke, nothing left to do
 *     until a human sends APPROVE/REJECT. `runAgent` settles
 *     `{ status: 'idle', snapshot }`; the host persists that snapshot and
 *     resumes with `runAgent(machine, { snapshot, event, ...executors })`.
 *
 * `fromConfig(...)` requires a `compileSchema` option — the library does not
 * bundle a JSON Schema engine, so the config's JSON Schemas (context/events/
 * input/output, request input/output) are only as strict as whatever
 * validator you bring. This example wires up Ajv, a real JSON Schema engine,
 * as the showcase recipe: it honors the full JSON Schema spec (pattern,
 * minLength, anyOf, format, ...). Core intentionally ships no JSON Schema
 * engine.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/json-agent/index.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import Ajv from "ajv";
import {
  runAgent,
  setupAgent,
  type AgentWorkflowConfig,
  type SchemaCompiler,
  type StandardSchemaV1,
} from "../../src/index.js";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

// The Ajv-to-StandardSchema recipe: compile the JSON Schema with Ajv, then
// wrap the compiled validator as a `StandardSchemaV1`, mapping Ajv's
// validation errors onto Standard Schema issues.
const ajv = new Ajv({ strict: false });
const ajvCompiler: SchemaCompiler = (jsonSchema, name): StandardSchemaV1 => {
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

const workflowPath = fileURLToPath(new URL("./workflow.json", import.meta.url));
export const workflowConfig: AgentWorkflowConfig = JSON.parse(readFileSync(workflowPath, "utf-8"));

export const jsonAgentMachine = setupAgent.fromConfig(workflowConfig, {
  compileSchema: ajvCompiler,
});

// A JSON-authored machine carries string model refs (it cannot reference a
// `models` registry object), so this host uses `resolveModel` — the max-portability
// escape hatch — instead of the canonical `createAiSdkExecutors({ models })`.
function resolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ""));
}

export async function runJsonAgentDemo(ticket: string) {
  const { generateText, decide } = createAiSdkExecutors({ resolveModel });

  const onTransition = (snapshot: { value: unknown }) =>
    console.log("[state]", JSON.stringify(snapshot.value));

  let result = await runAgent(jsonAgentMachine, {
    input: { ticket },
    generateText,
    decide,
    onTransition,
  });

  if (result.status === "idle") {
    // A human approves the drafted reply — in a real host this is a
    // separate request/process; here we simulate immediate approval.
    result = await runAgent(jsonAgentMachine, {
      snapshot: result.snapshot,
      event: { type: "APPROVE" },
      generateText,
      decide,
      onTransition,
    });
  }

  if (result.status !== "done") {
    throw new Error(`JSON agent demo did not complete: ${result.status}`);
  }

  return result.output;
}

runExampleMain(import.meta.url, async () => {
  console.log(await runJsonAgentDemo("My invoice total looks wrong, please help."));
});
