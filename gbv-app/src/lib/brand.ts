const id = import.meta.env.VITE_BRAND ?? 'gt';
const appName = import.meta.env.VITE_APP_NAME ?? 'GT Beach Volleyball';

// Optional separate wordmark image (text banner beneath the logo).
// Leave VITE_BRAND_WORDMARK unset or empty for brands whose logo already includes the name.
const wordmarkEnv = import.meta.env.VITE_BRAND_WORDMARK;
const logoWordmarkUrl: string | null = wordmarkEnv ? wordmarkEnv : null;

export const brand = {
  id,
  appName,
  logoUrl: `/brands/${id}/logo.png`,
  logoWordmarkUrl,
} as const;
