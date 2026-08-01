/**
 * Runs before every test file in the root suite.
 *
 * `vitest.config.ts` calls `dotenv.config()` so tests can read local config
 * (inspector URLs, ports, and so on) from `.env`. That also loads real provider
 * keys, and every example switches to live executors when it sees one — so a
 * plain `vitest run` on a developer machine would bill real API calls.
 *
 * Provider keys are therefore blanked here for the whole suite. Live testing is
 * opt-in: set `LIVE_TESTS=1` to keep the loaded keys. Non-provider variables
 * from `.env` are left untouched.
 */
const PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TAVILY_API_KEY"];

if (process.env.LIVE_TESTS !== "1") {
  for (const key of PROVIDER_KEYS) {
    process.env[key] = "";
  }
}
