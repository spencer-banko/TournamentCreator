import { useConfirm } from 'primevue/useconfirm';

/**
 * Promise-based replacement for window.confirm() using the app's PrimeVue ConfirmDialog,
 * so destructive prompts match the theme and don't block the browser.
 */
export function useConfirmAsync() {
  const confirm = useConfirm();
  return (message: string, opts: { header?: string; acceptLabel?: string; danger?: boolean } = {}) =>
    new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      confirm.require({
        header: opts.header ?? 'Are you sure?',
        message,
        icon: opts.danger === false ? 'pi pi-question-circle' : 'pi pi-exclamation-triangle',
        acceptLabel: opts.acceptLabel ?? 'Continue',
        rejectLabel: 'Cancel',
        defaultFocus: 'reject',
        acceptProps: { severity: opts.danger === false ? undefined : 'danger' },
        rejectProps: { severity: 'secondary', outlined: true },
        accept: () => done(true),
        reject: () => done(false),
        onHide: () => done(false),
      });
    });
}
