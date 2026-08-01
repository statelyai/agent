/**
 * The browser half of the human-in-the-loop flow. Plain unstyled HTML on
 * purpose — the point is the two calls:
 *
 *   startAgent({ data: { topic } })          → { id, status: 'idle', draft, prompt, acceptedEvents }
 *   resumeAgent({ data: { id, event } })     → { status: 'done', output }
 *
 * Both are the server functions from `../../index.ts`. Importing them here does
 * NOT pull `runAgent` into the client bundle: Start splits each handler out and
 * leaves an RPC stub behind, so the machine only ever runs on the server.
 *
 * The run id is the whole client-side state; everything else lives in the
 * snapshot the server function persisted.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { resumeAgent, startAgent } from "../../index";

export const Route = createFileRoute("/")({ component: Announcer });

type Result = {
  id?: string;
  status: string;
  draft?: string | null;
  prompt?: string;
  acceptedEvents?: string[];
  output?: { published: boolean; draft: string };
};

function Announcer() {
  const [topic, setTopic] = useState("the new deploy pipeline");
  const [reason, setReason] = useState("Too vague — name the speedup.");
  const [runId, setRunId] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** One place to fold a response: a still-idle run keeps its id, a finished one clears it. */
  const run = async (call: () => Promise<Result>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await call();
      setResult(response);
      setRunId(response.status === "idle" ? (response.id ?? runId) : null);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(() => startAgent({ data: { topic } }));
  const resume = (event: { type: "APPROVE" } | { type: "REJECT"; reason: string }) =>
    run(() => resumeAgent({ data: { id: runId ?? "", event } }));

  const awaitingReview = result?.status === "idle" && runId !== null;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "2rem auto" }}>
      <h1>TanStack Start host</h1>
      <p>Draft an announcement, then approve or reject it.</p>

      <section>
        <label htmlFor="topic">Topic</label>{" "}
        <input
          id="topic"
          name="topic"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
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
            onChange={(event) => setReason(event.target.value)}
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
          {error}
        </p>
      )}

      <h2>Response</h2>
      <pre id="state-json" aria-label="Last response" style={{ whiteSpace: "pre-wrap" }}>
        {busy ? "…" : JSON.stringify(result, null, 2)}
      </pre>
    </main>
  );
}
