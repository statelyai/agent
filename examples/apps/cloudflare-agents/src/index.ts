import { routeAgentRequest } from 'agents';
import { ReviewWorkflowAgent } from './review-workflow-agent.js';

export { ReviewWorkflowAgent };

export default {
  async fetch(request: Request, env: Record<string, unknown>) {
    return (
      await routeAgentRequest(request, env, {
        prefix: '/agents',
      })
    ) ?? new Response('Not found', { status: 404 });
  },
};
