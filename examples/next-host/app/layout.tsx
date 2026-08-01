/**
 * The App Router's required root layout. Deliberately bare: this example is
 * about the route handlers under `app/api/agent`, and the page exists so the
 * flow can be driven from a browser.
 */
import type { ReactNode } from "react";

export const metadata = {
  title: "Next.js host — @statelyai/agent",
  description: "runAgent in a Next.js route handler, with human-in-the-loop review.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
