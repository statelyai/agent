/**
 * Ordering tickets for inspection-room declarations.
 *
 * A declaration handler loads a machine before it can publish it, and two
 * quick selections can finish those loads out of order. The ticket is what
 * makes the ROOM's graph follow the order the selections were requested in,
 * so a handler claims one synchronously on entry — before its first `await`,
 * including the dynamic import of the server-only inspection module. That is
 * why the counter lives in a module with no server dependencies of its own
 * rather than in `inspection.server.ts`.
 */
let issued = 0;

/** The next ticket. Higher is newer; {@link declarationIsCurrent} compares them. */
export function nextDeclaration(): number {
  issued += 1;
  return issued;
}
