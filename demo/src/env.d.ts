/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the hosted Stately editor; its `/inspect` page renders the run. */
  readonly VITE_VIZ_URL?: string;
  /** Overrides the derived `<viz origin>/inspect` live-inspection URL. */
  readonly VITE_VIZ_INSPECT_URL?: string;
  /**
   * Optional access token for the editor's embed, which draws the machine
   * when live inspection is unavailable. Needed only if the embed origin
   * gates the embed route.
   */
  readonly VITE_STATELY_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
