import type { ConfirmationOptions } from 'primevue/confirmationoptions';

/** PrimeVue ConfirmDialog options for deleting a tournament (dashboard list + setup). */
export function deleteTournamentConfirmOptions(
  name: string,
  onAccept: () => void
): ConfirmationOptions {
  const displayName = name.trim() || 'Untitled tournament';
  return {
    header: 'Delete this tournament?',
    message: [
      `You are about to permanently delete "${displayName}".`,
      '',
      'All teams, pools, matches, schedules, and bracket data for this tournament will be removed.',
      '',
      'This action cannot be undone.',
    ].join('\n'),
    icon: 'pi pi-trash',
    acceptLabel: 'Yes, delete permanently',
    rejectLabel: 'No, keep it',
    defaultFocus: 'reject',
    accept: onAccept,
    acceptProps: {
      severity: 'danger',
      icon: 'pi pi-trash',
      class:
        '!border-2 !border-red-400 !ring-2 !ring-red-500/70 !ring-offset-2 !ring-offset-slate-900 !shadow-lg !shadow-red-950/50',
    },
    rejectProps: {
      severity: 'secondary',
      outlined: true,
      icon: 'pi pi-times',
    },
  };
}
