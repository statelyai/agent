import { useEffect, useRef, useState } from "react";
import { FileCode2 } from "lucide-react";
import type { Scenario } from "@/lib/scenarios";
import { scenarioSource } from "@/lib/scenarios";

type CodePanelProps = { scenario: Scenario };

/**
 * Shows the scenario's actual `src/agents/<id>.ts` source (imported verbatim via
 * Vite `?raw`), highlighted lazily on the client with Shiki so SSR stays simple.
 */
export function CodePanel({ scenario }: CodePanelProps) {
  const source = scenarioSource[scenario.id];
  const [html, setHtml] = useState<string | null>(null);
  const cache = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    const cached = cache.current.get(scenario.id);
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
        cache.current.set(scenario.id, out);
        setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scenario.id, source]);

  return (
    <section className="work-panel code-panel" aria-labelledby="code-panel-title">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Machine source</span>
          <h2 id="code-panel-title">
            <FileCode2 size={15} aria-hidden="true" /> src/agents/{scenario.id}.ts
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
