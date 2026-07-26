import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SchemaForm } from "@/components/ui/schema-form";
import type { AcceptedEvent, ChatIdle } from "@/lib/machine-ui";

type EventActionsProps = {
  idle: ChatIdle;
  onSendEvent: (event: { type: string; [key: string]: unknown }) => void;
};

function buttonVariant(style: AcceptedEvent["style"]): "primary" | "secondary" {
  return style === "primary" ? "primary" : "secondary";
}

/**
 * The generic human-in-the-loop card: one button per accepted event. Events
 * whose payload schema declares fields open a schema-generated dialog; the
 * rest send immediately. Labels and emphasis come from the machine's
 * `meta.interaction` hints when present.
 */
export function EventActions({ idle, onSendEvent }: EventActionsProps) {
  const [openEvent, setOpenEvent] = useState<AcceptedEvent | null>(null);

  if (idle.events.length === 0) return null;

  return (
    <div className="approval-card" role="group" aria-label="Machine is waiting for input">
      <div className="approval-card__ribbon">
        <UserRound size={13} aria-hidden="true" />
        Waiting for your input
      </div>
      <div className="approval-card__body">
        <p>{idle.prompt ?? "The machine is idle. Choose an event to continue."}</p>
        <div className="approval-card__actions">
          {idle.events.map((event) => (
            <Button
              key={event.type}
              variant={buttonVariant(event.style)}
              size="sm"
              data-style={event.style === "danger" ? "danger" : undefined}
              onClick={() =>
                event.needsPayload ? setOpenEvent(event) : onSendEvent({ type: event.type })
              }
            >
              {event.label}
              {event.needsPayload ? "…" : ""}
            </Button>
          ))}
        </div>
        {idle.textEvent ? (
          <p className="approval-card__text-hint">
            Or type a message — it is sent as <code>{idle.textEvent.type}</code>.
          </p>
        ) : null}
      </div>

      <Dialog.Root open={openEvent !== null} onOpenChange={(open) => !open && setOpenEvent(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="dialog-backdrop" />
          <Dialog.Popup className="dialog-popup">
            {openEvent ? (
              <>
                <Dialog.Title className="dialog-title">{openEvent.label}</Dialog.Title>
                <Dialog.Description className="dialog-description">
                  Payload for <code>{openEvent.type}</code>, generated from the machine's event
                  schema.
                </Dialog.Description>
                <SchemaForm
                  schema={openEvent.jsonSchema ?? { type: "object" }}
                  submitLabel={`Send ${openEvent.type}`}
                  onCancel={() => setOpenEvent(null)}
                  onSubmit={(values) => {
                    setOpenEvent(null);
                    onSendEvent({ type: openEvent.type, ...values });
                  }}
                />
              </>
            ) : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
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
    <div className="approval-card" role="group" aria-label="Machine input">
      <div className="approval-card__ribbon">
        <UserRound size={13} aria-hidden="true" />
        Machine input
      </div>
      <div className="approval-card__body">
        <p>This machine takes structured input, generated from its input schema.</p>
        <SchemaForm schema={schema as never} submitLabel="Start run" onSubmit={onStart} />
      </div>
    </div>
  );
}
