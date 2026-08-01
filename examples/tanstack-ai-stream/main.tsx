/**
 * Browser entry: mounts ./chat.tsx. The component is unchanged from the one a
 * TanStack Start route would render — it POSTs to `/api/chat`, which the dev
 * server in ./vite.config.ts serves from the same `POST` handler a real route
 * would export.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "./chat.js";

const container = document.getElementById("root");
if (!container) throw new Error("no #root element");

createRoot(container).render(
  <StrictMode>
    <h1>TanStack AI stream</h1>
    <AgentChat />
  </StrictMode>,
);
