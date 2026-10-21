import type { BrowserWindow as BW } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow, ipcMain, Notification, globalShortcut, screen, shell, dialog } =
  require('electron') as typeof import('electron');
import path from 'path';
import { loadEnv } from './env';
import { initTray, updateTrayState } from './tray';
import {
  initSupabase,
  InvalidSessionError,
  resetSupabaseSession,
  getCurrentUserEmail,
  getFreshAccessToken,
} from './supabase';
import {
  startRecording,
  stopRecording,
  initRecorderIPC,
  getRecordingStatus,
  onRecordingStatusChange,
  getRecordingConfig,
  setRecordingConfig,
  getScreenInfo,
  getTempDir,
  getFreeDiskBytes,
  onCaptureFailure,
  RecordingConfig,
} from './recorder';
import {
  onUploadStatusChange,
  getUploadStatus,
  resetUploadCounters,
  recoverPendingChunks,
  onChunkDropped,
} from './uploader';
import { loadSession, saveSession, clearSession, SessionData } from './auth';
import { log, initLogPath } from './logger';
import { SHORTCUTS } from './shortcuts';

loadEnv();

const _origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  log('[ERROR]', ...args);
  _origError(...args);
};
process.on('uncaughtException', (err) => { log('[UNCAUGHT]', err); });
process.on('unhandledRejection', (reason) => { log('[UNHANDLED REJECTION]', reason); });

// ───────────────────────────────────────────────────────────────
// Tres ventanas, cada una con un papel.
//
// Antes había una sola (login.html) que era a la vez pantalla de login y motor
// de captura: el MediaRecorder vivía en el mismo documento que el formulario.
// Eso impedía tener un dashboard aparte, porque cerrar o navegar la ventana
// mataba la grabación. Ahora:
//
//   captureWindow  — oculta y permanente. Solo MediaRecorder, sin UI.
//   loginWindow    — el formulario de acceso. Se oculta al entrar.
//   dashboardWindow— la UI principal (grabar, ajustes, historial, atajos).
//   panelWindow    — barra flotante de control mientras graba.
// ───────────────────────────────────────────────────────────────
let captureWindow: BW | null = null;
let loginWindow: BW | null = null;
let dashboardWindow: BW | null = null;
let panelWindow: BW | null = null;
let playerWindow: BW | null = null;

let currentSession: SessionData | null = null;
// Atajos que el sistema rechazó porque otra app ya los tenía registrados.
// Se muestran en el dashboard: si no, el empleado pulsa y no pasa nada.
const failedShortcuts: string[] = [];

function rendererPath(file: string): string {
  return path.join(__dirname, '../renderer', file);
}

// Icono de las ventanas y de la barra de tareas. Sin esto Windows muestra el
// icono por defecto de Electron: electron-builder solo lo aplica al .exe
// empaquetado, no a las BrowserWindow.
function appIcon(): string {
  return path.join(__dirname, '../../assets', 'tray-icon.ico');
}

// Ventana oculta que solo captura. Nunca se muestra ni se cierra mientras la
// app vive, para que la grabación no dependa de ninguna ventana visible.
function createCaptureWindow(): void {
  captureWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  captureWindow.loadFile(rendererPath('capture.html'));
  captureWindow.on('closed', () => { captureWindow = null; });
}

