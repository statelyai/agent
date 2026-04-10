import type {
  AgentAdapter,
  DecideResultFor,
  InvokeEnqueue,
  StandardSchemaV1,
  StateConfig,
  TransitionResult,
} from './types.js';

type TransitionTargetOf<T> = T extends { target?: infer TTarget }
  ? Extract<TTarget, string>
  : never;

type HandlerTargetOf<T> = T extends (...args: any[]) => infer TResult
  ? TransitionTargetOf<TResult>
  : TransitionTargetOf<T>;

type OnTargets<TOn> = TOn extends Record<string, infer THandler>
  ? HandlerTargetOf<THandler>
  : never;

type DecideStateConfig<
  TContext extends Record<string, unknown>,
  TTarget extends string,
  TParamsByTarget extends Record<string, any>,
> = Pick<
  StateConfig<TContext, TTarget, TParamsByTarget>,
  'on'
> & {
  __type: 'decide';
  __decideConfig: Record<string, unknown>;
};

/**
 * Create a decision state where an LLM picks from constrained options.
 * Each option has a description and optional schema for structured data.
 *
 * The result type is a discriminated union — `result.choice` narrows `result.data`.
 *
 */
export function decide<
  TContext extends Record<string, unknown>,
  const TOptions extends Record<
    string,
    { description: string; schema?: StandardSchemaV1 }
  >,
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TTarget extends string = string,
  TParamsByTarget extends Record<string, any> = {},
>(
  config: {
    model: string;
    adapter?: AgentAdapter;
    prompt: string | ((args: { context: TContext; params: TParams }) => string);
    options: TOptions;
    reasoning?: boolean;
    onDone: (args: {
      result: DecideResultFor<TOptions>;
      context: TContext;
    }) => TransitionResult<TContext, TTarget, TParamsByTarget>;
    on?: Record<
      string,
      (
        args: { event: any; context: TContext },
        enq: InvokeEnqueue
      ) => TransitionResult<TContext, TTarget, TParamsByTarget>
    >;
  }
): DecideStateConfig<
  TContext,
  TTarget,
  TParamsByTarget
> {
  return {
    __type: 'decide',
    __decideConfig: config as unknown as Record<string, unknown>,
    on: config.on as StateConfig<
      TContext,
      TTarget,
      TParamsByTarget
    >['on'],
  };
}
