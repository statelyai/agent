import { describe, expect, test } from 'vitest';
import { createWriteABookFlowExample } from '../../examples/index.js';

describe('CrewAI write a book flow equivalent', () => {
  test('outlines a book, writes chapters in parallel, and compiles a manuscript', async () => {
    const machine = createWriteABookFlowExample({
      createOutline: async () => ({
        title: 'The Workflow Book',
        chapters: [
          { title: 'Chapter 1', brief: 'Introduction' },
          { title: 'Chapter 2', brief: 'Execution' },
        ],
      }),
      writeChapter: async ({ title, brief }) => ({
        title,
        content: `${title}: ${brief}`,
      }),
      compileManuscript: async ({ title, chapters }) => ({
        manuscript: [
          `# ${title}`,
          ...chapters.map((chapter) => `## ${chapter.title}\n${chapter.content}`),
        ].join('\n\n'),
      }),
    });

    const result = await machine.execute(
      machine.getInitialState({
        topic: 'Workflow systems',
        goal: 'Teach developers how to build durable AI workflows.',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output.title).toBe('The Workflow Book');
      expect(result.output.outline).toHaveLength(2);
      expect(result.output.chapters).toEqual([
        { title: 'Chapter 1', content: 'Chapter 1: Introduction' },
        { title: 'Chapter 2', content: 'Chapter 2: Execution' },
      ]);
      expect(result.output.manuscript).toContain('# The Workflow Book');
    }
  });
});
