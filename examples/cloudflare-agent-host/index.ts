/// <reference types="@cloudflare/workers-types" />
/**
 * Cloudflare Agents host for XState setup machines.
 *
 * The shape:
 * - The Agent (a Durable Object) hosts the XState actor.
 * - The persisted snapshot lives in Agent state, so the machine survives
 *   hibernation/eviction and resumes exactly where it left off.
 * - Clients send machine events over WebSocket; provider/runtime details stay
 *   in the host actor implementations.
 *
 * Model resolution is injected via `resolveModel` (an AI SDK `LanguageModel`
 * resolver — same shape as `../ai-sdk-host/index.ts`) rather than hardcoded
 * to a specific provider package, since this repo does not depend on any one
 * Cloudflare AI binding provider. In a real deployment, wire the
 * `workers-ai-provider` package's `createWorkersAI({ binding: this.env.AI })`
 * here for Workers AI, or any other AI SDK provider for an external model.
 */
import { Agent, type Connection } from 'agents';
import { createActor, type Actor, type Snapshot } from 'xstate';
import type { LanguageModel } from 'ai';
import {
  draftEmail,
  emailDrafter,
  emailDrafterSchemas,
  evaluatePrompt,
} from '../email-drafter/index.js';
import { createAiSdkTextActor } from '../ai-sdk-host/index.js';

interface Env {
  AI: Ai;
}

interface EmailDrafterState {
  snapshot?: Snapshot<unknown>;
}

export abstract class EmailDrafterAgent extends Agent<Env, EmailDrafterState> {
  initialState: EmailDrafterState = {};
  #actor: Actor<typeof emailDrafter> | undefined;

  /**
   * Resolves a machine's `model` string to an AI SDK `LanguageModel`.
   *
   * Declared `abstract` so a concrete deployment subclass *must* supply it —
   * a compile-time requirement rather than a runtime throw. The Durable Object
   * constructor is fixed by the runtime `(ctx, env)`, so the resolver can't be
   * a constructor parameter; making it abstract is how the requirement is
   * enforced at the type level. Wire a real provider in the subclass, e.g.:
   *   resolveModel = (modelRef: string) =>
   *     createWorkersAI({ binding: this.env.AI })(modelRef as Parameters<typeof workersai>[0]);
   */
  abstract resolveModel(modelRef: string): LanguageModel;

  onStart() {
    const machine = emailDrafter.provide({
      actorSources: {
        evaluatePrompt: createAiSdkTextActor(evaluatePrompt, {
          resolveModel: this.resolveModel,
        }),
        draftEmail: createAiSdkTextActor(draftEmail, {
          resolveModel: this.resolveModel,
        }),
      },
    });

    // Restore from the persisted snapshot if the DO was evicted mid-run.
    this.#actor = createActor(machine, {
      snapshot: this.state.snapshot,
    });

    this.#actor.subscribe((snapshot) => {
      // Durable persistence on every transition: this is the journal the
      // analytics/visualization layer reads, keyed by this Agent instance.
      this.setState({ snapshot: this.#actor!.getPersistedSnapshot() });
      this.broadcast(
        JSON.stringify({
          type: 'state',
          value: snapshot.value,
          // meta is schema-typed: clients get the interaction protocol
          // (text / select / confirm) for the current state.
          meta: snapshot.getMeta(),
        })
      );
    });

    this.#actor.start();
  }

  onMessage(connection: Connection, message: string) {
    // Client messages are machine events (PROMPT_SUBMITTED, SEND, ...).
    // The machine's event schemas validate them before they hit the actor.
    const event = JSON.parse(message) as { type: string; [key: string]: unknown };
    const schema =
      emailDrafterSchemas.events[event.type as keyof typeof emailDrafterSchemas.events];
    const result = schema?.['~standard'].validate(event);
    // Event schemas here are synchronous (Zod) — a Promise result would mean
    // an async validator, which this simple example doesn't support.
    if (result && !(result instanceof Promise) && result.issues) {
      connection.send(JSON.stringify({ type: 'error', issues: result.issues }));
      return;
    }
    this.#actor?.send(event as never);
  }
}
