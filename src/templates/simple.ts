import { generateText } from 'ai';
import { GenerateTextOptions, AgentTemplate } from '../types';
import { PromptTemplate } from '../utils';

export const defaultPromptTemplate: PromptTemplate = (data) => {
  return `
<context>
${JSON.stringify(data.context, null, 2)}
</context>

${data.goal}

Only make a single tool call to achieve the goal.
  `.trim();
};

export function createDefaultTemplate(
  options?: GenerateTextOptions
): AgentTemplate {
  return {
    decide: async (x) => {
      const prompt = `
<context>
${JSON.stringify(x.state.context, null, 2)}
</context>

${x.goal}

Only make a single tool call to achieve the goal.
      `.trim();

      const result = await generateText({
        model: x.model,
        prompt,
        tools: x.toolMap as any,
        ...options,
      });

      const singleResult = result.toolResults[0];

      if (!singleResult) {
        return undefined;
      }

      return {
        goal: x.goal,
        state: x.state,
        steps: [
          {
            event: singleResult.result,
          },
        ],
        nextEvent: singleResult.result,
      };
    },
  };
}
