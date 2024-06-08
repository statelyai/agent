import { generateText, streamText } from 'ai';
import { AIAdapter } from '../types';

export const vercelAdapter: AIAdapter = {
  generateText,
  streamText,
};
