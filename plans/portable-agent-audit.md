# Portable XState agent audit

Audited revision: `4c39d3681ded940b2d824a10fa1e5266eaa17729`, integration branch `next`, September 7, 2026. Dedicated branch: `feature/portable-agent-audit`.

## Assessment

The right foundation already exists: ordinary XState machines, typed request actors, named host bindings, structured decisions, inspection, and optional adapters. The strongest product is **portable statechart logic with explicit capability boundaries**, backed by behavioral conformance across hosts. Another layer of workflow primitives would weaken that advantage.

The biggest gap is correctness under composition: cancellation, child schemas, error replay, concurrent traces, and partial exploration. These matter more than another SDK integration. The present “invalid actions impossible,” “runs anywhere,” and safety-proof claims exceed the evidence in those cases.

This audit recommends core fixes and simplifications; it does not implement them. The branch adds three examples, failure-path tests, and documentation. No provider credentials or real external booking operations were used.

## Scope and evidence

Covered all public entrypoint families: root authoring/types, text and decision execution, controlled/native host binding, streaming, log/store/replay, JSON workflow lowering/schema validation, verification/simulation, scripted executors, seams/trajectories, presets, AI SDK/OpenAI adapters, OTel, package exports, CI, docs, example catalog, and demo example discovery. Source coverage is weighted toward execution and composition; not every test or UI component received line-by-line review.

Baseline: `pnpm vitest run`, 76 files and 952 tests passed. Runtime and compiler probes found defects outside that suite. “Reproduced” below means a local deterministic probe; it does not mean a production incident. “Source” means confirmed control flow without an independent runtime reproduction. All included findings have high confidence unless explicitly qualified.

Not audited: deployed services, live SDK/provider calls, authenticated security boundaries, complete demo UI/accessibility, production load, platform certification, or formal exhaustive model checking. Dependency audit reported zero high/critical advisories; lower-severity findings in demo/host dependency chains did not establish an exploitable application path. No performance benchmarks were run.

Current `next` contains event-log/store and OpenAI APIs. Earlier simplification notes described a different revision; recommendations below use current source.

## Prioritized findings

Effort: S = hours, M = about a day, L = multiple days, including regression coverage. Risk describes the change, not the defect. Priority weights consequences, effort, confidence, and dependencies; architectural options follow separately.

