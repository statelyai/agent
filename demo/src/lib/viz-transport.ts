export function getTargetOrigin(url: string) {
  if (typeof window === "undefined") return new URL(url).origin;
  return new URL(url, window.location.href).origin;
}

export function isTrustedVizMessage(
  event: Pick<MessageEvent, "origin" | "source">,
  frameWindow: Window | null,
  targetOrigin: string,
) {
  return event.source === frameWindow && event.origin === targetOrigin;
}
