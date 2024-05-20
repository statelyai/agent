import { generateText } from 'ai';
import { AgentStrategy } from '../types';
import wiki from 'wikipedia';

export function chainOfNote() {
  return {
    generateText: async (x) => {
      const passages = await wiki.search(x.prompt!, {
        limit: 5,
      });

      const extracts = await Promise.all(
        passages.results.map(async (p) => {
          const summary = await wiki.summary(p.title);
          return summary.extract;
        })
      );
      x.agent?.addHistory({
        content: x.prompt!,
        id: Date.now() + '',
        role: 'user',
        timestamp: Date.now(),
      });
      const result = await generateText({
        model: x.model,
        system: `Task Description:

1. Read the given question and five Wikipedia passages to gather relevant information.

2. Write reading notes summarizing the key points from these passages.

3. Discuss the relevance of the given question and Wikipedia passages.

4. If some passages are relevant to the given question, provide a brief answer based on the passages. 

5. If no passage is relevant, direcly provide answer without considering the passages.

Passages: \n${extracts.join('\n')}`,
        prompt: `${x.prompt!}`,
      });

      x.agent?.addHistory({
        content: result.text,
        id: Date.now() + '',
        role: 'user',
        timestamp: Date.now(),
      });

      return result;
    },
  } satisfies AgentStrategy;
}
