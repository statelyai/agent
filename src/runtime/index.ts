import type {
  AgentRun,
  AgentSnapshot,
  StandardSchemaV1,
} from '../types.js';

export function waitForRunDone<
  TContext extends Record<string, unknown>,
  TValue extends string,
  TEvents extends Record<string, StandardSchemaV1>,
  TOutput,
  TEmitted extends Record<string, StandardSchemaV1>,
>(
  run: AgentRun<TContext, TValue, TEvents, TOutput, TEmitted>
): Promise<{
  output: TOutput;
  snapshot: AgentSnapshot<TContext, TValue, TOutput>;
}> {
  return new Promise((resolve, reject) => {
    const offDone = run.onDone((event) => {
      offDone();
      offError();
      resolve(event);
    });
    const offError = run.onError((event) => {
      offDone();
      offError();
      reject(event.error);
    });
  });
}

export function waitForRunSnapshot<
  TContext extends Record<string, unknown>,
  TValue extends string,
  TEvents extends Record<string, StandardSchemaV1>,
  TOutput,
  TEmitted extends Record<string, StandardSchemaV1>,
>(
  run: AgentRun<TContext, TValue, TEvents, TOutput, TEmitted>,
  predicate: (
    snapshot: AgentSnapshot<TContext, TValue, TOutput>
  ) => boolean,
  timeoutMs = 1000
): Promise<AgentSnapshot<TContext, TValue, TOutput>> {
  const current = run.getSnapshot();
  if (predicate(current)) {
    return Promise.resolve(current);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Run snapshot did not reach the expected state in time.'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      offSnapshot();
      offDone();
      offError();
    };

    const check = (snapshot: AgentSnapshot<TContext, TValue, TOutput>) => {
      if (predicate(snapshot)) {
        cleanup();
        resolve(snapshot);
      }
    };

    const offSnapshot = run.onSnapshot(check);
    const offDone = run.onDone((event) => {
      check(event.snapshot);
    });
    const offError = run.onError((event) => {
      cleanup();
      reject(event.error);
    });
  });
}
