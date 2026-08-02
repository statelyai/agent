import { useEffect, useRef, useState } from "react";

type CodeSourceProps = {
  source: string;
  /** Stable cache key for the highlighted output (scenario or example id). */
  cacheKey: string;
  /** Class applied to the scrolling wrapper. */
  className?: string;
};

/**
 * Renders a machine's actual source (imported verbatim via Vite `?raw` or
 * served by the examples library), highlighted lazily on the client with Shiki
 * so SSR stays simple. Chrome-free: callers own the surrounding frame.
 */
export function CodeSource({ source, cacheKey, className = "code-scroll" }: CodeSourceProps) {
  const [html, setHtml] = useState<string | null>(null);
  const cache = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    const cached = cache.current.get(cacheKey);
    if (cached) {
      setHtml(cached);
      return;
    }
    setHtml(null);
    void (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const out = await codeToHtml(source, {
          lang: "typescript",
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
        if (cancelled) return;
        cache.current.set(cacheKey, out);
        setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, source]);

  return (
    <div className={className}>
      {html ? (
        <div className="code-shiki" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-plain">
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
