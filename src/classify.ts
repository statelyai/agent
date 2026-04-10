import type {
  AgentAdapter,
  InvokeEnqueue,
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

type ClassifyStateConfig<
  TContext extends Record<string, unknown>,
  TTarget extends string,
  TParamsByTarget extends Record<string, any>,
> = Pick<
  StateConfig<TContext, TTarget, TParamsByTarget>,
  'on'
> & {
  __type: 'classify';
  __classifyConfig: Record<string, unknown>;
  __decideConfig: Record<string, unknown>;
};

/**
 * Create a classification state. Sugar over `decide` for simple routing —
 * categories with descriptions, no per-option schemas.
 *
 * `result.category` is typed as a union of the `into` keys.
 *
 */
export function classify<
  TContext extends Record<string, unknown>,
  const TCategories extends Record<string, { description: string }>,
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TTarget extends string = string,
  TParamsByTarget extends Record<string, any> = {},
>(
  config: {
    model: string;
    adapter?: AgentAdapter;
    prompt: string | ((args: { context: TContext; params: TParams }) => string);
    into: TCategories;
    examples?: Array<{ input: string; category: keyof TCategories & string }>;
    onDone: (args: {
      result: { category: keyof TCategories & string };
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
): ClassifyStateConfig<
  TContext,
  TTarget,
  TParamsByTarget
> {
  const decideOptions: Record<string, { description: string }> = {};
  for (const [key, val] of Object.entries(config.into)) {
    decideOptions[key] = { description: val.description };
  }

  return {
    __type: 'classify',
    __classifyConfig: config as unknown as Record<string, unknown>,
    __decideConfig: {
      model: config.model,
      adapter: config.adapter,
      prompt: config.prompt,
      options: decideOptions,
      onDone: ({ result, context }: any) => {
        return config.onDone({
          result: { category: result.choice },
          context,
        });
      },
    },
    on: config.on as StateConfig<
      TContext,
      TTarget,
      TParamsByTarget
    >['on'],
  };
}
