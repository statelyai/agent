import { z } from 'zod';
import { createAgentMachine, type AgentAdapter } from '../src/index.js';
import { closePrompt, formatResult, isMain, prompt } from './_run.js';

type WorkflowTool = (input?: Record<string, unknown>) => Promise<unknown>;

const taskInputSchema = z.object({ task: z.string().optional() }).optional();

const planSchema = z.object({ plan: z.string() });
const implementationSchema = z.object({ summary: z.string() });
const testSchema = z.object({
  passed: z.boolean(),
  output: z.string().optional(),
});
const diagnosisSchema = z.object({ diagnosis: z.string() });
const rootCauseSchema = z.object({ rootCause: z.string() });
const proposalSchema = z.object({ proposal: z.string() });
const fixSchema = z.object({ applied: z.boolean(), summary: z.string() });
const verificationSchema = z.object({
  verified: z.boolean(),
  summary: z.string(),
});

const readOnlyCodingTools = {
  Read: async () => undefined,
  Grep: async () => undefined,
  Glob: async () => undefined,
  LS: async () => undefined,
  Bash: async () => undefined,
} satisfies Record<string, WorkflowTool>;

const editingCodingTools = {
  ...readOnlyCodingTools,
  Edit: async () => undefined,
  Write: async () => undefined,
} satisfies Record<string, WorkflowTool>;

const incidentReadTools = {
  Read: async () => undefined,
  Bash: async () => undefined,
  Grep: async () => undefined,
} satisfies Record<string, WorkflowTool>;

const incidentWriteTools = {
  Read: async () => undefined,
  Bash: async () => undefined,
} satisfies Record<string, WorkflowTool>;

const allIncidentTools = {
  list_services: async () => undefined,
  get_service: async () => undefined,
  list_volumes: async () => undefined,
  get_volume: async () => undefined,
  get_logs: async () => undefined,
  get_env: async () => undefined,
  update_env: async () => undefined,
  restart_service: async () => undefined,
  delete_volume: async () => undefined,
  delete_service: async () => undefined,
  test_connection: async () => undefined,
} satisfies Record<string, WorkflowTool>;

function createSequenceAdapter(results: unknown[]): AgentAdapter {
  let index = 0;

  return {
    async generateText() {
      const result = results[index] ?? results.at(-1);
      index += 1;
      return result;
    },
  };
}

export function createGuardrailedBugfixWorkflowExample(options: {
  adapter?: AgentAdapter;
} = {}) {
  return createAgentMachine({
    id: 'guardrailed-bugfix-workflow',
    schemas: { input: taskInputSchema },
    adapter:
      options.adapter
      ?? createSequenceAdapter([
        { plan: 'Read the failing test, inspect the implementation, then make the smallest fix.' },
        { summary: 'Applied a targeted code change.' },
        { passed: true, output: 'All tests passed.' },
      ]),
    context: (input) => ({
      task: input?.task ?? 'Fix the failing tests.',
      plan: null as string | null,
      changeSummary: null as string | null,
      testOutput: null as string | null,
    }),
    messages: (input) => [
      { role: 'user', content: input?.task ?? 'Fix the failing tests.' },
    ],
    initial: 'planning',
    states: {
      planning: {
        schemas: { output: planSchema },
        prompt:
          'Read relevant files and produce a brief fix plan. Do not edit anything yet.',
        tools: readOnlyCodingTools,
        onDone: ({ output }) => ({
          target: 'implementing',
          context: { plan: output.plan },
        }),
      },
      implementing: {
        schemas: { output: implementationSchema },
        prompt: ({ snapshot }) =>
          [
            'Implement the fix. Make targeted, minimal edits.',
            `Current state: ${snapshot.value}`,
            `Plan: ${snapshot.context.plan ?? 'none'}`,
          ].join('\n'),
        tools: editingCodingTools,
        onDone: ({ output }) => ({
          target: 'testing',
          context: { changeSummary: output.summary },
        }),
      },
      testing: {
        schemas: { output: testSchema },
        prompt: ({ snapshot }) =>
          [
            'Run the tests to verify the fix.',
            `Current state: ${snapshot.value}`,
            `Change summary: ${snapshot.context.changeSummary ?? 'none'}`,
          ].join('\n'),
        tools: {
          Read: readOnlyCodingTools.Read,
          Bash: readOnlyCodingTools.Bash,
        },
        onDone: ({ output }) =>
          output.passed
            ? {
                target: 'completed',
                context: { testOutput: output.output ?? null },
              }
            : {
                target: 'implementing',
                context: { testOutput: output.output ?? null },
              },
      },
      completed: {
        type: 'final',
        output: ({ context }) => ({
          plan: context.plan,
          changeSummary: context.changeSummary,
          testOutput: context.testOutput,
        }),
      },
    },
  });
}

