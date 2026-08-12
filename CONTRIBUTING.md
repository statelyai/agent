# Contributing

`@statelyai/agent` is a control-flow library. This page describes what belongs in the core package and how to work on it.

## Core criteria

A feature belongs in core when a machine cannot otherwise express portable intent, or cannot hand that intent to an arbitrary host without framework-specific glue. Core candidates improve one of these areas:

- Authoring typed, inspectable control flow.
- Describing external work without executing it.
- Binding that work in any host.
- Suspending, persisting, and resuming without changing the machine.
- Stepping and replaying deterministically.
- Observing a run without coupling it to one telemetry or evaluation vendor.

A feature does not belong in core only because common agent applications need it. Search clients, vector stores, browser automation, code sandboxes, skills, prompt registries, eval scorers, and deployment servers evolve independently as specialized libraries.

For the full ownership table, see [Scope and ecosystem boundaries](docs/scope.md).

## Development

This repo uses pnpm.

```bash
pnpm install
pnpm vitest run
pnpm check       # typecheck, lint, format check, knip
pnpm docs:check  # typechecks fenced snippets in docs/
```

- Run tests non-interactively. Do not use watch mode in CI or in a submitted change.
- Add a changeset for any user-visible change: `pnpm changeset`.
- Docs live in `docs/`. Fenced `ts` blocks are typechecked by `scripts/check-docs-snippets.ts`. Fence a block as `ts no-check` to skip it.
- Examples live in `examples/`, one flat directory per example with an `index.ts` entrypoint. Each example is self-contained, with no shared harness and no local imports.

## Issues

Open an issue at [github.com/statelyai/agent/issues](https://github.com/statelyai/agent/issues). The API is in alpha, so reports about API shape and ergonomics are as useful as bug reports.
