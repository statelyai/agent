/**
 * A run as one stream: every streamed model chunk as it arrives, then the
 * settled result. Server functions return the stream (TanStack Start
 * serializes a `ReadableStream` incrementally), and the client reads chunks
 * into the pending message until the result lands.
 */

/**
 * One piece of a streaming request's text. `key` separates parallel streams;
 * `call` changes when the same request runs again (a retry, a redraft).
 */
export type RunChunk = { key: string; call: number; label: string; delta: string };

export type RunStreamEvent<TResult> =
  | { type: "chunk"; chunk: RunChunk }
  | { type: "result"; result: TResult }
  | { type: "error"; message: string };

/** What a streaming request looks like to `onChunk`. */
type ChunkRequest = { id: string; src: unknown };

/** The request's display name: its actor source when named, else the last segment of its id. */
function chunkLabel(request: ChunkRequest): string {
  if (typeof request.src === "string") return request.src;
  return request.id.split(".").pop() || request.id;
}

/**
 * Server side: runs `run`, emitting its chunks and then its result. Cancelling
 * the stream (the client went away) aborts the run, as the request signal does.
 */
export function streamRun<TResult>(
  run: (options: {
    signal: AbortSignal;
    onChunk: (delta: string, info: { request: ChunkRequest }) => void;
  }) => Promise<TResult>,
  requestSignal: AbortSignal,
): ReadableStream<RunStreamEvent<TResult>> {
  const cancelled = new AbortController();
  // Each call's request object is new, so it numbers the calls per key.
  const calls = new WeakMap<object, number>();
  const callCounts = new Map<string, number>();
  const callOf = (request: ChunkRequest): number => {
    let call = calls.get(request);
    if (call === undefined) {
      call = (callCounts.get(request.id) ?? 0) + 1;
      callCounts.set(request.id, call);
      calls.set(request, call);
    }
    return call;
  };
  const signal = AbortSignal.any([requestSignal, cancelled.signal]);
  return new ReadableStream<RunStreamEvent<TResult>>({
    async start(controller) {
      let open = true;
      const send = (event: RunStreamEvent<TResult>) => {
        if (open) controller.enqueue(event);
      };
      try {
        const result = await run({
          signal,
          onChunk: (delta, { request }) =>
            send({
              type: "chunk",
              chunk: {
                key: request.id,
                call: callOf(request),
                label: chunkLabel(request),
                delta,
              },
            }),
        });
        send({ type: "result", result });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // Already cancelled by the client.
        }
      }
    },
    cancel() {
      cancelled.abort(new DOMException("Run cancelled.", "AbortError"));
    },
  });
}

/**
 * Client side: forwards each chunk to `onChunk` and resolves with the result.
 * Aborting `signal` stops reading at once — the decoded stream is not tied to
 * the request's signal — and rejects with an `AbortError`.
 */
export async function readRunStream<TResult>(
  stream: ReadableStream<RunStreamEvent<TResult>>,
  onChunk: (chunk: RunChunk) => void,
  signal: AbortSignal,
): Promise<TResult> {
  const cancelled = () => new DOMException("Run cancelled.", "AbortError");
  const reader = stream.getReader();
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      reject(cancelled());
      void reader.cancel().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value.type === "chunk") onChunk(value.chunk);
      else if (value.type === "result") return value.result;
      else throw new Error(value.message);
    }
  } catch (error) {
    if (signal.aborted) throw cancelled();
    throw error;
  }
  if (signal.aborted) throw cancelled();
  throw new Error("The run ended without a result.");
}
