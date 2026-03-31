import { setup, SnapshotFrom } from 'xstate';
import { mapState } from '../src/mapState';

const machine = setup({}).createMachine({
  initial: 'checking',
  states: {
    checking: {
      on: {
        askForClarification: {
          target: 'clarifying',
        },
        submitEmail: {
          target: 'submitting',
        },
      },
    },
    clarifying: {
      on: {
        provideClarification: {
          target: 'checking',
        },
      },
    },
    submitting: {
      on: {
        confirm: {
          target: 'done',
        },
      },
    },
    done: {
      type: 'final',
    },
  },
});

function getStuff(snapshot: SnapshotFrom<typeof machine>) {
  return mapState<
    typeof snapshot,
    {
      goal: string;
    }
  >(snapshot, {
    states: {
      checking: {
        map: () => ({
          goal: 'Respond to the email given the instructions and the provided clarifications. If not enough information is provided, ask for clarification. Otherwise, if you are absolutely sure that there is no ambiguous or missing information, create and submit a response email.',
        }),
      },
      submitting: {
        map: () => ({
          goal: 'Create and submit an email based on the instructions.',
        }),
      },
    },
  });
}

async function main() {}
