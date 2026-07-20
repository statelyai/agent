/**
 * Shared keyword-retrieval machinery for the RAG examples (`rag`,
 * `corrective-rag`). Honest keyword-overlap scoring — NOT embeddings, NOT a
 * vector store. Each example keeps its OWN `SAMPLE_CORPUS` (different domains);
 * only the scoring/search functions are shared here.
 */

/** Content-word stop list. Superset used by both RAG examples. */
export const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "of",
  "to",
  "in",
  "and",
  "what",
  "how",
  "why",
  "do",
  "does",
  "can",
  "i",
  "me",
  "my",
  "it",
  "that",
  "this",
  "for",
  "with",
  "about",
  "tell",
  "explain",
  "please",
]);

/** Honest keyword-overlap scoring — NOT embeddings. Counts shared content words. */
export function scoreDocument(question: string, text: string): number {
  const terms = new Set(
    question
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/** Top-N keyword matches over a corpus (score > 0), highest first. */
export function searchCorpus(
  corpus: Array<{ id: string; text: string }>,
  question: string,
  limit: number,
): string[] {
  return corpus
    .map((doc) => ({ text: doc.text, score: scoreDocument(question, doc.text) }))
    .filter((scored) => scored.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((scored) => scored.text);
}
