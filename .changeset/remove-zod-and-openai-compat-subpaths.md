---
"@statelyai/agent": minor
---

**Breaking: removed the `@statelyai/agent/zod` and `@statelyai/agent/openai-compat` subpaths.**

- **`./zod`.** `zodAgentMessages()` is gone — a one-line convenience over `z.custom`, not worth a public entry point. Declare the field inline instead:

  ```ts
  import { z } from "zod";
  import type { AgentMessage } from "@statelyai/agent";

  const context = z.object({
    messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
  });
  ```

  With the subpath gone, `zod` is no longer a peer dependency of the package.

- **`./openai-compat`.** `createOpenAiCompatExecutors` and its mappers are gone. The executor contract is three plain functions — write them against whatever client you use. `examples/openai-sdk-host` shows the hand-rolled version against the official `openai` package; `@statelyai/agent/ai-sdk` remains the supported batteries-included adapter.
