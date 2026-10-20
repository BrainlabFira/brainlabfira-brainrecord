import type { BrowserWindow as BW } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow, ipcMain, Notification, globalShortcut, screen } =
  require('electron') as typeof import('electron');
import path from 'path';
import { loadEnv } from './env';
import { initTray, updateTrayState } from './tray';
import {
  initSupabase,
  InvalidSessionError,
  resetSupabaseSession,
  getCurrentUserEmail,
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
  RecordingConfig,
} from './recorder';
import {
  onUploadStatusChange,
  getUploadStatus,
  resetUploadCounters,
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

let currentSession: SessionData | null = null;
// Atajos que el sistema rechazó porque otra app ya los tenía registrados.
// Se muestran en el dashboard: si no, el empleado pulsa y no pasa nada.
const failedShortcuts: string[] = [];

function rendererPath(file: string): string {
  return path.join(__dirname, '../renderer', file);
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
    skipTaskbar: true,
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
    height: 700,
    show: false,
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

function showNotification(title: string, body: string): void {
  new Notification({ title, body }).show();
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

function openDashboard(): void {
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

  resetUploadCounters();
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

async function toggleRecording(): Promise<void> {
  if (getRecordingStatus().isRecording) {
    await handleStopRecording();
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

function togglePanelVisibility(): void {
  if (!getRecordingStatus().isRecording) return; // el panel solo existe grabando
  if (!panelWindow) return;
  if (panelWindow.isVisible()) {
    panelWindow.hide();
  } else {
    panelWindow.show();
  }
}

// El panel cambia de tamaño al minimizarse: pasa de la barra completa a solo
// el punto REC. La altura la decide el renderer y la pide por IPC.
function resizePanel(width: number, height: number): void {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const [x, y] = panelWindow.getPosition();
  panelWindow.setBounds({ x, y, width, height });
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

  app.setLoginItemSettings({ openAtLogin: true, name: 'Brainlabrecord' });
  registerShortcuts();

  // Propagar estado a las ventanas de UI. El panel y el dashboard se pintan
  // a partir de estos eventos en vez de preguntar en bucle.
  onRecordingStatusChange((status) => { broadcast('recording:status', status); });
  onUploadStatusChange((status) => { broadcast('upload:status', status); });

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

  // El nivel de audio lo mide la ventana de captura (es la única que tiene el
  // stream). Lo reenviamos al panel y al dashboard para pintar el VU.
  ipcMain.on('capture-level', (_event, level: number) => {
    broadcast('capture:level', level);
  });

  app.on('window-all-closed', () => { /* keep running in tray */ });
  app.on('before-quit', async () => { await stopRecording(); });
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