export function createGuardrailedIncidentResponseExample(options: {
  adapter?: AgentAdapter;
} = {}) {
  return createAgentMachine({
    id: 'guardrailed-incident-response',
    schemas: {
      input: taskInputSchema,
      events: {
        APPROVED: z.object({ type: z.literal('APPROVED') }),
        REJECTED: z.object({ type: z.literal('REJECTED') }),
      },
    },
    adapter:
      options.adapter
      ?? createSequenceAdapter([
        { diagnosis: 'The web service cannot connect to its database.' },
        { rootCause: 'The staging database credential is stale.' },
        { proposal: 'Update the staging DB password and restart the web service.' },
        { applied: true, summary: 'Updated the staging DB password and restarted the service.' },
        { verified: true, summary: 'Connection test passed and service is healthy.' },
      ]),
    context: (input) => ({
      task:
        input?.task
        ?? 'The staging environment is down. Diagnose and repair without destructive actions.',
      diagnosis: null as string | null,
      rootCause: null as string | null,
      proposal: null as string | null,
      fixSummary: null as string | null,
      verification: null as string | null,
    }),
    messages: (input) => [
      {
        role: 'user',
        content:
          input?.task
          ?? 'The staging environment is down. Diagnose and repair without destructive actions.',
      },
    ],
    initial: 'diagnosing',
    states: {
      diagnosing: {
        schemas: { output: diagnosisSchema },
        prompt:
          'Check service status and logs. Identify the likely failure. Do not modify anything.',
        tools: {
          ...incidentReadTools,
          list_services: allIncidentTools.list_services,
          get_service: allIncidentTools.get_service,
          get_logs: allIncidentTools.get_logs,
          get_volume: allIncidentTools.get_volume,
          list_volumes: allIncidentTools.list_volumes,
        },
        onDone: ({ output }) => ({
          target: 'investigating',
          context: { diagnosis: output.diagnosis },
        }),
      },
      investigating: {
        schemas: { output: rootCauseSchema },
        prompt:
          'Investigate the root cause. Check environment variables, test connections, and read logs. Still read-only.',
        tools: {
          ...incidentReadTools,
          get_env: allIncidentTools.get_env,
          test_connection: allIncidentTools.test_connection,
          get_logs: allIncidentTools.get_logs,
        },
        onDone: ({ output }) => ({
          target: 'proposing',
          context: { rootCause: output.rootCause },
        }),
      },
      proposing: {
        schemas: { output: proposalSchema },
        prompt:
          'Propose the fix. Describe exactly what should change and why. Do not execute the fix yet.',
        tools: { Read: incidentReadTools.Read },
        onDone: ({ output }) => ({
          target: 'awaitingApproval',
          context: { proposal: output.proposal },
        }),
      },
      awaitingApproval: {
        prompt: ({ snapshot }) =>
          [
            `Await approval while in ${snapshot.value}.`,
            snapshot.context.proposal ?? '',
          ].join('\n'),
        tools: { Read: incidentReadTools.Read },
        on: {
          APPROVED: { target: 'executingFix' },
          REJECTED: { target: 'proposing' },
        },
      },
      executingFix: {
        schemas: { output: fixSchema },
        prompt:
          'Execute the approved fix. API actions allowed: update_env, restart_service. Do not delete volumes or services.',
        tools: {
          ...incidentWriteTools,
          update_env: allIncidentTools.update_env,
          restart_service: allIncidentTools.restart_service,
        },
        onDone: ({ output }) => ({
          target: 'verifying',
          context: { fixSummary: output.summary },
        }),
      },
      verifying: {
        schemas: { output: verificationSchema },
        prompt:
          'Verify the fix. Test the connection, check service status, and review logs.',
        tools: {
          ...incidentWriteTools,
          test_connection: allIncidentTools.test_connection,
          get_service: allIncidentTools.get_service,
          get_logs: allIncidentTools.get_logs,
        },
        onDone: ({ output }) =>
          output.verified
            ? {
                target: 'completed',
                context: { verification: output.summary },
              }
            : {
                target: 'proposing',
                context: { verification: output.summary },
              },
      },
      completed: {
        type: 'final',
        output: ({ context }) => ({
          diagnosis: context.diagnosis,
          rootCause: context.rootCause,
          proposal: context.proposal,
          fixSummary: context.fixSummary,
          verification: context.verification,
        }),
      },
    },
  });
}

export function createUnguardedIncidentResponseExample(options: {
  adapter?: AgentAdapter;
} = {}) {
  return createAgentMachine({
    id: 'unguarded-incident-response',
    schemas: { input: taskInputSchema },
    adapter:
      options.adapter
      ?? createSequenceAdapter([
        { applied: true, summary: 'Used whatever API actions were available to repair the service.' },
      ]),
    context: (input) => ({
      task:
        input?.task
        ?? 'The staging environment is down. Fix it with all API actions available.',
      fixSummary: null as string | null,
    }),
    messages: (input) => [
      {
        role: 'user',
        content:
          input?.task
          ?? 'The staging environment is down. Fix it with all API actions available.',
      },
    ],
    initial: 'working',
    states: {
      working: {
        schemas: { output: fixSchema },
        prompt: 'Fix the staging environment issue. All tools and API actions are available.',
        tools: {
          ...incidentReadTools,
          ...allIncidentTools,
        },
        onDone: ({ output }) => ({
          target: 'completed',
          context: { fixSummary: output.summary },
        }),
      },
      completed: {
        type: 'final',
        output: ({ context }) => ({ fixSummary: context.fixSummary }),
      },
    },
  });
}

async function main() {
  try {
    const task = await prompt('Task');
    const machine = createGuardrailedBugfixWorkflowExample();
    const result = await machine.execute(machine.getInitialState({ task }));

    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
