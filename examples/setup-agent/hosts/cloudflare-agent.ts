/**
 * Cloudflare Agents host for XState setup machines — PREVIEW CODE.
 *
 * Like the other platform host sketches in this repo, this file is
 * illustrative and excluded from typechecking (the `agents` package
 * requires `@cloudflare/workers-types` ambients).
 *
 * The shape:
 * - The Agent (a Durable Object) hosts the XState actor.
 * - The persisted snapshot lives in Agent state, so the machine survives
 *   hibernation/eviction and resumes exactly where it left off.
 * - Clients send machine events over WebSocket; provider/runtime details stay
 *   in the host actor implementations.
 */
import { Agent, type Connection } from 'agents';
import { createActor, type AnyActorRef, type Snapshot } from 'xstate';
import {
  draftEmail,
  emailDrafter,
  emailDrafterSchemas,
  evaluatePrompt,
} from '../email-drafter.js';
import { createAiSdkTextActor } from './ai-sdk.js';
import { createWorkersAI } from 'workers-ai-provider';

interface Env {
  AI: Ai;
}

interface EmailDrafterState {
  snapshot?: Snapshot<unknown>;
}

export class EmailDrafterAgent extends Agent<Env, EmailDrafterState> {
  initialState: EmailDrafterState = {};
  #actor: AnyActorRef | undefined;

  onStart() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const machine = emailDrafter.provide({
      actorSources: {
        evaluatePrompt: createAiSdkTextActor(evaluatePrompt, {
          resolveModel: (modelRef) => workersai(modelRef as never),
        }),
        draftEmail: createAiSdkTextActor(draftEmail, {
          resolveModel: (modelRef) => workersai(modelRef as never),
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
    const event = JSON.parse(message);
    const schema = emailDrafterSchemas.events[event.type];
    const result = schema?.['~standard'].validate(event);
    if (result?.issues) {
      connection.send(JSON.stringify({ type: 'error', issues: result.issues }));
      return;
    }
    this.#actor?.send(event);
  }
}
