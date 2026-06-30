# Examples

<!-- example groups derived from examples/setup-agent/** and examples/index.ts -->

This directory is organized around normal XState `setup(...)` machines with reusable text actors.

## Start Here

- Authoring reusable text logic and XState agent machines: [`setup-agent/email-drafter.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/email-drafter.ts)
- Running with host actors: [`setup-agent/hosts/ai-sdk.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/ai-sdk.ts)
- Host actor guide: [`../docs/host-actors.md`](/Users/davidkpiano/Code/agent/docs/host-actors.md)
- Comparing LangGraph and Burr patterns: [`../src/langgraph-equivalents/raw-xstate.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/raw-xstate.test.ts), [`../src/burr-equivalents/raw-xstate.test.ts`](/Users/davidkpiano/Code/agent/src/burr-equivalents/raw-xstate.test.ts)

## XState Examples

These use normal XState `setup(...)` plus `createTextLogic(...)` from `@statelyai/agent`. The runtime is flexible: use `createActor(...)` locally, provide different host actors in apps, or persist XState snapshots in a platform adapter.

- [`setup-agent/email-drafter.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/email-drafter.ts): typed email workflow with independently testable text logic
- [`setup-agent/game-agent.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/game-agent.ts): turn-based game workflow with whitelisted event tools
- [`setup-agent/smoke.mts`](/Users/davidkpiano/Code/agent/examples/setup-agent/smoke.mts): deterministic local XState runtime smoke test
- [`setup-agent/hosts/ai-sdk.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/ai-sdk.ts): Vercel AI SDK host actors
- [`setup-agent/hosts/ai-sdk-game.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/ai-sdk-game.ts): Vercel AI SDK step runner
- [`setup-agent/hosts/cloudflare-workers-ai.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/cloudflare-workers-ai.ts): Cloudflare Workers AI step runner
- [`setup-agent/hosts/tanstack-ai.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/tanstack-ai.ts): TanStack AI step runner sketch
- [`setup-agent/hosts/cloudflare-agent.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/cloudflare-agent.ts): Cloudflare Agents host sketch

## Parity Tracking

- [`../docs/langgraph-parity.md`](/Users/davidkpiano/Code/agent/docs/langgraph-parity.md)
- [`../docs/langgraph-gaps.md`](/Users/davidkpiano/Code/agent/docs/langgraph-gaps.md)
- [`../docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md)
- [`../docs/burr-parity.md`](/Users/davidkpiano/Code/agent/docs/burr-parity.md)

The parity docs track end-result coverage and remaining gaps. New examples should use `createTextLogic(...)` for reusable LLM work and normal XState `setup({ schemas, actorSources })` for schema-first machine authoring.
