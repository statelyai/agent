/**
 * The browser half of the human-in-the-loop flow. Plain unstyled HTML on
 * purpose — the point is the two fetches:
 *
 *   POST /api/agent                → { id, status: 'idle', draft, prompt, acceptedEvents }
 *   POST /api/agent/<id>/resume    → { status: 'done', output } (or 'idle' again after REJECT)
 *
 * The run id is the whole client-side state. Everything else lives in the
 * snapshot the route handler persisted.
 *
 * UI state lives in an `@xstate/store` store; the two POSTs are React Query
 * mutations (so pending/error state comes from the query client, not `useState`).
 */
"use client";

import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { createStore } from "@xstate/store";
import { useSelector } from "@xstate/store-react";

type StartResponse = {
  id?: string;
  status: string;
  draft?: string | null;
  prompt?: string;
  acceptedEvents?: string[];
  output?: { published: boolean; draft: string };
};

const store = createStore({
  context: {
    topic: "the new deploy pipeline",
    reason: "Too vague — name the speedup.",
    runId: null as string | null,
    result: null as StartResponse | null,
  },
  on: {
    topicChanged: (context, event: { topic: string }) => ({ ...context, topic: event.topic }),
    reasonChanged: (context, event: { reason: string }) => ({ ...context, reason: event.reason }),
    // One transition for both endpoints: a still-idle run keeps its id, a finished one clears it.
    responded: (context, event: { response: StartResponse }) => ({
      ...context,
      result: event.response,
      runId: event.response.status === "idle" ? (event.response.id ?? context.runId) : null,
    }),
  },
});

const queryClient = new QueryClient();

export default function Page() {
  return (
    <QueryClientProvider client={queryClient}>
      <Announcer />
    </QueryClientProvider>
  );
}

function Announcer() {
  const topic = useSelector(store, (state) => state.context.topic);
  const reason = useSelector(store, (state) => state.context.reason);
  const runId = useSelector(store, (state) => state.context.runId);
  const result = useSelector(store, (state) => state.context.result);

  const post = useMutation({
    mutationFn: async ({ url, body }: { url: string; body: unknown }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await response.json()) as StartResponse;
    },
    onSuccess: (response) => store.trigger.responded({ response }),
  });

  const busy = post.isPending;
  const error = post.error;
  const awaitingReview = result?.status === "idle" && runId !== null;

  const start = () => post.mutate({ url: "/api/agent", body: { topic } });
  const resume = (event: unknown) =>
    post.mutate({ url: `/api/agent/${runId}/resume`, body: { event } });

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 640,
        margin: "2rem auto",
      }}
    >
      <h1>Next.js host</h1>
      <p>Draft an announcement, then approve or reject it.</p>

      <section>
        <label htmlFor="topic">Topic</label>{" "}
        <input
          id="topic"
          name="topic"
          value={topic}
          onChange={(event) => store.trigger.topicChanged({ topic: event.target.value })}
          disabled={busy}
          size={40}
        />{" "}
        <button id="start" type="button" onClick={start} disabled={busy}>
          Start
        </button>
      </section>

      {awaitingReview && (
        <section>
          <h2>Review</h2>
          <p id="prompt">{result?.prompt}</p>
          <blockquote id="draft">{result?.draft}</blockquote>
          <button
            id="approve"
            type="button"
            onClick={() => resume({ type: "APPROVE" })}
            disabled={busy}
          >
            Approve
          </button>{" "}
          <label htmlFor="reason">Reason</label>{" "}
          <input
            id="reason"
            name="reason"
            value={reason}
            onChange={(event) => store.trigger.reasonChanged({ reason: event.target.value })}
            disabled={busy}
            size={32}
          />{" "}
          <button
            id="reject"
            type="button"
            onClick={() => resume({ type: "REJECT", reason })}
            disabled={busy}
          >
            Reject
          </button>
        </section>
      )}

      {result?.status === "done" && (
        <section>
          <h2>Published</h2>
          <blockquote id="published">{result.output?.draft}</blockquote>
        </section>
      )}

      {error && (
        <p id="error" role="alert">
          {error.message}
        </p>
      )}

      <h2>Response</h2>
      <pre id="state-json" aria-label="Last response" style={{ whiteSpace: "pre-wrap" }}>
        {busy ? "…" : JSON.stringify(result, null, 2)}
      </pre>
    </main>
  );
}
