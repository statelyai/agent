/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VIZ_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