| # | Finding | Category / impact | Effort | Change risk | Evidence / confidence |
| --- | --- | --- | --- | --- | --- |
| 01 | Cancelled decisions deliver stale events | Correctness: exited work mutates later state | S | Low | `src/decision.ts:628–640`, `src/run-agent.ts:1462–1480`; reproduced, high |
| 02 | OpenAI tool arguments bypass schemas | Correctness: malformed model data reaches effects | M | Medium | `src/openai/index.ts:520–529,663–674`; reproduced, high |
| 03 | Reachability reports hide uncertainty and payloads | Validation: reachable paths reported absent | M | Medium | `src/verify.ts:1231–1259,1365–1383`; reproduced, high |
| 04 | Failed journal writes can return success | Durability: result claims undurable completion | M | Medium | `src/run-agent.ts:2105–2107,2630–2634,2918`; reproduced, high |
| 05 | Child decisions inherit root schemas | Correctness: child event payloads unvalidated | S | Low | `src/run-agent.ts:1797–1809,2348`; reproduced, high |
| 06 | Void completions escape as uncaught serialization errors | Correctness: normal XState actors crash a run | M | Medium | `src/run-agent.ts:2146,2805`, `src/event-log.ts:208–209,558–562`; reproduced, high |
| 07 | Root-only journals lose nested progress | Durability: completed child calls execute again | L | High | `src/run-agent.ts:2755–2759,2585–2597`; reproduced, high |
| 08 | Error encoding drops routing discriminants | Replay: live/replayed paths diverge | M | Medium | `src/event-log.ts:328–335,558`; reproduced, high |
| 09 | Top-level decision bindings are overwritten | Portability: native and controlled hosts disagree | S | Low | `src/run-agent.ts:2329–2338,1813–1819`; reproduced, high |
| 10 | Presets hard-code persistence version `1` | Durability: changed topology passes identity gate | S–M | Medium | `src/machines/sequential.ts:153–157`, `parallel.ts:99–103`, `src/utils.ts:131–132`; reproduced, high |
| 11 | Duplicate sequential names overwrite work | Correctness: configured steps disappear | S | Low | `src/machines/sequential.ts:94–109`, `internal.ts:219–241`; reproduced, high |
| 12 | OTel request IDs collide across runs | Observability: spans and usage attributed to wrong run | S | Low | `src/otel/index.ts:214–247,289–317`; reproduced, high |
| 13 | OpenAI history drops request-level system prompt | Portability: adding history changes instructions | S | Low | `src/openai/index.ts:102–173,177–180`; reproduced, high |
| 14 | Wildcard handlers disappear from accepted events | Correctness: decisions/UI omit valid actions | M | Medium | `src/events.ts:254–280`, `src/interaction.ts:173`; reproduced, high |
| 15 | Named actions lose schema-aware types | Type safety: invalid context access compiles | M | Medium | `src/setup-agent.ts:510,558`; compiler probe, high |
| 16 | Input helpers disagree on schema defaults | API/types: equivalent callers need different input | M | Medium | `src/type-helpers.ts:26–28`, `src/run-agent.ts:1740–1749`, `src/setup-agent.ts:468–474`; compiler probe, high |
| 17 | Loop persistence skips the final idle result | Durability: limit or absent handler skips checkpoint | S | Low | `src/run-loop.ts:70–75`; source, high |
| 18 | Seam slices use any actor completion | Evaluation: sibling progress attributed to candidate | M | Medium | `src/seam.ts:324–329,404–425`; source, high |
| 19 | Public effect resolver omits execution metadata | Portability: custom hosts cannot forward signal/chunks | S | Low | `src/steps.ts:451–485`; source, high |
| 20 | Stream handles retain unconsumed traces without limit | Performance: slow or stalled stream consumers retain chunks | M | Medium | `src/agent-run.ts:88–97,141–150,216–225`; source, high |
| 21 | CI omits existing docs/declaration gates | Tooling: published API/docs can regress while CI passes | S | Low | `.github/workflows/ci.yml:29–46`, `package.json` scripts; source, high |
| 22 | JSON construction overstates validation | Docs/validation: lowering mistaken for schema validation | S–M | Low–medium | `src/workflow-config.ts:9–12,943–1001`, `src/validate/index.ts:54`; source, high |
| 23 | Example adapters silently lose supported conversation parts | Portability: examples do not establish full parity | M–L | Medium | `examples/anthropic-sdk-host/index.ts:91–125`; source, high for loss |

### 01. Cancelled decisions

Reproduction: enter `choosing`, send `CANCEL`, verify the executor signal is aborted, then resolve the old decision with `GO`. If the new state also accepts `GO`, the stale invoke transitions it anyway. Checking whether the current snapshot accepts an event is insufficient: the request no longer owns permission to deliver it.

Check cancellation after executor resolution and immediately before delivery. Characterize late transcript/chunk delivery too. Regression gates: cancellation, same-state reentry, and parallel completion with an executor deliberately ignoring `AbortSignal`. Do not require every framework SDK to implement cancellation correctly for machine correctness.

### 02. Tool argument validation

The OpenAI adapter sends a JSON schema to the model, then calls `execute(input)` on parsed JSON without applying the tool schema. A tool declaring `{amount:number}` was invoked with `{amount:"bad"}`. Advertising a schema is not validation. Defaults/transforms are also bypassed; the declared second execution-context argument is not supplied.

Validate the supported Standard Schema contract before invoking a tool; return validation failure to the model without running the effect. Specify behavior for native SDK schema forms and tool execution context. Test invalid arguments, defaults, transforms, unknown tools, cancellation, and tool-call identity. Tool availability remains machine/host policy.

### 03. Reachability semantics

The explorer fabricates `{type}` for every event. A declared `GO:{n:number}` guarded by `event.n > 0` is therefore pruned; `canReach(machine,"done")` returned false, while a real actor reached done after `GO(n=1)`. Separately, `canReach` discards depth/path-cap and incomplete-coverage information. Its documentation calls a false result a safety proof.

Return a witness or explicit uncertainty, including coverage limits. Add validated event samples or a deterministic event provider. Required unsampled payloads must remain unexplored. Even complete traversal over finite samples is a claim about that supplied domain, not all possible model outputs. Only use “unreachable” when an exhaustive domain is justified. Test payload guards, transforms, missing request outputs, caps, and wildcard transitions.

### 04. Journal settlement

An initially-final machine with a store whose `append` always rejects returned `status:"done"` and one reported event. `settle` freezes the outcome before the queued write resolves; the rejection handler then ignores errors because settlement already occurred.

