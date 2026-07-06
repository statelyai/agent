/**
 * Keyless heuristics ported from the original `ai-xstate-email-example`'s
 * `ai.ts`: without OPENAI_API_KEY (or when the AI call fails), the example
 * still works by extracting recipient/subject/body signals from the prompt.
 */

export type EmailDraft = {
  to: string;
  subject: string;
  body: string;
};

export type PromptAssessment = {
  satisfied: boolean;
  missing: string[];
  questions: string[];
};

export function assessPromptFallback(prompt: string): PromptAssessment {
  const missing: string[] = [];
  const questions: string[] = [];

  if (!extractRecipient(prompt)) {
    missing.push('to');
    questions.push('Who should receive it?');
  }
  if (!extractSubject(prompt)) {
    missing.push('subject');
    questions.push('What subject or purpose should it have?');
  }
  if (!hasBodyDetails(prompt)) {
    missing.push('body details');
    questions.push('What key points should the body include?');
  }

  return { satisfied: missing.length === 0, missing, questions };
}

export function draftEmailFallback(prompt: string): EmailDraft {
  const to = extractRecipient(prompt) ?? 'recipient@example.com';
  const subject = extractSubject(prompt) ?? 'Following up';
  const bodyDetails = prompt
    .replace(/\s+/g, ' ')
    .replace(/\b(to|subject|about|regarding)\b/gi, '')
    .trim();

  return {
    to,
    subject,
    body: [
      'Hi,',
      '',
      bodyDetails
        ? `I wanted to reach out about ${bodyDetails}.`
        : 'I wanted to reach out with a quick update.',
      '',
      'Please let me know what you think.',
      '',
      'Best,',
    ].join('\n'),
  };
}

function extractRecipient(prompt: string): string | undefined {
  return prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function extractSubject(prompt: string): string | undefined {
  const match = prompt.match(/\bsubject\s*[:=-]\s*([^.;\n]+)/i);
  if (match?.[1]) {
    return titleCase(match[1].trim());
  }

  const about = prompt.match(/\b(?:about|regarding)\s+([^.;\n]+)/i);
  return about?.[1] ? titleCase(about[1].trim()) : undefined;
}

function hasBodyDetails(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).filter(Boolean);
  return (
    words.length >= 14 ||
    /because|include|mention|tell|ask|thanks|deadline|meeting/i.test(prompt)
  );
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
