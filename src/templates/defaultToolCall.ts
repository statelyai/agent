import { PromptTemplate } from '../types';
import { defaultTextTemplate } from './defaultText';

export const defaultToolCallTemplate: PromptTemplate<any> = (data) => {
  return `
${defaultTextTemplate(data)}

Only make a single tool call to achieve the above goal.
  `.trim();
};
