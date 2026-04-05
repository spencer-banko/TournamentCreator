/**
 * Shared PrimeVue Button `class` + `pt` for admin workflow pages
 * (matches Tournament Setup Save / New pill style).
 */
export const adminBtnPillPt = {
  root: { class: 'inline-flex items-center justify-center' },
  icon: { class: '!text-base' },
  label: { class: '!text-base !leading-none' },
} as const;

export const adminBtnBluePillClass =
  '!shrink-0 !rounded-full border-none text-white gbv-grad-blue !min-h-[2.75rem] !px-6 !py-2.5 !text-base !gap-2';

export const adminBtnGreenPillClass =
  '!shrink-0 !rounded-full border-none text-white gbv-grad-green !min-h-[2.75rem] !px-6 !py-2.5 !text-base !gap-2';

/** Filled amber/orange pill (same shape as green/blue admin CTAs). */
export const adminBtnOrangePillClass =
  '!shrink-0 !rounded-full border-none text-white gbv-grad-orange !min-h-[2.75rem] !px-6 !py-2.5 !text-base !gap-2';

/** Danger / warn: shape only; color comes from PrimeVue `severity`. */
export const adminBtnDangerPillClass =
  '!shrink-0 !rounded-full border-none !min-h-[2.75rem] !px-6 !py-2.5 !text-base !gap-2';

export const adminBtnWarnPillClass =
  '!shrink-0 !rounded-full border-none !min-h-[2.75rem] !px-6 !py-2.5 !text-base !gap-2';

/** Compact pill for inline “Add …” actions in builders */
export const adminBtnPillSmPt = {
  root: { class: 'inline-flex items-center justify-center' },
  icon: { class: '!text-sm' },
  label: { class: '!text-sm !leading-none' },
} as const;

export const adminBtnBluePillSmClass =
  '!shrink-0 !rounded-full border-none text-white gbv-grad-blue !min-h-[2.25rem] !px-4 !py-2 !text-sm !gap-1.5';
