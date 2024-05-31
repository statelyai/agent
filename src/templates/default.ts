import { PromptTemplate } from '../types';

export const defaultPromptTemplate: PromptTemplate<any> = (data) => {
  return `
<context>
${JSON.stringify(data.context, null, 2)}
</context>

${data.goal}

Only make a single tool call to achieve the goal.
  `.trim();
};
