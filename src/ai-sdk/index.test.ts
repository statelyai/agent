import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { AgentDecisionRequest, AgentEventDescriptor } from '../setup-agent.js';
import {
  isStructuredOutputRequest,
  toAiSdkCallSettings,
  toAiSdkEventTools,
  toAiSdkToolChoice,
  toAiSdkTools,
  toDecisionMessages,
} from './index.js';

describe('toAiSdkTools', () => {
  test('converts agent tool descriptors to AI SDK tools', () => {
    const inputSchema = z.object({ target: z.string() });
    const tools = toAiSdkTools({
      send_event_ATTACK: {
        description: 'Attack a target.',
        inputSchema,
        execute: async (input) => ({ type: 'ATTACK', ...input as object }),
      },
    });

    expect(tools.send_event_ATTACK).toEqual(
      expect.objectContaining({
        description: 'Attack a target.',
        inputSchema,
        execute: expect.any(Function),
      })
    );
  });
});

describe('isStructuredOutputRequest', () => {
  test('is true for an object-shaped outputSchema', () => {
    expect(isStructuredOutputRequest({ outputSchema: z.object({ ok: z.boolean() }) })).toBe(true);
  });

  test('is false with no outputSchema', () => {
    expect(isStructuredOutputRequest({})).toBe(false);
  });

  test('is false for a non-object outputSchema', () => {
    expect(isStructuredOutputRequest({ outputSchema: z.string() })).toBe(false);
  });
});

describe('toAiSdkToolChoice', () => {
  test('maps a named tool choice to AI SDK shape', () => {
    expect(toAiSdkToolChoice({ type: 'tool', name: 'send_event_ATTACK' })).toEqual({
      type: 'tool',
      toolName: 'send_event_ATTACK',
    });
  });

  test('passes through string choices unchanged', () => {
    expect(toAiSdkToolChoice('required')).toBe('required');
    expect(toAiSdkToolChoice(undefined)).toBeUndefined();
  });
});

describe('toAiSdkCallSettings', () => {
  test('uses messages when present (identity mapping)', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const settings: Record<string, unknown> = toAiSdkCallSettings({ model: 'openai/gpt-4.1-mini', messages });
    expect(settings.messages).toBe(messages as never);
    expect(settings).not.toHaveProperty('prompt');
  });

  test('falls back to prompt when messages are absent', () => {
    const settings: Record<string, unknown> = toAiSdkCallSettings({ model: 'openai/gpt-4.1-mini', prompt: 'hello' });
    expect(settings.prompt).toBe('hello');
    expect(settings).not.toHaveProperty('messages');
  });

  test('maps model params and toolChoice', () => {
    const settings = toAiSdkCallSettings({
      model: 'openai/gpt-4.1-mini',
      prompt: 'hi',
      temperature: 0.2,
      maxTokens: 100,
      topP: 0.9,
      topK: 40,
      seed: 7,
      stopSequences: ['STOP'],
      toolChoice: { type: 'tool', name: 'send_event_ATTACK' },
    });

    expect(settings.temperature).toBe(0.2);
    expect(settings.maxOutputTokens).toBe(100);
    expect(settings.topP).toBe(0.9);
    expect(settings.topK).toBe(40);
    expect(settings.seed).toBe(7);
    expect(settings.stopSequences).toEqual(['STOP']);
    expect(settings.toolChoice).toEqual({ type: 'tool', toolName: 'send_event_ATTACK' });
  });

  test('builds AI SDK tools when request tools are present', () => {
    const settings = toAiSdkCallSettings({
      model: 'openai/gpt-4.1-mini',
      prompt: 'hi',
      tools: { lookup: { description: 'Look something up.' } },
    });
    expect(settings.tools).toHaveProperty('lookup');
  });

  test('omits tools when request has none', () => {
    const settings = toAiSdkCallSettings({ model: 'openai/gpt-4.1-mini', prompt: 'hi' });
    expect(settings.tools).toBeUndefined();
  });
});

describe('toAiSdkEventTools', () => {
  test('builds one tool per event with a permissive fallback schema', () => {
    const events: AgentEventDescriptor[] = [
      { type: 'ATTACK', toolName: 'send_event_ATTACK', inputSchema: z.object({ target: z.string() }) },
      { type: 'FLEE', toolName: 'send_event_FLEE' },
    ];
    const tools = toAiSdkEventTools(events);

    expect(Object.keys(tools)).toEqual(['send_event_ATTACK', 'send_event_FLEE']);
    expect(tools.send_event_ATTACK).toEqual(
      expect.objectContaining({
        description: "Choose the 'ATTACK' move.",
        inputSchema: events[0]!.inputSchema,
      })
    );
    // Fallback schema is present (permissive) when the event has none.
    expect(tools.send_event_FLEE!.inputSchema).toBeDefined();
  });
});

describe('toDecisionMessages', () => {
  const events: AgentEventDescriptor[] = [
    { type: 'ATTACK', toolName: 'send_event_ATTACK' },
    { type: 'FLEE', toolName: 'send_event_FLEE' },
  ];

  test('returns undefined with no messages and no attempts', () => {
    const request: Pick<AgentDecisionRequest, 'messages' | 'events' | 'attempts'> = {
      events,
      attempts: [],
    };
    expect(toDecisionMessages(request)).toBeUndefined();
  });

  test('passes messages through unchanged when there are no attempts', () => {
    const messages = [{ role: 'user' as const, content: 'choose' }];
    const request: Pick<AgentDecisionRequest, 'messages' | 'events' | 'attempts'> = {
      messages,
      events,
      attempts: [],
    };
    expect(toDecisionMessages(request)).toEqual(messages);
  });

  test('a prompt-authored decision keeps its prompt when attempts lower it to messages', () => {
    const request: Pick<
      AgentDecisionRequest,
      'messages' | 'prompt' | 'events' | 'attempts'
    > = {
      prompt: 'Pick the best move.',
      events,
      attempts: [
        { event: { type: 'HEAL' }, failure: 'unknown-event', reason: "'HEAL' is not allowed." },
      ],
    };

    const messages = toDecisionMessages(request);
    expect(messages).toHaveLength(2);
    expect(messages![0]).toEqual({ role: 'user', content: 'Pick the best move.' });
    expect(messages![1]!.role).toBe('user');
  });

  test('appends a user message per failed attempt describing the failure and choices', () => {
    const request: Pick<AgentDecisionRequest, 'messages' | 'events' | 'attempts'> = {
      events,
      attempts: [
        { event: { type: 'HEAL' }, failure: 'unknown-event', reason: "'HEAL' is not allowed." },
      ],
    };

    const messages = toDecisionMessages(request);
    expect(messages).toHaveLength(1);
    expect(messages![0]).toEqual({
      role: 'user',
      content: "Your previous choice failed: 'HEAL' is not allowed.. Choose again from: ATTACK, FLEE",
    });
  });

  test('renders multiple attempts as multiple appended messages, in order', () => {
    const request: Pick<AgentDecisionRequest, 'messages' | 'events' | 'attempts'> = {
      messages: [{ role: 'user', content: 'go' }],
      events,
      attempts: [
        { failure: 'unknown-event', reason: 'first failure' },
        { failure: 'invalid-payload', reason: 'second failure' },
      ],
    };

    const messages = toDecisionMessages(request);
    expect(messages).toHaveLength(3);
    expect(messages![1]!.content).toContain('first failure');
    expect(messages![2]!.content).toContain('second failure');
  });
});
