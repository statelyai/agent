/**
 * What both email drafters share: the draft shape and the one rule that must
 * hold before anything is sent. v1 and v2 differ in WHERE they enforce it,
 * not in what it is.
 */
import { z } from "zod";

export const emailDraftSchema = z.object({
  /** An email address, or `""` when the request never named one. */
  to: z.string(),
  subject: z.string(),
  body: z.string(),
});

export type EmailDraft = z.infer<typeof emailDraftSchema>;

/** The send rule: a single well-formed address to send to. */
export function hasRecipient(draft: EmailDraft | null): draft is EmailDraft {
  return draft !== null && z.email().safeParse(draft.to.trim()).success;
}

/** A subject line the human actually wrote or approved. */
export function hasSubject(draft: EmailDraft | null): draft is EmailDraft {
  return draft !== null && draft.subject.trim().length > 0;
}