Separate actor quiescence from durable completion. Construct the authoritative result and `run.end` after the write barrier can report failure. Cover rejected initial, idle, and terminal entries, conflicts, cancellation, and ordering of subsequent effect starts.

### 05. Child schemas

Child decision requests share root run accounting but also root schema lookup. A child `GO` event requiring numeric `amount` advertised no schema and accepted a string. Native `provideExecutors` already has a per-machine schema-context path; controlled execution omits it.

Keep accounting/trace lineage shared while deriving event schemas from each invoking machine. Test conflicting parent/child event names, grandchildren, and equality between `runAgent` and native actor hosts.

### 06. Void actor completion

A child machine without output emits a normal completion containing `output:undefined`. Strict JSON journaling rejects that field, and the exception escapes the inspection callback rather than settling the runner. This is a native XState composition case, not invalid model output.

Define encoding/decoding for library-generated void completions and keep unsupported application payload failures inside the result channel. Test void child machines, async actors, JSON restoration/replay, and observer error handling. The new compensation example uses an explicit acknowledgement object; it does not fix this core defect.

### 07. Nested durability

Reproduction: a child completes request `a`, starts pending `b`, then the root is aborted. The returned log contains only `@agent.init`. Events-only recovery executes `a` again. Local invocation IDs also lack complete actor lineage for repeated/parallel child instances; collision behavior needs further characterization.

Choose actor-addressed journaling/replay or explicit durable child boundaries. Document current root-only coverage until then. A new actor-tree journal needs format/version design before implementation. Verify crashes after each nested completion, sibling interleaving, repeated children, and idempotency keys. Snapshot continuation and event-only replay are separate contracts.

### 08. Error replay

Throwing `Object.assign(new Error("retry"),{code:"RETRY"})` selects the live retry branch. The journal stores only name/message/cause; replay loses `code` and diverges. Disabling verification permits a different branch silently.

Define a durable error codec preserving supported serializable discriminants. Consider normalizing before live delivery so live/replay see the same shape. Prototype checks cannot be promised across JSON. Cover status/code/retryable fields, nested causes, and unsupported fields explicitly.

### 09. Bound decision ownership

`runAgent` accepts a prebound decision at its bindability check, then unconditionally replaces it. Without a host `decide` it fails; with one it silently substitutes the host implementation. Text logic, child decisions, and native binding preserve existing executors.

Apply the same ownership check consistently. Test a matrix of top-level/child, text/decision, bound/unbound, and both host modes. Avoid adding a second binding API to solve this.

### 10–11. Preset identity and duplicate names

All seven presets hard-code version `1`, while their topology comes from caller config. Two routers with different route sets have the same default ID/version. Prefer structural versioning by default, with explicit application version overrides where necessary; explain migration of existing saved runs.

Sequential steps are assigned into an object by name without duplicate detection. Two `draft` steps collapse to the second one. Reject duplicates before lowering. Cover nonadjacent duplicates and names reserved by the factory. These fixes should precede any broader preset redesign.

### 12–13. Cross-run telemetry and instruction mapping

OTel has per-run root spans but a global map keyed only by request ID. Interleaved runs A/B using `draft` caused A's completion usage to appear on B's span, while B's own usage disappeared. Use run identity plus request identity, and include actor lineage if request IDs are not globally unique within a run. Test retries without collapsing sibling requests.

`toOpenAiMessages` returns early for message history and omits `request.system`. Its prompt branch preserves that field. Define instruction ordering when history already contains system messages and test generation, streaming, and decisions. This is separate from the intentionally incomplete Anthropic example mapper.

### 14–16. Typed composition

Expand wildcard handlers against the finite declared event vocabulary instead of returning no candidates for `*`. Cover namespace patterns, parent/child shadowing, reserved events, and UI interaction filtering. Without a declared finite vocabulary, report that enumeration is incomplete.

Named `setupAgent` actions are typed through `AnySetupConfig["actions"]`; a schema `{count:number}` still allowed `context.nonexistent.deep()` in a compiler probe. Carry concrete action-map generics and schema-derived context/events through setup; retain native XState parameterized action behavior. Add negative declaration tests.

`InputOf<typeof machine>` uses native validated input, while `AgentInputFrom` recovers schema caller input. With a defaulted count, `{}` is accepted by the latter and rejected by the former. Pick one caller-facing input helper or name the distinction explicitly. Object-only branding also deserves investigation for primitive transforms and `.provide()` preservation. Avoid broad `any` fixes.