function createLoginWindow(): void {
  loginWindow = new BrowserWindow({
    width: 440,
    height: 560,
    show: false,
    // Sí aparece en la barra de tareas: antes llevaba skipTaskbar y, si el
    // empleado la tapaba con otra ventana, no había forma de volver a ella
    // (el menú de bandeja tampoco ofrecía mostrarla).
    skipTaskbar: false,
    title: 'Brainlabrecord',
    icon: appIcon(),
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(rendererPath('login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
}

function createDashboardWindow(): void {
  dashboardWindow = new BrowserWindow({
    width: 760,
    height: 620,
    show: false,
    icon: appIcon(),
    title: 'Brainlabrecord',
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  dashboardWindow.setMenuBarVisibility(false);
  dashboardWindow.loadFile(rendererPath('dashboard.html'));
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

// Barra flotante de control. Arranca arriba a la derecha, siempre visible por
// encima del resto, y se puede arrastrar a cualquier parte.
function createPanelWindow(): void {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const PANEL_W = 320;
  const PANEL_H = 64;

  panelWindow = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    x: screenW - PANEL_W - 24,
    y: 24,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    // focusable se queda en true a propósito: con false, en Windows la ventana
    // deja de recibir clics y los botones de terminar/minimizar no responden.
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  // 'screen-saver' mantiene el panel por encima incluso de ventanas a pantalla
  // completa (una videollamada maximizada, por ejemplo).
  panelWindow.setAlwaysOnTop(true, 'screen-saver');

  // CLAVE: sin esto el propio panel sale grabado en el vídeo, porque la captura
  // es de la pantalla completa. setContentProtection lo excluye de la captura.
  panelWindow.setContentProtection(true);

  panelWindow.loadFile(rendererPath('panel.html'));
  panelWindow.on('closed', () => { panelWindow = null; });
}

// Reproductor en ventana propia, no dentro del dashboard: las grabaciones son
// ultrapanorámicas (3840x1080) y en una ventana de 760px quedaban en una franja
// diminuta. Aquí se puede redimensionar, maximizar y mover a otro monitor.
function createPlayerWindow(): void {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  // 1400x700 salvo que la pantalla sea menor; con margen para que no tape todo.
  const w = Math.min(1400, Math.round(sw * 0.8));
  const h = Math.min(760, Math.round(sh * 0.85));

  playerWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 620,
    minHeight: 380,
    show: false,
    frame: false,
    resizable: true,
    maximizable: true,
    backgroundColor: '#0d0d10',
    title: 'Brainlabrecord — Reproductor',
    icon: appIcon(),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  playerWindow.setMenuBarVisibility(false);
  playerWindow.loadFile(rendererPath('player.html'));

  // Ocultar en vez de cerrar: la ventana se reutiliza para la siguiente
  // grabación. Al ocultarse hay que parar la descarga en curso.
  playerWindow.on('hide', () => {
    playerWindow?.webContents.send('player:stop');
  });
  playerWindow.on('closed', () => { playerWindow = null; });
}

function showNotification(title: string, body: string): void {
  new Notification({ title, body }).show();
}

// Avisos al empleado. Los críticos son aquellos en los que, sin aviso, creería
// que está grabando algo que en realidad se está perdiendo.
export interface AppAlert {
  level: 'critical' | 'warning';
  title: string;
  message: string;
  detail?: string;
}

function notifyAlert(alert: AppAlert): void {
  log(`[alert:${alert.level}] ${alert.title} — ${alert.message}`);

  // Notificación del sistema: se ve aunque el dashboard esté cerrado.
  showNotification(`Brainlabrecord — ${alert.title}`, alert.message);

  // Y el modal del dashboard, que es el que de verdad interrumpe. Si está
  // cerrado se abre: un fallo crítico no puede quedarse esperando a que al
  // empleado le dé por mirar.
  if (alert.level === 'critical') {
    openDashboard();
  }
  dashboardWindow?.webContents.send('app:alert', alert);
}

// Reenvía un mensaje a todas las ventanas de UI que existan. Cada una decide
// si le interesa; así no hay que llevar la cuenta de quién está abierto.
function broadcast(channel: string, payload: unknown): void {
  for (const win of [dashboardWindow, panelWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function connectWithSession(session: SessionData): Promise<void> {
  try {
    await initSupabase(session);
    currentSession = session;
    updateTrayState('idle');

    // Con la sesión ya validada hay token para subir: rescatamos los chunks
    // que quedaran en disco de una sesión anterior (cierre forzado, corte de
    // luz, red caída al final de la jornada).
    const recovered = recoverPendingChunks(getTempDir());
    if (recovered > 0) {
      showNotification(
        'Brainlabrecord',
        `Recuperando ${recovered} fragmento(s) de una grabación anterior`
      );
    }

    // Ya no se suscribe a `fichajes`: la grabación la inicia el empleado.
    // Al validar la sesión, lo único que toca es mostrarle el dashboard.
    loginWindow?.hide();
    openDashboard();
  } catch (err) {
    // Sesión inválida/caducada (p.ej. refresh token muerto tras mucho tiempo):
    // borramos la sesión y mostramos el login, en vez de quedar "logueado" pero
    // sin poder subir nada (fallo silencioso).
    if (err instanceof InvalidSessionError) {
      log('[AUTH] Sesión inválida al arrancar — pidiendo login:', err.message);
      await doLogout();
      return;
    }

    // Otros errores (red, servidor): mantenemos la sesión y marcamos error.
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err);
    log('[ERROR] connectWithSession falló:', msg);
    showNotification('Brainlabrecord — Error', 'No se pudo conectar con el servidor');
    updateTrayState('error');
  }
}

// Trae al frente la ventana que corresponde al estado actual: el login si no
// hay sesión, el dashboard si la hay. Es lo que hacen el doble clic en la
// bandeja y Ctrl+Alt+D, para que nunca se quede la app sin forma de volver.
function openDashboard(): void {
  if (!currentSession) {
    if (!loginWindow) createLoginWindow();
    loginWindow?.show();
    loginWindow?.focus();
    return;
  }
  if (!dashboardWindow) createDashboardWindow();
  dashboardWindow?.show();
  dashboardWindow?.focus();
}

// Logout: para la grabación, borra la sesión guardada y muestra el login.
// Al reasignar el PC, quien lo haga cierra sesión y el siguiente empleado ve
// el login limpio.
async function doLogout(): Promise<void> {
  await handleStopRecording();
  resetSupabaseSession();
  await clearSession();
  currentSession = null;
  updateTrayState('idle');
  dashboardWindow?.hide();
  panelWindow?.hide();
  if (!loginWindow) createLoginWindow();
  loginWindow?.show();
  loginWindow?.focus();
}

// ───────────────────────────────────────────────────────────────
// Control de grabación
// ───────────────────────────────────────────────────────────────

async function handleStartRecording(): Promise<void> {
  if (!currentSession) {
    log('[recording] Se pidió grabar sin sesión activa — ignorado');
    return;
  }
  if (getRecordingStatus().isRecording) return;

  // Disco lleno: los chunks se escriben en temp antes de comprimirse y subir.
  // Sin espacio, FFmpeg falla y la grabación muere a mitad. Mejor no empezar.
  const freeBytes = getFreeDiskBytes();
  const MIN_FREE_GB = 2;
  if (freeBytes !== null && freeBytes < MIN_FREE_GB * 1024 ** 3) {
    notifyAlert({
      level: 'critical',
      title: 'Espacio insuficiente',
      message: `Quedan ${(freeBytes / 1024 ** 3).toFixed(1)} GB libres en el disco. `
        + 'Libera espacio antes de grabar.',
      detail: 'Los fragmentos se guardan en el disco antes de subirse. '
        + `Se necesitan al menos ${MIN_FREE_GB} GB.`,
    });
    return;
  }

  // Solo reiniciar contadores si no hay nada en vuelo: si quedan chunks de
  // una grabación anterior subiéndose, ponerlos a cero haría parecer que no
  // hay nada pendiente.
  if (getUploadStatus().pending + getUploadStatus().uploading === 0) {
    resetUploadCounters();
  }
  const recId = await startRecording(String(currentSession.numericUserId), captureWindow!);
  if (!recId) return;

  updateTrayState('recording');

  // El panel sustituye al dashboard mientras graba: el dashboard es para
  // preparar la grabación, el panel para controlarla sin estorbar.
  if (!panelWindow) createPanelWindow();
  panelWindow?.show();
  dashboardWindow?.hide();

  // Indicador visible: el empleado inicia la grabación, así que confirmarlo
  // es útil (no es vigilancia silenciosa como en la versión anterior).
  showNotification('Brainlabrecord', 'Grabación iniciada');
}

async function handleStopRecording(): Promise<void> {
  if (!getRecordingStatus().isRecording) return;

  await stopRecording();
  updateTrayState('idle');
  panelWindow?.hide();

  const { pending } = getUploadStatus();
  showNotification(
    'Brainlabrecord',
    pending > 0
      ? `Grabación finalizada — subiendo ${pending} fragmento(s)`
      : 'Grabación finalizada'
  );

  // Al terminar, devolvemos al empleado al dashboard para que vea el historial
  // y el estado de subida.
  openDashboard();
}

// Pedir confirmación antes de parar. El diálogo vive en el dashboard (es la
// ventana con sitio para mostrarlo), así que desde el panel o desde el atajo
// traemos el dashboard al frente y le pedimos que pregunte.
function requestStopConfirmation(): void {
  if (!getRecordingStatus().isRecording) return;
  openDashboard();
  dashboardWindow?.webContents.send('recording:confirm-stop');
}

async function toggleRecording(): Promise<void> {
  if (getRecordingStatus().isRecording) {
    requestStopConfirmation();
  } else {
    await handleStartRecording();
  }
}

// ───────────────────────────────────────────────────────────────
// Atajos globales
// ───────────────────────────────────────────────────────────────

// globalShortcut registra a nivel de SISTEMA: la combinación se la quitamos a
// cualquier otra app mientras Brainlabrecord corre. Por eso se usa Ctrl+Alt
// (bastante libre en Windows) y no Ctrl+Shift, que pisaría el recargar forzado
// de los navegadores.
//
// register() devuelve false si otra app ya tiene la combinación. Lo anotamos
// para avisar en el dashboard: si falla en silencio, el empleado pulsa y no
// entiende por qué no pasa nada.
function registerShortcuts(): void {
  const bindings: Array<[string, () => void]> = [
    [SHORTCUTS.toggleRecording, () => { void toggleRecording(); }],
    [SHORTCUTS.togglePanel, () => { togglePanelVisibility(); }],
    [SHORTCUTS.openDashboard, () => { openDashboard(); }],
  ];

  for (const [accelerator, handler] of bindings) {
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) {
        failedShortcuts.push(accelerator);
        log(`[shortcuts] No se pudo registrar ${accelerator} (otra app lo usa)`);
      } else {
        log(`[shortcuts] Registrado ${accelerator}`);
      }
    } catch (err) {
      failedShortcuts.push(accelerator);
      log(`[shortcuts] Error al registrar ${accelerator}:`, err);
    }
  }
}

// Ctrl+Alt+P alterna entre barra completa y punto. NO esconde el panel: el
// indicador de que se está grabando no debe poder desaparecer de la pantalla.
function togglePanelVisibility(): void {
  if (!getRecordingStatus().isRecording) return; // el panel solo existe grabando
  if (!panelWindow || panelWindow.isDestroyed()) return;
  if (!panelWindow.isVisible()) panelWindow.show();
  panelWindow.webContents.send('panel:toggle-size');
}

// El panel cambia de tamaño al minimizarse: pasa de la barra completa a solo
// el punto REC. La altura la decide el renderer y la pide por IPC.
function resizePanel(width: number, height: number): void {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const [x, y] = panelWindow.getPosition();
  panelWindow.setBounds({ x, y, width, height });
}

// Marca que ya hemos hecho la salida ordenada, para que el segundo app.quit()
// no vuelva a entrar en el mismo camino.
let quitConfirmed = false;

// Salida ordenada: pregunta, cierra la grabación en curso y espera a que la
// cola de subida se vacíe antes de dejar morir la app.
//
// Se usa el diálogo NATIVO y no el del dashboard a propósito: durante el cierre
// las ventanas pueden estar ya destruidas, y un diálogo HTML no garantiza que
// se llegue a ver ni que podamos esperar su respuesta.
async function gracefulQuit(recording: boolean, pendingTotal: number): Promise<void> {
  const parts: string[] = [];
  if (recording) parts.push('Hay una grabación en curso.');
  if (pendingTotal > 0) parts.push(`Quedan ${pendingTotal} fragmento(s) por subir.`);

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancelar', 'Guardar y salir', 'Salir sin guardar'],
    defaultId: 1,
    cancelId: 0,
    title: 'Brainlabrecord',
    icon: appIcon(),
    message: '¿Cerrar Brainlabrecord?',
    detail: `${parts.join(' ')}\n\nSi sales sin guardar se perderá lo grabado desde el último fragmento.`,
  });

  if (response === 0) return; // cancelar: la app sigue viva

  if (response === 1) {
    log('[app] Cierre ordenado: guardando grabación y subidas pendientes');
    if (recording) {
      await stopRecording();
      updateTrayState('idle');
    }
    // Dar margen a que la cola termine. No es indefinido: si la red está caída
    // no tiene sentido bloquear la salida para siempre, los chunks quedan en
    // disco y se reintentan al volver a abrir.
    await waitForUploads(60_000);
  } else {
    log('[app] Cierre forzado por el usuario — se descarta lo no subido');
  }

  quitConfirmed = true;
  app.quit();
}

// Espera a que la cola de subida se vacíe, hasta un máximo.
function waitForUploads(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const { pending, uploading } = getUploadStatus();
      if (pending + uploading === 0) return resolve();
      if (Date.now() - start > timeoutMs) {
        log(`[app] Timeout esperando subidas: quedan ${pending + uploading} chunk(s) en disco`);
        return resolve();
      }
      setTimeout(check, 500);
    };
    check();
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  initLogPath();
  log('=== Brainlabrecord arrancando ===');
  log('[ENV] SUPABASE_URL =', process.env.SUPABASE_URL ?? '(vacío)');
  log('[ENV] SUPABASE_ANON_KEY =', process.env.SUPABASE_ANON_KEY ? '(presente)' : '(vacío)');
  log('[userData]', app.getPath('userData'));

  initRecorderIPC();
  createCaptureWindow();
  createLoginWindow();
  initTray({
    onLogout: () => { void doLogout(); },
    onToggleRecording: () => { void toggleRecording(); },
    onOpenDashboard: () => { openDashboard(); },
  });

  // Salir con una grabación activa cuesta todo lo grabado desde el último
  // corte de chunk (hasta 10 min). Interceptamos la salida para cerrar bien la
  // grabación y vaciar la cola de subida antes de morir.
  app.on('before-quit', (event) => {
    if (quitConfirmed) return; // segunda pasada: dejar salir

    const recording = getRecordingStatus().isRecording;
    const { pending, uploading } = getUploadStatus();
    const pendingTotal = pending + uploading;

    if (!recording && pendingTotal === 0) return; // nada que salvar

    event.preventDefault();
    void gracefulQuit(recording, pendingTotal);
  });

  app.setLoginItemSettings({ openAtLogin: true, name: 'Brainlabrecord' });
  registerShortcuts();

  // Propagar estado a las ventanas de UI. El panel y el dashboard se pintan
  // a partir de estos eventos en vez de preguntar en bucle.
  onRecordingStatusChange((status) => { broadcast('recording:status', status); });
  onUploadStatusChange((status) => { broadcast('upload:status', status); });

  // La captura no arrancó: se aborta en vez de seguir marcando "Grabando"
  // sobre una grabación que no existe.
  onCaptureFailure((message) => {
    void (async () => {
      const wasRecording = getRecordingStatus().isRecording;
      if (wasRecording) {
        await stopRecording();
        updateTrayState('idle');
        panelWindow?.hide();
      }
      notifyAlert({
        level: 'critical',
        title: 'No se pudo grabar',
        message: 'La grabación se ha detenido porque no se pudo capturar la pantalla.',
        detail: message,
      });
    })();
  });

  // Un chunk descartado es un trozo de grabación perdido para siempre.
  onChunkDropped((info) => {
    notifyAlert({
      level: 'critical',
      title: 'Fragmento perdido',
      message: `No se pudo subir un fragmento tras varios intentos y se ha descartado.`,
      detail: `${info.objectName}\nRevisa la conexión con el servidor.`,
    });
  });

  // ── IPC: sesión ──
  ipcMain.on('session-ready', async (_event, session: SessionData) => {
    await saveSession(session);
    await connectWithSession(session);
  });

  ipcMain.on('logout', () => { void doLogout(); });

  ipcMain.handle('session:info', () => ({
    email: getCurrentUserEmail(),
    numericUserId: currentSession?.numericUserId ?? null,
  }));

  // ── IPC: grabación ──
  ipcMain.handle('recording:start', async () => {
    await handleStartRecording();
    return getRecordingStatus();
  });

  ipcMain.handle('recording:stop', async () => {
    await handleStopRecording();
    return getRecordingStatus();
  });

  ipcMain.on('recording:request-stop', () => { requestStopConfirmation(); });

  ipcMain.handle('recording:status', () => getRecordingStatus());
  ipcMain.handle('upload:status', () => getUploadStatus());

  // ── IPC: ajustes ──
  ipcMain.handle('config:get', () => getRecordingConfig());
  ipcMain.handle('screen:info', () => getScreenInfo());

  ipcMain.handle('config:set', (_event, partial: Partial<RecordingConfig>) => {
    // Los ajustes se aplican a la SIGUIENTE grabación, no a la que está en
    // curso: cambiar resolución o fps a mitad obligaría a cortar el chunk.
    setRecordingConfig(partial);
    const updated = getRecordingConfig();
    broadcast('config:changed', updated);
    return updated;
  });

  // ── IPC: atajos ──
  ipcMain.handle('shortcuts:info', () => ({
    shortcuts: SHORTCUTS,
    failed: failedShortcuts,
  }));

  // ── IPC: ventanas ──
  // El panel y el dashboard no tienen frame nativo: cerrar oculta la ventana,
  // la app sigue viva en la bandeja.
  ipcMain.on('window-close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide();
  });

  ipcMain.on('panel:resize', (_event, { width, height }: { width: number; height: number }) => {
    resizePanel(width, height);
  });

  ipcMain.on('dashboard:open', () => { openDashboard(); });

  // ── IPC: menú de cuenta ──
  ipcMain.on('account:open-recordings', () => {
    // Las grabaciones viven en MinIO, no en disco: abrimos la consola web en
    // la carpeta del empleado.
    const base = process.env.MINIO_CONSOLE_URL ?? 'http://192.168.1.175:9101';
    const userId = currentSession?.numericUserId;
    const url = userId != null
      ? `${base}/browser/recordings/${userId}%2F`
      : `${base}/browser/recordings`;
    void shell.openExternal(url);
  });

  ipcMain.on('account:open-log', () => {
    void shell.openPath(path.join(app.getPath('userData'), 'timesheet-debug.log'));
  });

  // ── IPC: biblioteca de grabaciones ──
  // El concat-service decide qué puede ver cada uno a partir del JWT: aquí solo
  // reenviamos la respuesta. Ocultar la pestaña en el cliente es cosmético.
  ipcMain.handle('recordings:list', async (_event, { all, q }: { all: boolean; q?: string }) => {
    const token = await getFreshAccessToken();
    if (!token) return { error: 'Sin sesión activa' };

    const base = process.env.UPLOAD_SERVICE_URL ?? 'http://192.168.1.175:9210';
    const params = new URLSearchParams();
    if (all) params.set('all', '1');
    if (q) params.set('q', q);
    const query = params.toString();

    try {
      const resp = await fetch(`${base}/recordings${query ? `?${query}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        return { error: `El servidor respondió ${resp.status}` };
      }
      return await resp.json();
    } catch (err) {
      log('[recordings] No se pudo listar:', err);
      return { error: 'No se pudo conectar con el servidor de grabaciones' };
    }
  });

  // Abre (o reutiliza) la ventana del reproductor con la grabación indicada.
  // El token va por query porque un <video src> no puede enviar cabeceras.
  ipcMain.handle('recordings:play', async (_event, rec: { userId: string; fecha: string; recId: string; userName?: string }) => {
    const token = await getFreshAccessToken();
    if (!token) return false;

    const base = process.env.UPLOAD_SERVICE_URL ?? 'http://192.168.1.175:9210';
    const url = `${base}/concat/${rec.userId}/${rec.fecha}/${rec.recId}?token=${encodeURIComponent(token)}`;

    if (!playerWindow || playerWindow.isDestroyed()) createPlayerWindow();

    const send = () => {
      playerWindow?.webContents.send('player:load', { rec, url });
      playerWindow?.show();
      playerWindow?.focus();
    };

    // Si la ventana acaba de crearse, esperar a que el HTML esté listo.
    if (playerWindow!.webContents.isLoading()) {
      playerWindow!.webContents.once('did-finish-load', send);
    } else {
      send();
    }
    return true;
  });

  // Abre el vídeo concatenado en el navegador. El token va por query porque
  // una pestaña del navegador no puede enviar cabeceras.
  ipcMain.handle('recordings:open', async (_event, r: { userId: string; fecha: string; recId: string; download?: boolean }) => {
    const token = await getFreshAccessToken();
    if (!token) return false;

    const base = process.env.UPLOAD_SERVICE_URL ?? 'http://192.168.1.175:9210';
    const params = new URLSearchParams({ token });
    if (r.download) params.set('download', '1');
    await shell.openExternal(`${base}/concat/${r.userId}/${r.fecha}/${r.recId}?${params}`);
    return true;
  });

  ipcMain.handle('account:get-autostart', () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle('account:toggle-autostart', () => {
    const next = !app.getLoginItemSettings().openAtLogin;
    app.setLoginItemSettings({ openAtLogin: next, name: 'Brainlabrecord' });
    log(`[account] Iniciar con Windows: ${next ? 'activado' : 'desactivado'}`);
    return next;
  });

  // El nivel de audio lo mide la ventana de captura (es la única que tiene el
  // stream). Lo reenviamos al panel y al dashboard para pintar el VU.
  ipcMain.on('capture-level', (_event, level: number) => {
    broadcast('capture:level', level);
  });

  app.on('window-all-closed', () => { /* keep running in tray */ });
  // El cierre de la grabación lo gestiona el before-quit de arriba, que SÍ
  // espera a que termine. El anterior llamaba a stopRecording() sin await y
  // Electron mataba el proceso antes de que el chunk llegara a escribirse.
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });

  const session = await loadSession();
  log('[session]', session ? `numericUserId=${session.numericUserId} email=${session.email}` : 'null');

  if (!session) {
    loginWindow?.show();
    return;
  }

  await connectWithSession(session);
}

bootstrap();
