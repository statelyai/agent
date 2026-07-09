/**
 * Tiny readline helpers shared by the CLI examples. Both lazily import
 * `node:readline/promises` so importing an example's machine never touches
 * stdin.
 */

/** A minimal readline handle: ask one question, get the trimmed reply. */
export interface Readline {
  question: (query: string) => Promise<string>;
}

/**
 * Opens a readline interface over stdin/stdout, runs `fn` with it, and closes
 * it in a `finally`. Use when a single scope asks several questions (an
 * interaction loop); for a one-off prompt reach for {@link promptLine}.
 */
export async function withReadline<T>(fn: (rl: Readline) => Promise<T>): Promise<T> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

/** Prompts once with `query` and resolves the trimmed reply, opening and closing its own readline. */
export function promptLine(query: string): Promise<string> {
  return withReadline((rl) => rl.question(query)).then((answer) => answer.trim());
}
