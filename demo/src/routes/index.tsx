import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DemoShell } from "@/components/demo-shell";

/**
 * Mount gate: the initial selection (URL hash) and theme (localStorage) are
 * client-only, so SSR would paint the default example/theme and visibly swap
 * after hydration. Render nothing on the server and the first client pass —
 * identical trees, no mismatch — then mount the real shell.
 */
function ClientOnlyDemoShell() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <DemoShell /> : null;
}

export const Route = createFileRoute("/")({
  component: ClientOnlyDemoShell,
});
