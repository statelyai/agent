/**
 * `createGeneratorBridge`: an async generator's pull contract, across an
 * actor boundary.
 * @module
 */

/** What {@link GeneratorBridge.forward} reports once the generator stops. */
export type ForwardResult<TReturn> =
  | { closed: false; value: TReturn }
  /** The consumer stopped reading; `value` is what the generator returned while unwinding. */
  | { closed: true; value: TReturn | undefined };

/** The two ends of a {@link createGeneratorBridge} bridge. */
export interface GeneratorBridge<T> {
  /**
   * Producer side, inside an actor: hands `value` to the consumer and waits
   * until the consumer pulls again, as a generator suspended at `yield`
   * does. Resolves `true` when the consumer pulled, `false` when it stopped
   * (`.return()`, a `break`) or the run settled. Rejects with what the
   * consumer passed to `.throw()`.
   */
  put(value: T): Promise<boolean>;
  /**
   * Producer side: drives `generator` through {@link put}. A consumer's
   * `.throw(error)` becomes `generator.throw(error)`; a consumer that stops
   * gets `generator.return()`, so its `finally` blocks run before this
   * resolves. Values the generator yields while unwinding still reach the
   * consumer, as with `yield*`.
   */
  forward<TReturn>(generator: AsyncGenerator<T, TReturn, undefined>): Promise<ForwardResult<TReturn>>;
  /**
   * Consumer side: yields each value the producer puts until `settled`
   * resolves, then returns what it resolved to. Pass the run:
   * `const result = yield* bridge.stream(runAgent(machine, options))`. When
   * the consumer stops, it waits for `settled` before it returns, so the
   * producer has unwound by then, and returns what `settled` resolved to
   * rather than the value passed to `.return()`. As with any `yield*`, a
   * stopped consumer skips the code after it in the enclosing generator;
   * cleanup that must run either way goes in a `finally`.
   */
  stream<TSettled>(settled: PromiseLike<TSettled>): AsyncGenerator<T, TSettled, undefined>;
}

interface Item<T> {
  value: T;
  pulled: (pulled: boolean) => void;
  threw: (error: unknown) => void;
}

/**
 * A backpressured hand-off between an actor and an async generator's
 * consumer, for a loop whose public surface is an `AsyncGenerator`: the
 * machine owns the loop head, each pass is an actor, and the events it
 * yields still reach the consumer one pull at a time.
 *
 * One bridge serves one run.
 *
 * @example
 * ```ts
 * async function* carvedLoop(input: Input): AsyncGenerator<Event, Result> {
 *   const bridge = createGeneratorBridge<Event>();
 *   const pass = createAsyncLogic({
 *     run: async () => {
 *       const step = await bridge.forward(legacyPass(input));
 *       return step.closed ? { kind: "closed" } : step.value;
 *     },
 *   });
 *   const result = yield* bridge.stream(runAgent(loopMachine, { input, actors: { pass } }));
 *   if (result.status === "error") throw result.error;
 *   return toResult(result);
 * }
 * ```
 */
export function createGeneratorBridge<T>(): GeneratorBridge<T> {
  const queue: Item<T>[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const put = (value: T): Promise<boolean> => {
    if (ended) return Promise.resolve(false);
    return new Promise<boolean>((pulled, threw) => {
      queue.push({ value, pulled, threw });
      notify();
    });
  };

  return {
    put,
    async forward<TReturn>(generator: AsyncGenerator<T, TReturn, undefined>) {
      let closed = false;
      let step = await generator.next();
      while (!step.done) {
        let pulled: boolean;
        try {
          pulled = await put(step.value);
        } catch (error) {
          step = await generator.throw(error);
          continue;
        }
        if (pulled) {
          step = await generator.next();
        } else {
          closed = true;
          step = await generator.return(undefined as TReturn);
        }
      }
      return { closed, value: step.value } as ForwardResult<TReturn>;
    },
    async *stream<TSettled>(settled: PromiseLike<TSettled>) {
      const end = () => {
        ended = true;
        // Puts from an actor the run stopped: release them so it unwinds.
        for (const item of queue.splice(0)) item.pulled(false);
        notify();
      };
      Promise.resolve(settled).then(end, end);
      const next = async (): Promise<Item<T> | undefined> => {
        while (!queue.length && !ended) await new Promise<void>((resolve) => (wake = resolve));
        return queue.shift();
      };
      const loop = async function* (): AsyncGenerator<T, TSettled, undefined> {
        while (true) {
          const item = await next();
          if (!item) return await settled;
          let resumed = false;
          try {
            yield item.value;
            resumed = true;
            item.pulled(true);
          } catch (error) {
            resumed = true;
            item.threw(error);
          } finally {
            if (!resumed) {
              // The consumer stopped: the producer unwinds, what it yields
              // while unwinding still reaches the consumer (as with
              // `yield*`), and the run settles before this returns.
              item.pulled(false);
              // oxlint-disable-next-line no-unsafe-finally
              return yield* loop();
            }
          }
        }
      };
      return yield* loop();
    },
  };
}
