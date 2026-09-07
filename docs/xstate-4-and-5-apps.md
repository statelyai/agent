---
title: Use in an XState 4 or 5 app
description: Isolate @statelyai/agent behind a workspace package so an app on XState 4 or 5 can call an agent without upgrading.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

`@statelyai/agent` peers on `xstate@>=6.0.0-alpha.46 <6.0.0`. An app already using XState 4 or 5 for its own machines cannot install both versions into one `node_modules` tree and have each resolve the one it needs. This page isolates the agent in its own workspace package so the app keeps its XState version and never imports XState 6.

The same page applies to an app with no XState at all that cannot take a prerelease dependency in its main tree.

## The constraints

- **XState versions do not mix in one package.** `@statelyai/agent` builds machines with XState 6's `setup` API. Handing an XState 6 machine to an XState 4 or 5 `interpret`/`createActor` does not work, and neither does the reverse.
- **`overrides` and `resolutions` are not the fix.** A `pnpm.overrides` or a yarn `resolutions` entry forces one version for every consumer, which is the problem restated. Forcing XState 5 breaks the agent; forcing XState 6 breaks the app's own machines.
- **Zod must be 4, or 3.24 and later.** Schemas reach the library through [Standard Schema](https://standardschema.dev), which zod implements from 3.24. Zod 3.23 and earlier expose no `~standard` property and are rejected. Valibot, ArkType, and hand-written validators work on the same terms.

## The recipe

Put the agent in a workspace package that owns its own dependencies, and give the app one plain async function to call. The machine never crosses the package boundary; only JSON-safe input and output do.

### The package

```json
// packages/agent/package.json
{
  "name": "@acme/agent",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@statelyai/agent": "2.0.0-alpha.22",
    "@ai-sdk/openai": "^4.0.0",
    "ai": "^7.0.0",
    "xstate": "6.0.0-alpha.48",
    "zod": "^4.4.3"
  }
}
```

Pin the alpha exactly. With pnpm workspaces this package gets its own `node_modules` with XState 6 in it, while the app keeps XState 5 in its own. npm and yarn workspaces hoist by default, so add the package to `nohoist` (yarn 1) or keep the app's XState version pinned in the app's own `package.json`; check with `npm ls xstate` that two versions resolve.

### The export

One async function in, one JSON-safe object out. Everything XState is inside it.

```ts no-check
// packages/agent/src/index.ts
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { models, generationMachine } from "./machine.js";

export interface GenerationInput {
  prompt: string;
}

export interface GenerationOutput {
  summary: string;
  draft: string | null;
}

export interface GenerationDeps {
  /** Called once per state change, for the app's progress UI. */
  onProgress?: (state: string) => void;
  /** The app's own resource, wrapped as an actor inside this package. */
  lookup: (query: string) => Promise<string[]>;
}

export async function runGeneration(
  input: GenerationInput,
  deps: GenerationDeps,
): Promise<GenerationOutput> {
  const result = await runAgent(generationMachine(deps.lookup), {
    input,
    executors: createAiSdkExecutors({ models }),
    onTransition: (snapshot) => deps.onProgress?.(String(snapshot.value)),
  });
  if (result.status !== "done") {
    throw new Error(`Generation did not complete: ${result.status}`);
  }
  return result.output;
}
```

Two rules keep the boundary intact:

- **Nothing XState-typed is in the signature.** No machine, no snapshot, no `ActorRef`. Input and output are plain objects the app can also serialize, log, and store.
- **Host resources come in as callbacks.** `deps.lookup` is the app's database or search client, passed as a function. The package wraps it in an actor with `machine.provide({ actors })`. The app never sees the actor.

### The call site

The app imports one function. Its own XState version is untouched.

```ts no-check
// apps/web/src/routes/generate.ts
import { runGeneration } from "@acme/agent";
import { db } from "../db.js";

export async function POST(request: Request) {
  const { prompt } = await request.json();
  const output = await runGeneration(
    { prompt },
    { lookup: (query) => db.search(query) },
  );
  return Response.json(output);
}
```

## What can cross the boundary

Persisted snapshots are JSON. `result.persist()` returns a plain JSON value, and `runAgent(machine, { snapshot })` takes one back, so a paused run can be stored by the app, in its own database, and resumed by a later call into the package.

```ts no-check
// Inside the package: the app stores and returns the value, and never reads it.
export async function startGeneration(input: GenerationInput): Promise<{ snapshot: unknown }> {
  const result = await runAgent(generationMachine, { input, executors });
  return { snapshot: result.status === "idle" ? result.persist() : null };
}
```

Treat the snapshot as opaque in the app: it is the agent package's format, and its shape changes when the machine does. See [Persistence](persistence.md).

## Related

- [Use in any stack](any-stack.md): the same isolation applied to a framework's request lifecycle.
- [Persistence](persistence.md): what a snapshot contains and how to migrate one.
- [Machines](machines.md): the schemas that carry the Standard Schema requirement.
