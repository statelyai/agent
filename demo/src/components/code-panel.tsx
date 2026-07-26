import { useEffect, useRef, useState } from "react";
import { FileCode2 } from "lucide-react";

type CodePanelProps = {
  /** Path label shown in the heading, e.g. `src/agents/refund.ts`. */
  fileLabel: string;
  source: string;
  /** Stable cache key for the highlighted output (scenario or example id). */
  cacheKey: string;
};

/**
 * Shows a machine's actual source (imported verbatim via Vite `?raw` or served
 * by the examples library), highlighted lazily on the client with Shiki so SSR
 * stays simple.
 */
export function CodePanel({ fileLabel, source, cacheKey }: CodePanelProps) {
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
    <section className="work-panel code-panel" aria-labelledby="code-panel-title">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Machine source</span>
          <h2 id="code-panel-title">
            <FileCode2 size={15} aria-hidden="true" /> {fileLabel}
          </h2>
        </div>
      </div>
      <div className="code-scroll">
        {html ? (
          <div className="code-shiki" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="code-plain">
            <code>{source}</code>
          </pre>
        )}
      </div>
    </section>
  );
}
