import type { Tray as TrayType, BrowserWindow as BW, Menu as MenuType } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Tray, Menu, BrowserWindow, app, nativeImage } = require('electron') as typeof import('electron');
import path from 'path';

export type TrayState = 'idle' | 'recording' | 'error' | 'connecting';

const APP_NAME = 'Brainlabrecord';

let tray: TrayType | null = null;
let currentState: TrayState = 'idle';
let onLogout: (() => void) | null = null;

const STATE_LABELS: Record<TrayState, string> = {
  idle: 'Inactivo',
  recording: 'Grabando...',
  error: 'Error de conexión',
  connecting: 'Conectando...',
};

function getIconPath(state: TrayState): string {
  const iconName = state === 'recording' ? 'tray-recording.png' : 'tray-idle.png';
  return path.join(__dirname, '../../assets', iconName);
}

function buildContextMenu(): MenuType {
  return Menu.buildFromTemplate([
    {
      label: `Estado: ${STATE_LABELS[currentState]}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: `${APP_NAME} v1.0.0`,
      enabled: false,
    },
    { type: 'separator' },
    {
      // Cerrar sesión: borra la sesión y muestra el login. Para reasignar el PC
      // a otro empleado. El logout es libre (sin contraseña) por decisión de diseño.
      label: 'Cerrar sesión',
      click: () => { onLogout?.(); },
    },
    {
      label: 'Salir',
      click: () => app.quit(),
    },
  ]);
}

export function initTray(_loginWindow: BW, logoutFn: () => void): void {
  onLogout = logoutFn;
  const icon = nativeImage.createFromPath(getIconPath('idle'));
  tray = new Tray(icon);

  tray.setToolTip(`${APP_NAME} — Inactivo`);
  tray.setContextMenu(buildContextMenu());

  tray.on('double-click', () => {
    // Double-click does nothing by design (background-only app)
  });
}

export function updateTrayState(state: TrayState): void {
  if (!tray) return;

  currentState = state;

  const iconPath = getIconPath(state);
  const icon = nativeImage.createFromPath(iconPath);
  tray.setImage(icon);
  tray.setToolTip(`${APP_NAME} — ${STATE_LABELS[state]}`);
  // Reconstruir el menú para que "Estado:" refleje el estado actual
  // (antes solo cambiaba el icono; el menú quedaba obsoleto).
  tray.setContextMenu(buildContextMenu());
}
