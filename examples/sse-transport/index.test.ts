import { test, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createSseServer } from './index.js';

/** Parses a raw SSE stream body into ordered `{ event, data }` frames. */
function parseSseFrames(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
          data += line.slice('data: '.length);
        }
      }
      return { event, data: JSON.parse(data) };
    });
}

test('SSE transport forwards chunks, transitions, and final output', async () => {
  const server = createSseServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const frames = parseSseFrames(await res.text());

    // Chunk frames (default `message` event) arrive in stream order.
    const chunks = frames
      .filter((f) => f.event === 'message')
      .map((f) => (f.data as { chunk: string }).chunk);
    expect(chunks).toEqual(['Once ', 'upon ', 'a topic: agents']);

    // At least one transition frame, reaching the final `done` state value.
    const transitions = frames
      .filter((f) => f.event === 'transition')
      .map((f) => (f.data as { value: unknown }).value);
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions).toContain('done');

    // Exactly one terminal frame carrying the machine output.
    const done = frames.filter((f) => f.event === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]!.data).toEqual({ text: 'Once upon a topic: agents' });

    // Ordering: last chunk precedes the `done` frame.
    const doneIndex = frames.findIndex((f) => f.event === 'done');
    const lastChunkIndex = frames.map((f) => f.event).lastIndexOf('message');
    expect(lastChunkIndex).toBeLessThan(doneIndex);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
});