### 17–20. Small host contracts with large downstream effects

`runAgentLoop` promises persistence at every pause but returns before `persist` when `onIdle` is absent or the turn cap is reached. Persist every idle result before deciding whether to continue. Test persist-only usage, zero turns, and cap exhaustion.

`runSeam` defines the boundary using the first completion/error from any actor after candidate start. In parallel machines that can be a sibling. Capture the candidate's invocation identity and align event/state slices to its actual completion. Add both completion orders and candidate failure; historical eval comparisons can change.

`executeAgentRequest` accepts a broad request/effect but is text-only and does not expose the lower-level execution-info argument. Forward optional signal/chunk/run/request/call-key metadata. Consider `executeTextRequest` as the accurate name; migrate rather than maintain multiple equivalent implementations.

`runAgentStream` wraps an internal `createAgentRun` queue without a size limit. Once iteration starts, a slow or stalled consumer can retain every subsequent chunk. The internal result-only handle is not exported at the package root, so result-only retention is not reported as a public API problem. Unbounded buffering is documented internally; it needs an explicit policy for long-lived streaming. Use a head-index queue and define buffering/overflow/discard policy. Preserve intentional nonblocking execution. Benchmark after selecting the policy; no measured speedup is claimed here.

### 21–23. Release and integration evidence

CI omits existing `docs:check` and `check:dts`; run both after build. Pin pnpm to the package-manager version rather than installing latest. Preserve supported export-nameability fixtures: shipping declarations is a separate contract from source typechecking.

JSON workflow construction compiles schemas and lowers config but does not call the optional published-schema validator. Its header implies full validation. Document `validateAgentConfig` → construction → lint/simulation, or offer one optional validated construction path. Successful construction alone is not proof of the published schema contract.

The Anthropic example documents text-only simplifications, yet retains tool results after dropping assistant tool calls, and drops system-role history. This is an acknowledged limitation, not a newly discovered vulnerability. Make unsupported input fail explicitly or complete the mapper. A shared conformance fixture should cover message/tool pairs, system instructions, structured output, decisions, cancellation, chunks, usage, and errors. Publish supported capabilities per adapter rather than inferring universal parity from one triage run.

## API simplification and removal decisions

These are design options, not bugs ranked against correctness work.

### A. Keep one portable request/result contract

`src/text-logic.ts:846–895` widens messages/tools/toolChoice to `any` specifically to accept raw AI SDK functions, and admits SDK-shaped results into core. Move those compatibility shapes to `/ai-sdk`. Let adapters convert to one canonical typed result envelope. Preserve framework-native messages through an explicit generic boundary rather than pretending every framework shares one message shape.

Keep `setupAgent`, text/decision intent, native binding, `runAgent`, and event validation as primary entrypoints. Keep `runAgentLoop` and the single stream facade as optional conveniences. Removing raw-function compatibility is breaking: publish a one-line adapter migration first. Effort L; risk high; evidence high, product judgment required.

### B. Prefer explicit host binding and native XState semantics

`defineModels` claims to be an unchanged identity helper (`src/ai-sdk/index.ts:63–69`) but clones and attaches a hidden non-enumerable executor factory (`83–86`). Spreading the map loses execution behavior. Retain its useful declaration-nameability typing, but remove hidden runtime binding or rename/document it as binding.

`setupAgent` recursively promotes a sole final-node output to root output (`src/setup-agent.ts:871–894`), including nested finals. Remove or narrowly deprecate that semantic rewrite; use explicit native output composition. Adding an unrelated final should not silently alter root output behavior. Effort M; risk medium; characterize existing examples first.

### C. Move convenience/testing surfaces out of the primary API

The root exports log internals, store conformance, seams, trajectory matching, and scripted executors (`src/index.ts:103–138,168–208`). Consider `/testing` and `/persistence` entrypoints. Retain verification because it is central to the product, but distinguish structural checks, bounded exploration, and runtime schema validation.

Delete the unused `expect?:unknown` conformance-harness parameter (`src/event-log-store-conformance.ts:18–24`). Review low-level exports such as `rebindActorSession`, `initEntry`, `createReplayEntry`, and `agentCallOccurrence`: internalize only after checking external consumers, otherwise move them. Do not delete userland store support merely because the host owns storage. Effort M; risk medium; migration required.

