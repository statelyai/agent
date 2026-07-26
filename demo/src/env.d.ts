/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VIZ_URL?: string;
  /** Overrides the derived `<viz origin>/inspect` live-inspection URL. */
  readonly VITE_VIZ_INSPECT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
