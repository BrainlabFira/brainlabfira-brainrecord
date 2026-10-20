import type { BrowserWindow as BW } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow, ipcMain, Notification } = require('electron') as typeof import('electron');
import path from 'path';
import { loadEnv } from './env';
import { initTray, updateTrayState } from './tray';
import { initSupabase, subscribeToFichajes, InvalidSessionError, resetSupabaseSession } from './supabase';
import { startRecording, stopRecording, initRecorderIPC } from './recorder';
import { loadSession, saveSession, clearSession, SessionData } from './auth';
import { log, initLogPath } from './logger';

loadEnv();

const _origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  log('[ERROR]', ...args);
  _origError(...args);
};
process.on('uncaughtException', (err) => { log('[UNCAUGHT]', err); });
process.on('unhandledRejection', (reason) => { log('[UNHANDLED REJECTION]', reason); });

let hiddenWindow: BW | null = null;

function createHiddenWindow(): void {
  hiddenWindow = new BrowserWindow({
    width: 440,
    height: 560,
    show: false,
    skipTaskbar: true,
    frame: false,            // sin barra de título ni menú de Windows
    transparent: true,       // fondo transparente para el efecto glass
    resizable: false,
    center: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  hiddenWindow.setMenuBarVisibility(false);
  hiddenWindow.loadFile(path.join(__dirname, '../renderer/login.html'));
  hiddenWindow.on('closed', () => { hiddenWindow = null; });
}

function showNotification(title: string, body: string): void {
  new Notification({ title, body }).show();
}

async function connectWithSession(session: SessionData): Promise<void> {
  try {
    await initSupabase(session);
    subscribeToFichajes(session.numericUserId, {
      onFichar: async (fichajeId: number) => {
        // Grabación silenciosa: sin notificación al iniciar (el estado se refleja
        // solo en el icono de la bandeja). La transparencia legal se cubre por
        // contrato/política interna, no por notificación.
        updateTrayState('recording');
        await startRecording(String(fichajeId), String(session.numericUserId), hiddenWindow!);
      },
      onDesfichar: async () => {
        await stopRecording();
        updateTrayState('idle');
      },
    });
    updateTrayState('idle');
  } catch (err) {
    // Sesión inválida/caducada (p.ej. refresh token muerto tras mucho tiempo):
    // borramos la sesión y mostramos el login, en vez de quedar "logueado" pero
    // sin grabar (fallo silencioso). Así el empleado ve que debe volver a entrar.
    if (err instanceof InvalidSessionError) {
      log('[AUTH] Sesión inválida al arrancar — pidiendo login:', err.message);
      await stopRecording();
      resetSupabaseSession();
      await clearSession();
      updateTrayState('idle');
      hiddenWindow?.show();
      hiddenWindow?.focus();
      return;
    }

    // Otros errores (red, servidor): mantenemos la sesión y marcamos error.
    const msg = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err);
    log('[ERROR] connectWithSession falló:', msg);
    log('[ENV] SUPABASE_URL =', process.env.SUPABASE_URL ?? '(vacío)');
    log('[ENV] SUPABASE_ANON_KEY =', process.env.SUPABASE_ANON_KEY ? '(presente)' : '(vacío)');
    showNotification('Brainlabrecord — Error', 'No se pudo conectar con el servidor');
    updateTrayState('error');
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Logout reutilizable: para grabación, borra la sesión guardada y muestra el
  // login. Lo usa el IPC 'logout' (desde el renderer) y el menú de la bandeja.
  // Al reasignar el PC, quien lo haga cierra sesión y el siguiente empleado ve
  // el login limpio.
  async function doLogout(): Promise<void> {
    await stopRecording();
    resetSupabaseSession();
    await clearSession();
    updateTrayState('idle');
    hiddenWindow?.show();
    hiddenWindow?.focus();
  }

  initRecorderIPC();
  createHiddenWindow();
  initTray(hiddenWindow!, doLogout);

  app.setLoginItemSettings({ openAtLogin: true, name: 'Brainlabrecord' });

  ipcMain.on('session-ready', async (_event, session: SessionData) => {
    await saveSession(session);
    hiddenWindow?.hide();
    await connectWithSession(session);
  });

  ipcMain.on('logout', () => { void doLogout(); });

  // La ventana no tiene frame nativo: el botón de cerrar del HTML la oculta
  // (la app sigue en la bandeja, no se cierra del todo).
  ipcMain.on('window-close', () => {
    hiddenWindow?.hide();
  });

  app.on('window-all-closed', () => { /* keep running in tray */ });
  app.on('before-quit', async () => { await stopRecording(); });

  initLogPath();
  log('=== TimeSheet Desktop arrancando ===');
  log('[ENV] SUPABASE_URL =', process.env.SUPABASE_URL ?? '(vacío)');
  log('[ENV] SUPABASE_ANON_KEY =', process.env.SUPABASE_ANON_KEY ? '(presente)' : '(vacío)');
  log('[userData]', app.getPath('userData'));

  const session = await loadSession();
  log('[session]', session ? `numericUserId=${session.numericUserId} email=${session.email}` : 'null');

  if (!session) {
    hiddenWindow?.show();
    return;
  }

  await connectWithSession(session);
}

bootstrap();
