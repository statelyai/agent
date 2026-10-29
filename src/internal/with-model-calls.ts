/**
 * Records on a thrown error how many provider calls its request made, so the
 * runtime counts a failed tool loop's steps too (see `getCallModelCalls`).
 * @internal
 */
export function withModelCalls(error: unknown, modelCalls: number): unknown {
  if (modelCalls > 1 && typeof error === "object" && error !== null && Object.isExtensible(error)) {
    (error as { modelCalls?: number }).modelCalls ??= modelCalls;
  }
  return error;
}
