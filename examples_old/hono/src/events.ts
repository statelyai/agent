import { z } from 'zod';

// Events the agent can choose
export const agentEvents = {
  askForClarification: z
    .object({
      questions: z
        .array(z.string())
        .describe('Questions to ask the user for clarification'),
    })
    .describe('Ask the user for more information before drafting email'),

  submitEmail: z
    .object({
      recipient: z.string().describe('Email recipient address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body content'),
    })
    .describe('Submit the final drafted email'),
};

// Events the user sends
export const userEvents = {
  provideClarification: z.object({
    answers: z.string().describe('User answers to clarification questions'),
  }),

  confirm: z.object({}).describe('Confirm and send the email'),
};

export type AgentEventType = keyof typeof agentEvents;
export type UserEventType = keyof typeof userEvents;
