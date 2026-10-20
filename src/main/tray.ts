import type { Tray as TrayType, Menu as MenuType } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Tray, Menu, app, nativeImage } = require('electron') as typeof import('electron');
import path from 'path';
import { SHORTCUT_HELP } from './shortcuts';

export type TrayState = 'idle' | 'recording' | 'error' | 'connecting';

const APP_NAME = 'Brainlabrecord';

let tray: TrayType | null = null;
let currentState: TrayState = 'idle';

export interface TrayCallbacks {
  onLogout: () => void;
  onToggleRecording: () => void;
  onOpenDashboard: () => void;
}

let callbacks: TrayCallbacks | null = null;

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
  const recording = currentState === 'recording';
  const toggle = SHORTCUT_HELP.find((s) => s.description.startsWith('Iniciar'));
  const dash = SHORTCUT_HELP.find((s) => s.description.startsWith('Abrir'));

  return Menu.buildFromTemplate([
    {
      label: `Estado: ${STATE_LABELS[currentState]}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      // Grabar desde la bandeja: el camino más corto cuando el dashboard está
      // cerrado y el empleado no recuerda el atajo.
      label: recording ? 'Terminar grabación' : 'Iniciar grabación',
      accelerator: toggle?.label,
      click: () => { callbacks?.onToggleRecording(); },
    },
    {
      label: 'Panel de control',
      accelerator: dash?.label,
      click: () => { callbacks?.onOpenDashboard(); },
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
      click: () => { callbacks?.onLogout(); },
    },
    {
      label: 'Salir',
      click: () => app.quit(),
    },
  ]);
}

export function initTray(cbs: TrayCallbacks): void {
  callbacks = cbs;
  const icon = nativeImage.createFromPath(getIconPath('idle'));
  tray = new Tray(icon);

  tray.setToolTip(`${APP_NAME} — Inactivo`);
  tray.setContextMenu(buildContextMenu());

  // Doble clic abre el dashboard: es lo que un usuario de Windows espera de un
  // icono de bandeja. Antes no hacía nada (la app no tenía UI que mostrar).
  tray.on('double-click', () => { callbacks?.onOpenDashboard(); });
}

export function updateTrayState(state: TrayState): void {
  if (!tray) return;

  currentState = state;

  const iconPath = getIconPath(state);
  const icon = nativeImage.createFromPath(iconPath);
  tray.setImage(icon);
  tray.setToolTip(`${APP_NAME} — ${STATE_LABELS[state]}`);
  // Reconstruir el menú para que "Estado:" y la acción de grabar reflejen el
  // estado actual (antes solo cambiaba el icono; el menú quedaba obsoleto).
  tray.setContextMenu(buildContextMenu());
}
