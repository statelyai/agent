import { useEffect, useState } from "react";
import { SchemaForm } from "@/components/ui/schema-form";
import { schemaFields, type AcceptedEvent, type ChatIdle, type SchemaField } from "@/lib/machine-ui";

type EventActionsProps = {
  idle: ChatIdle;
  onSendEvent: (event: { type: string; [key: string]: unknown }) => void;
};

/** The event's single field, when its payload schema is exactly one field. */
function singleField(event: AcceptedEvent): SchemaField | null {
  const fields = event.jsonSchema ? schemaFields(event.jsonSchema) : null;
  return fields && fields.length === 1 ? fields[0] : null;
}

/**
 * The human-in-the-loop controls, rendered inside the composer: one button per
 * accepted event, an inline schema-generated form for events that need a
 * payload, and optional custom renderers declared by the state's
 * `meta.interaction.component`.
 */
export function EventActions({ idle, onSendEvent }: EventActionsProps) {
  const [openType, setOpenType] = useState<string | null>(null);

  // A new idle state means new accepted events — drop any open payload form.
  useEffect(() => {
    setOpenType(null);
  }, [idle]);

  if (idle.events.length === 0) return null;

  const openEvent = idle.events.find((event) => event.type === openType) ?? null;
  const only = idle.events.length === 1 ? idle.events[0] : null;
  const field = only ? singleField(only) : null;

  // Custom renderers replace the button row when the state declares one and
  // the accepted-event shape fits (single event, single field).
  if (idle.component && only) {
    if (idle.component === "rating" && field?.kind.type === "number") {
      return (
        <RatingControl
          title={idle.prompt ?? "Rate this resolution"}
          onPick={(value) => onSendEvent({ type: only.type, [field.name]: value })}
        />
      );
    }
    if (idle.component === "cards" && (field?.kind.type === "string" || field?.kind.type === "enum")) {
      return (
        <CardsControl
          title={idle.prompt ?? "Your hand: pick a rank to ask for"}
          ranks={rankOptions(only)}
          onPick={(rank) => onSendEvent({ type: only.type, [field.name]: rank })}
        />
      );
    }
    return (
      <div className="chat-form-card">
        <p className="chat-form-card__note">
          Unknown renderer &quot;{idle.component}&quot;. Using the schema form instead.
        </p>
        <SchemaForm
          schema={only.jsonSchema ?? { type: "object" }}
          submitLabel={only.label}
          onSubmit={(values) => onSendEvent({ type: only.type, ...values })}
        />
      </div>
    );
  }

  return (
    <div className="chat-actions" role="group" aria-label="Machine is waiting for input">
      <div className="chat-actions__row">
        {idle.events.map((event) => (
          <button
            key={event.type}
            className="chat-action"
            data-kind={event.style}
            data-open={event.type === openType || undefined}
            onClick={() =>
              event.needsPayload
                ? setOpenType(event.type === openType ? null : event.type)
                : onSendEvent({ type: event.type })
            }
          >
            {event.label}
            {event.needsPayload ? "…" : ""}
          </button>
        ))}
      </div>

      {openEvent ? (
        <div className="chat-form-card">
          <p className="chat-form-card__title">
            Payload for <code>{openEvent.type}</code>
          </p>
          <SchemaForm
            schema={openEvent.jsonSchema ?? { type: "object" }}
            submitLabel={`Send ${openEvent.type}`}
            onCancel={() => setOpenType(null)}
            onSubmit={(values) => {
              setOpenType(null);
              onSendEvent({ type: openEvent.type, ...values });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

// ─── custom renderers ───

function RatingControl({ title, onPick }: { title: string; onPick: (value: number) => void }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="chat-form-card chat-rating">
      <span className="chat-form-card__title">{title}</span>
      <div className="chat-rating__stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            className="chat-rating__star"
            data-on={value <= hover || undefined}
            aria-label={`${value} out of 5`}
            onMouseEnter={() => setHover(value)}
            onFocus={() => setHover(value)}
            onClick={() => onPick(value)}
          >
            ★
          </button>
        ))}
      </div>
    </div>
  );
}

const DEFAULT_RANKS = ["A", "K", "Q", "J", "10"];
const SUITS = ["♠", "♥", "♦", "♣"];

/** Ranks offered by the event's single string field (its enum), else a default hand. */
function rankOptions(event: AcceptedEvent): string[] {
  const field = singleField(event);
  if (field && field.kind.type === "enum") return field.kind.options.slice(0, 8);
  return DEFAULT_RANKS;
}

function CardsControl({
  title,
  ranks,
  onPick,
}: {
  title: string;
  ranks: string[];
  onPick: (rank: string) => void;
}) {
  const hand = ranks.length ? ranks : DEFAULT_RANKS;
  return (
    <div className="chat-form-card chat-hand">
      <span className="chat-form-card__title">{title}</span>
      <div className="chat-hand__cards">
        {hand.map((rank, index) => {
          const suit = SUITS[index % SUITS.length];
          const offset = index - (hand.length - 1) / 2;
          return (
            <button
              key={rank}
              className="chat-hand__card"
              data-red={suit === "♥" || suit === "♦" || undefined}
              style={{
                transform: `rotate(${offset * 3}deg) translateY(${Math.abs(offset) * 2.2}px)`,
              }}
              onClick={() => onPick(rank)}
            >
              <span>{rank}</span>
              <span>{suit}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type StartFormCardProps = {
  /** JSON Schema of the machine's `input` (multi-field: no chat mapping). */
  schema: { [key: string]: unknown };
  onStart: (values: Record<string, unknown>) => void;
};

/** Start card for machines whose input is structured rather than a single prompt. */
export function StartFormCard({ schema, onStart }: StartFormCardProps) {
  return (
    <div className="chat-form-card" role="group" aria-label="Machine input">
      <span className="chat-form-card__title">Machine input</span>
      <SchemaForm schema={schema as never} submitLabel="Start run" onSubmit={onStart} />
    </div>
  );
}
