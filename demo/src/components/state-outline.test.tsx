import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { scenarioDiagramHints, scenarioVizConfig } from "@/lib/scenarios";
import { StateOutline, initialActivePaths } from "./state-outline";

test("research initially lights both parallel regions", () => {
  expect([...initialActivePaths(scenarioVizConfig.research)]).toEqual([
    "researching",
    "researching.risk",
    "researching.risk.running",
    "researching.opportunity",
    "researching.opportunity.running",
  ]);
});

test("email outline renders static events once", () => {
  const html = renderToStaticMarkup(
    <StateOutline
      title="Email drafter v1"
      config={scenarioVizConfig["email-drafter-v1"]}
      value={null}
      hints={scenarioDiagramHints["email-drafter-v1"]}
    />,
  );
  expect(html.match(/>MORE_INFO</g)).toHaveLength(1);
  expect(html.match(/>DRAFT_ANYWAY</g)).toHaveLength(1);
});
