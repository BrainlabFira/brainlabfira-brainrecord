// Definición única de los atajos globales.
//
// Vive aparte para que el main (que los REGISTRA) y el dashboard (que los
// MUESTRA) lean de la misma fuente. Si estuvieran duplicados, cambiar uno
// dejaría al dashboard anunciando una combinación que ya no funciona.
//
// Se usa Ctrl+Alt y no Ctrl+Shift a propósito: globalShortcut registra a nivel
// de sistema y le quita la combinación a todas las demás apps. Ctrl+Shift+R es
// "recargar forzando" en Chrome, Edge y Firefox — se lo estaríamos robando al
// empleado durante toda la jornada.

export const SHORTCUTS = {
  toggleRecording: 'Control+Alt+R',
  togglePanel: 'Control+Alt+P',
  openDashboard: 'Control+Alt+D',
} as const;

export interface ShortcutHelp {
  accelerator: string;
  label: string;
  description: string;
}

// Cómo se presentan al empleado en el dashboard. 'label' es la forma legible
// (Ctrl en vez de Control, que es como lo pide Electron pero no como lo lee
// una persona).
export const SHORTCUT_HELP: ShortcutHelp[] = [
  {
    accelerator: SHORTCUTS.toggleRecording,
    label: 'Ctrl + Alt + R',
    description: 'Iniciar o terminar la grabación',
  },
  {
    accelerator: SHORTCUTS.togglePanel,
    label: 'Ctrl + Alt + P',
    description: 'Mostrar u ocultar el panel flotante',
  },
  {
    accelerator: SHORTCUTS.openDashboard,
    label: 'Ctrl + Alt + D',
    description: 'Abrir el panel de control',
  },
];
