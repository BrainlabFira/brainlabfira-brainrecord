// Actualización automática.
//
// El manifiesto y los instaladores los sirve el concat-service bajo /updates/,
// autenticados con el JWT del empleado: una app de grabación de pantalla no
// debería poder descargarla cualquiera que pase por la red.
//
// REGLA PRINCIPAL: nunca interrumpir una grabación. La descarga puede ocurrir
// en cualquier momento, pero la instalación (que reinicia la app) espera a que
// no haya nada grabando ni chunks pendientes de subir.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('electron') as typeof import('electron');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { autoUpdater } = require('electron-updater');
import { log } from './logger';

export type UpdateState =
  | 'idle'          // sin comprobar todavía
  | 'checking'
  | 'available'     // hay versión nueva, descargando
  | 'downloading'
  | 'ready'         // descargada, esperando momento para instalar
  | 'latest'        // ya estás en la última
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  newVersion: string | null;
  progressPercent: number;
  error: string | null;
  // La instalación está lista pero se está esperando a que acabe la grabación.
  waitingForIdle: boolean;
}

// Versión de la app. En el empaquetado app.getVersion() devuelve la del
// package.json, pero SIN empaquetar devuelve la de Electron (33.4.11), que no
// significa nada para quien mira la interfaz.
export function appVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    // __dirname es dist/main en desarrollo
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../package.json').version as string;
  } catch {
    return app.getVersion();
  }
}

let status: UpdateStatus = {
  state: 'idle',
  currentVersion: appVersion(),
  newVersion: null,
  progressPercent: 0,
  error: null,
  waitingForIdle: false,
};

type StatusListener = (s: UpdateStatus) => void;
const listeners: StatusListener[] = [];

export function onUpdateStatusChange(fn: StatusListener): void {
  listeners.push(fn);
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}

function setStatus(partial: Partial<UpdateStatus>): void {
  status = { ...status, ...partial };
  for (const fn of listeners) {
    try {
      fn(getUpdateStatus());
    } catch (err) {
      log('[updater] Error en listener:', err);
    }
  }
}

// Decide si es seguro reiniciar para instalar. Lo aporta index.ts, que es quien
// conoce el estado de la grabación y de la cola de subida.
let isBusy: () => boolean = () => false;

export function setBusyCheck(fn: () => boolean): void {
  isBusy = fn;
}

// El token cambia (se refresca cada hora), así que se pide en cada comprobación
// en vez de fijarlo una vez.
let getToken: () => Promise<string | null> = async () => null;

export function setTokenProvider(fn: () => Promise<string | null>): void {
  getToken = fn;
}

let initialized = false;
let idleTimer: NodeJS.Timeout | null = null;

export async function initUpdater(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // La descarga la controlamos nosotros para poder informar del progreso; la
  // instalación, para no pisar una grabación.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // No usamos el instalador web, y dejarlo activo solo genera un aviso en el
  // log. En versiones futuras de electron-updater será el valor por defecto.
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = {
    info: (m: unknown) => log('[updater]', m),
    warn: (m: unknown) => log('[updater] WARN', m),
    error: (m: unknown) => log('[updater] ERROR', m),
    debug: () => { /* demasiado ruido para el log de la app */ },
  };

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', error: null }));

  autoUpdater.on('update-available', (info: { version: string }) => {
    log(`[updater] Versión nueva disponible: ${info.version}`);
    setStatus({ state: 'available', newVersion: info.version, progressPercent: 0 });
    // Descargar siempre: ocupa ancho de banda, pero deja la actualización
    // lista para aplicarse en cuanto el empleado deje de grabar.
    autoUpdater.downloadUpdate().catch((err: Error) => {
      setStatus({ state: 'error', error: err.message });
    });
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'latest', newVersion: null });
  });

  autoUpdater.on('download-progress', (p: { percent: number }) => {
    setStatus({ state: 'downloading', progressPercent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    log(`[updater] Actualización ${info.version} descargada`);
    setStatus({ state: 'ready', newVersion: info.version, progressPercent: 100 });
    scheduleInstall();
  });

  autoUpdater.on('error', (err: Error) => {
    log('[updater] Error:', err.message);
    setStatus({ state: 'error', error: err.message });
  });
}

// Comprueba si hay versión nueva. Devuelve false si no se pudo (sin sesión).
export async function checkForUpdates(): Promise<boolean> {
  if (!app.isPackaged) {
    // En desarrollo no hay nada que actualizar, y electron-updater lanzaría
    // un error confuso sobre app-update.yml.
    setStatus({ state: 'latest', error: null });
    return false;
  }

  const token = await getToken();
  if (!token) {
    setStatus({ state: 'error', error: 'Sin sesión activa' });
    return false;
  }

  const base = process.env.UPLOAD_SERVICE_URL ?? 'http://192.168.1.175:9210';
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${base}/updates`,
    // Las descargas por rangos múltiples no funcionan bien contra MinIO a
    // través del servicio: se pide el fichero entero.
    useMultipleRangeRequest: false,
  });
  // Se añade a cada petición del manifiesto y del instalador. El token se
  // renueva en cada comprobación porque caduca (~1h).
  autoUpdater.addAuthHeader(`Bearer ${token}`);

  try {
    await autoUpdater.checkForUpdates();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setStatus({ state: 'error', error: msg });
    return false;
  }
}

// Instala cuando la app esté ociosa. Si hay grabación o subidas pendientes,
// se reintenta cada minuto en vez de interrumpir.
function scheduleInstall(): void {
  if (idleTimer) return;

  const attempt = () => {
    if (status.state !== 'ready') {
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
      return;
    }
    if (isBusy()) {
      setStatus({ waitingForIdle: true });
      return;
    }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    log('[updater] Instalando actualización y reiniciando');
    // isSilent=false muestra el instalador; isForceRunAfter=true reabre la app.
    autoUpdater.quitAndInstall(false, true);
  };

  attempt();
  if (status.state === 'ready') idleTimer = setInterval(attempt, 60_000);
}

// Instalar ahora, a petición del empleado desde el dashboard. Solo tiene
// sentido si ya está descargada.
export function installNow(): boolean {
  if (status.state !== 'ready') return false;
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  log('[updater] Instalación forzada por el usuario');
  autoUpdater.quitAndInstall(false, true);
  return true;
}
