import { createFileRoute } from "@tanstack/react-router";
import { DemoShell } from "@/components/demo-shell";

export const Route = createFileRoute("/")({
  component: DemoShell,
});
