// Ambient context for documentation snippets.
//
// `scripts/check-docs-snippets.ts` injects each block below (separated by blank
// lines) into a doc snippet ONLY when the snippet references that name and does
// not declare or import it itself. Everything exported by `@statelyai/agent`
// and its subpaths is auto-imported by the script and does not belong here.
//
// One declared name per block, please.

import { z } from 'zod';

import { generateText } from 'ai';

import { streamText } from 'ai';

import { tool } from 'ai';

import type { LanguageModel } from 'ai';

import { openai } from '@ai-sdk/openai';

import { createActor } from 'xstate';

import { setup } from 'xstate';

import { assign } from 'xstate';

import { fromPromise } from 'xstate';

import { sendTo } from 'xstate';

import { raise } from 'xstate';

import { spawnChild } from 'xstate';

import type { AnyStateMachine } from 'xstate';

import type { AnyActorRef } from 'xstate';

import type { EventObject } from 'xstate';

import { test } from 'vitest';

import { expect } from 'vitest';

import { describe } from 'vitest';

import { it } from 'vitest';

import { vi } from 'vitest';

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

// --- generic placeholders -------------------------------------------------

declare const machine: AnyStateMachine;

declare const baseMachine: AnyStateMachine;

declare const existingMachine: AnyStateMachine;

declare const childMachine: AnyStateMachine;

declare const parentMachine: AnyStateMachine;

declare const moderationMachine: AnyStateMachine;

declare const haikuMachine: AnyStateMachine;

declare const refundMachine: AnyStateMachine;

declare const announceMachine: AnyStateMachine;

declare const gameMachine: AnyStateMachine;

declare const toolCallingMachine: AnyStateMachine;

declare const emailDrafter: AnyStateMachine;

declare const actor: AnyActorRef;

declare const model: LanguageModel;

declare const someLanguageModel: LanguageModel;

declare const anotherLanguageModel: LanguageModel;

declare const haiku: LanguageModel;

declare const input: any;

declare const output: any;

declare let result: any;

declare const generateResult: any;

declare const rawOutput: any;

declare const snapshot: any;

declare const persistSnapshot: (snapshot: any) => Promise<void>;

declare const store: any;

declare const executors: any;

declare const agentSetup: any;

declare const request: any;

declare const run: any;

declare const usage: any;

declare const trace: any;

declare const config: any;

declare const options: any;

declare const context: any;

declare const system: any;

declare const src: any;

declare const jsonl: string;

declare const eventLog: any;

declare const entries: any[];

declare const persistedEntries: any[];

declare const previousEvents: any[];

declare const allowedEvents: string[];

declare const graph: any;

declare const dataset: any;

declare const Eval: any;

declare const seams: any;

declare const effect: any;

declare const draft: any;

declare const draftText: string;

declare const candidate: any;

declare const key: string;

declare const label: string;

declare const kind: string;

declare const id: string;

declare const first: any;

declare const field: string;

declare const eventType: string;

declare const statePath: string;

declare const threadId: string;

declare const turnAt: number;

declare const totalTokens: number;

declare const inputTokens: number;

declare const outputTokens: number;

declare const cachedInputTokens: number;

declare const reasoningTokens: number;

declare const chosenType: string;

declare const answerSchema: z.ZodType;

declare const planSchema: z.ZodType;

declare const resultSchema: z.ZodType;

declare const inputSchema: z.ZodType;

declare const taskInputSchema: z.ZodType;

declare const triageSchema: z.ZodType;

declare const tools: Record<string, unknown>;

declare const subAgents: Record<string, unknown>;

declare const models: Record<string, LanguageModel>;

declare const workflowJson: any;

declare const workerConfig: any;

declare const workerRequest: any;

declare const app: any;

declare const handle: any;

declare const mailer: any;

declare const log: any;

declare const replay: any;

declare const send: any;

declare const on: any;

declare const actions: any;

declare const states: any;

declare const initial: any;

declare const onDone: any;

declare const onError: any;

declare const execute: any;

declare const generate: any;

declare const decide: any;

declare const ask: any;

declare const append: any;

declare const rewrite: any;

declare const builder: any;

declare const vagueAssessment: any;

declare const formPayload: any;

declare const providerContent: any;

declare const DbClient: any;

declare const Session: any;

declare const Ai: any;

declare const Command: any;

// --- placeholder functions -------------------------------------------------

declare function fetchWeather(city: string): Promise<any>;

declare function draftEmail(input: any): Promise<any>;

declare function promptUser(question: any): Promise<any>;

declare function showFormAndWaitForSubmit(payload: any): Promise<any>;

declare function renderCommand(command: any): string;

declare function estimateCost(usage: any): number;

declare function resolveModel(key: string): LanguageModel;

declare function createMyStore(): any;

declare function appendToStore(entry: any): Promise<void>;

declare function createReplayEntry(entry: any): any;

declare function createSubAgentExecute(config: any): any;

declare function scriptedExecutorsFor(config: any): any;

declare function runSeamCase(input: any): Promise<any>;

declare function runDrafterCase(input: any): Promise<any>;

declare function scoreStatePath(...args: any[]): number;

declare function scoreEventTrajectory(...args: any[]): number;

declare function scoreOutputStructure(...args: any[]): number;

declare function scoreTokenBudget(...args: any[]): number;

declare function traceTransitions(...args: any[]): any;

declare function executeEffect(effect: any): Promise<any>;

declare function completeAssessment(...args: any[]): any;

declare function ajvCompileSchema(schema: any): any;

declare function myCustomStreamText(options: any): any;

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

type State = any;
