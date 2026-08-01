/**
 * The client half: a `useChat` component pointed at the `/api/chat` route in
 * ./index.ts. Nothing here knows it is talking to a state machine — it is the
 * stock TanStack AI chat setup, and the machine's steps arrive as ordinary
 * AG-UI events.
 *
 * Two things worth noting:
 *   - `connection: fetchServerSentEvents('/api/chat')` is the whole transport
 *     config. It POSTs the conversation and reads the SSE stream the route's
 *     `toServerSentEventsResponse` produced.
 *   - `onChunk` sees raw wire events, so `STEP_STARTED` / `STEP_FINISHED` — the
 *     machine's states — can drive a live progress line next to the tokens.
 *     Text itself needs no handling: it lands in `messages` automatically.
 *
 * `useChat`, `fetchServerSentEvents` and `UIMessage` are the real
 * `@tanstack/ai-react` exports. Not mounted here (no react-dom dependency) —
 * this is the component you'd render at a route.
 */
import { useState } from "react";
import { fetchServerSentEvents, useChat, type UIMessage } from "@tanstack/ai-react";
import { EventType, type StreamChunk } from "@tanstack/ai";

export interface AgentChatProps {
  /** The route from ./index.ts. Overridable so a dev server can host it elsewhere. */
  api?: string;
}

/**
 * Flattens a message's text parts. TanStack AI publishes no helper for this —
 * content lives entirely in `parts`, and text parts carry `content`, not `text`.
 */
function messageText(message: UIMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");
}

export function AgentChat({ api = "/api/chat" }: AgentChatProps) {
  const [input, setInput] = useState("");
  // The machine state currently producing tokens, from the step events.
  const [step, setStep] = useState<string | null>(null);

  const { messages, sendMessage, isLoading, error } = useChat({
    connection: fetchServerSentEvents(api),
    onChunk: (chunk: StreamChunk) => {
      if (chunk.type === EventType.STEP_STARTED) {
        setStep(chunk.stepName);
      } else if (chunk.type === EventType.RUN_FINISHED || chunk.type === EventType.RUN_ERROR) {
        setStep(null);
      }
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const question = input.trim();
    if (question === "" || isLoading) return;
    setInput("");
    void sendMessage(question);
  };

  return (
    <section>
      <h2>Ask the agent</h2>

      <ol>
        {messages.map((message: UIMessage) => (
          <li key={message.id}>
            <strong>{message.role === "assistant" ? "Agent" : "You"}: </strong>
            {messageText(message)}
          </li>
        ))}
      </ol>

      {/* One assistant message per machine step, so the label names the state
          the current tokens are coming from. */}
      {isLoading && <p aria-live="polite">{step ? `Running: ${step}…` : "Thinking…"}</p>}
      {error && <p role="alert">{error.message}</p>}

      <form onSubmit={submit}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Why state machines for agents?"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || input.trim() === ""}>
          Send
        </button>
      </form>
    </section>
  );
}
