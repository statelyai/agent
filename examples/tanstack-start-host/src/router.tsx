/**
 * Start's required router entry. The plugin resolves `src/router` and calls the
 * exported `getRouter` (the name is fixed — `routeTree.gen.ts` imports its type
 * from here).
 */
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}
