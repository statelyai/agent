---
"@statelyai/agent": patch
---

**`createOpenAiExecutors` works with reasoning models such as `gpt-6-luna`.** These models reject function tools on Chat Completions (`400 Function tools with reasoning_effort are not supported`), so calls that carry function tools now go through the Responses API:

- `decide` always uses `client.responses.create`, with `tool_choice: 'required'` and one function tool per candidate event.
- `generateText` with tools runs its tool loop over the Responses API. Tool-free `generateText` and `streamText` stay on Chat Completions, unchanged.
- Responses calls send `store: false`, matching Chat Completions. A host can still set `store: true`.
- Host `settings` keep their Chat Completions names. On Responses calls, `reasoning_effort`, `max_completion_tokens`, and `verbosity` become `reasoning.effort`, `max_output_tokens`, and `text.verbosity`. Settings the Responses API shares by name pass through. Chat-only settings such as `seed`, `stop`, `logprobs`, and `prediction` are dropped.
- An incomplete Responses turn never runs its function calls, and an incomplete `decide` throws instead of choosing an event.
- For these calls, `raw` is the Responses API `Response`.
- A host that wraps the client must now forward `responses.create` as well as `chat.completions.create`. An OpenAI-compatible server without `/v1/responses` can no longer run tool calls through this adapter.
