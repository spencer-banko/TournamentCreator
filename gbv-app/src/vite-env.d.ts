/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRAND: string
  readonly VITE_APP_NAME: string
  readonly VITE_BRAND_WORDMARK: string
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_SITE_URL: string
  readonly VITE_ENABLE_REALTIME: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>;
  export default component;
}