### D. Make presets earn their place

Preset composition loses literal states/tags/source maps (`src/machines/internal.ts:22–41`), allows child input as `unknown` (`143–148`), and returns parallel results as `Record<string,unknown>` (`parallel.ts:23–33`). Either infer child inputs, named result keys, and output schemas, or move most factories into copyable examples. Native XState already expresses sequence, parallel regions, handoff, and supervision.

Prefer fewer factories over adding framework-specific agent classes or another builder DSL. Keep a factory only if it removes meaningful repetition without hiding topology or discarding types. Effort L; risk medium–high; validate with real authoring tasks before deletion.

## Suggested execution order

1. Characterization/regression tests for 01–06, 08–09, 12–13. Fix local correctness boundaries first.
2. Repair reachability's evidence contract (03/14) before strengthening validation claims or generated-machine automation.
3. Decide nested durability/error identity (07/08/10) before expanding replay/time-travel examples.
4. Tighten typed actions, caller input, and executor envelopes (15/16/A). Add public declaration fixtures alongside changes.
5. Add adapter conformance and release gates (21/23), then simplify entrypoints, hidden binding, and presets (B–D).

Each work item should include focused regressions, relevant docs, and a changeset where user-visible. Common gates: `pnpm vitest run`, `pnpm check`, `pnpm docs:check`, `pnpm check:dts` after build, and `pnpm test:cloudflare` for workspace host coverage. Production/live behavior remains a separate check.

## Example additions and research

Implemented, with no new dependencies:

- **Reviewer quorum:** parallel independent votes, two-of-three policy, malformed-output abstention, human escalation, native-host parity. Based on [Anthropic voting](https://www.anthropic.com/engineering/building-effective-agents).
- **Booking compensation:** model itinerary, human gate, reservations, confirmed failure compensation, uncertain outcome/manual recovery. Based on [Microsoft compensating transactions](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction).
- **Approval deadline:** correlated scheduler event, strict deadline boundary, snapshot restoration, stale-event rejection. Original statechart extension compared with [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts). Scheduling/storage serialization remain host-owned.

See `docs/statechart-policy-examples.md` for executable commands and limitations. These examples validate concrete behavior and expose source machines; no browser-rendered visualization or live provider parity is claimed.

Further example opportunities, not implemented in this branch:

- **Counterfactual checkpoint fork:** compare alternate decisions from one immutable prefix, preserve original, compare trajectories. A direct counterpart to [LangGraph time travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel). First resolve the error/nested replay findings.
- **Speculative response with publication gate:** generate a response and review input concurrently; emit/publish nothing until the independent gate approves. Distinct from majority voting and sequential guardrails.
- **Interruptible assistant:** user correction exits an in-flight model state, cancels its work, and prevents all late messages/results from affecting the new request. Add after fixing 01, including a deliberately uncooperative executor.

[LangGraph's workflow catalog](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) covers many patterns already represented here. Existing deep-research already dynamically spawns workers; reflection, corrective RAG, plan/execute, hierarchical teams, and basic HITL should not be duplicated merely to increase example count.

## Considered and rejected

- A new universal storage/auth/session/framework layer: contrary to host ownership; strengthen the seam and conformance instead.
- Declaring every `any` a bug: some are intentional erased heterogeneous actor boundaries. Prioritize user-visible inference holes and contain casts internally.
- Removing all native message support: would force lossy translation and weaken framework portability.
- Treating documented unbounded streaming as a surprise bug: it is a design/performance tradeoff needing an explicit policy.
- Treating the limited Anthropic example mapper as an undocumented security flaw: its header declares limitations; the actionable gap is interoperability evidence and loss handling.
- Claiming static lint or bounded samples prove agent safety: neither establishes correctness over arbitrary inputs or external effects.
- Automatically rewriting core APIs during an audit: findings remain reviewable recommendations; this branch implements only the requested examples/docs.

## Verification of this branch

- Root/core/example suite: 970 tests passed (79 files).
- Cloudflare host suites: 18 tests passed.
- New demo-discovery suite: 3 tests passed; confirms source/input-schema handoff, not browser rendering.
- `pnpm check`: passed source/examples/workspace-package typechecks, build, lint (existing warnings), formatting, and Knip.
- `pnpm docs:check`: 60 snippets checked, 111 existing snippets skipped, zero failures.
- `pnpm check:dts`: passed against built declarations.
- All three example CLIs completed offline with expected outcomes.
