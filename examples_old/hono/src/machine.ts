import { setup, assign } from 'xstate';

export const emailMachine = setup({
  types: {
    context: {} as {
      userRequest: string;
      recipient: string;
      subject: string;
      body: string;
      clarifications: string[];
      questions: string[];
    },
    events: {} as
      | { type: 'askForClarification'; questions: string[] }
      | { type: 'provideClarification'; answers: string }
      | { type: 'submitEmail'; recipient: string; subject: string; body: string }
      | { type: 'confirm' },
  },
}).createMachine({
  id: 'emailAgent',
  initial: 'checking',
  context: {
    userRequest: '',
    recipient: '',
    subject: '',
    body: '',
    clarifications: [],
    questions: [],
  },
  states: {
    checking: {
      // Agent decides: askForClarification or submitEmail
      on: {
        askForClarification: {
          target: 'clarifying',
          actions: assign({
            questions: ({ event }) => event.questions,
          }),
        },
        submitEmail: {
          target: 'submitting',
          actions: assign({
            recipient: ({ event }) => event.recipient,
            subject: ({ event }) => event.subject,
            body: ({ event }) => event.body,
          }),
        },
      },
    },
    clarifying: {
      // Wait for user clarification
      on: {
        provideClarification: {
          target: 'checking',
          actions: assign({
            clarifications: ({ context, event }) => [
              ...context.clarifications,
              event.answers,
            ],
          }),
        },
      },
    },
    submitting: {
      // User confirms or edits
      on: {
        confirm: 'done',
      },
    },
    done: {
      type: 'final',
    },
  },
});
