import type { BrowserWindow as BW } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ipcMain, desktopCapturer, screen, app } = require('electron') as typeof import('electron');
import path from 'path';
import fs from 'fs';
import os from 'os';
import ffmpegStaticPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { queueChunkForUpload } from './uploader';
import { log } from './logger';
import { generateRecordingId, localDateStamp } from './session';

// Resuelve la ruta del binario de ffmpeg.
// - Empaquetado: ffmpeg-static apunta DENTRO del asar (no ejecutable). Usamos la
//   copia que electron-builder pone en resources/ffmpeg/ffmpeg.exe (extraResources).
// - Desarrollo: usamos directamente ffmpeg-static.
function resolveFfmpegPath(): string | null {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  }
  return ffmpegStaticPath;
}

// Recording config — adjustable via settings
export interface RecordingConfig {
  fps: number;
  width: number;
  height: number;
  crf: number;          // 18=high quality, 28=medium, 35=low
  chunkDurationSec: number;
  captureAudio: boolean;
  // Micrófono del empleado. Se graba en un canal distinto del audio del
  // sistema (ver capture.html): así una transcripción posterior puede separar
  // quién habla sin tener que distinguir las voces de oído.
  captureMic: boolean;
  // Fracción de la resolución nativa a la que se captura. 0.75 mantiene el
  // texto legible sin inflar el tamaño; 1 = nativa, 0.5 = la mitad.
  // Ahora es configurable desde el dashboard (antes era una constante).
  resolutionScale: number;
}

const DEFAULT_CONFIG: RecordingConfig = {
  fps: 5,
  // width/height son placeholders — applyResolutionScale() los sobrescribe al
  // arrancar con la resolución real de la pantalla por resolutionScale.
  width: 1920,
  height: 1080,
  crf: 26,
  chunkDurationSec: 600, // 10 minutes
  captureAudio: true, // audio del sistema (output) — para grabar meetings
  captureMic: true,   // voz del empleado — sin ella la transcripción solo
                      // recogería a la otra parte de la reunión
  resolutionScale: 0.75,
};

// Recalcula width/height a partir de la pantalla primaria y resolutionScale.
// Debe correr con la app ya lista (la API screen no existe antes).
// Las dimensiones se fuerzan pares, que es lo que exige H.264.
export function applyResolutionScale(): void {
  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    const scale = config.resolutionScale;
    const scaledW = Math.round((width * scale) / 2) * 2;
    const scaledH = Math.round((height * scale) / 2) * 2;
    config.width = scaledW;
    config.height = scaledH;
    log(`[recorder] Pantalla ${width}x${height} → captura a ${scaledW}x${scaledH} (${Math.round(scale * 100)}%)`);
  } catch (err) {
    log('[recorder] No se pudo detectar resolución, usando default:', err);
  }
}

let config: RecordingConfig = { ...DEFAULT_CONFIG };
let isRecording = false;
let currentRecId: string | null = null;
let currentUserId: string | null = null;
// Fecha de INICIO de la grabación, fijada una sola vez. Antes cada chunk
// calculaba su propia fecha, así que una grabación que cruzaba la medianoche
// repartía sus chunks entre dos carpetas y el concat-service solo encontraba
// la mitad de cada una.
let currentDateStamp: string | null = null;
let startedAtMs = 0;
// El micrófono se pidió pero no se pudo abrir. Lo consulta el estado para que
// la UI lo avise, en vez de grabar sin voz en silencio.
let micUnavailable = false;
let currentChunkIndex = 0;
let chunkTimer: NodeJS.Timeout | null = null;
let mainWindow: BW | null = null;

// Suscriptores a los cambios de estado (panel flotante, dashboard, bandeja).
export interface RecordingStatus {
  isRecording: boolean;
  recId: string | null;
  startedAtMs: number;
  elapsedSec: number;
  chunkIndex: number;
  micUnavailable: boolean;
}

type StatusListener = (status: RecordingStatus) => void;
const statusListeners: StatusListener[] = [];

export function onRecordingStatusChange(fn: StatusListener): void {
  statusListeners.push(fn);
}

// Fallo al arrancar la captura: la grabación no está ocurriendo.
type CaptureFailListener = (message: string) => void;
const captureFailListeners: CaptureFailListener[] = [];

export function onCaptureFailure(fn: CaptureFailListener): void {
  captureFailListeners.push(fn);
}

// Espacio libre en el disco donde se guardan los chunks temporales. Si se
// llena, FFmpeg falla y la grabación muere en silencio.
export function getFreeDiskBytes(): number | null {
  try {
    const stats = fs.statfsSync(TEMP_DIR);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export function getRecordingStatus(): RecordingStatus {
  return {
    isRecording,
    recId: currentRecId,
    startedAtMs,
    elapsedSec: isRecording ? Math.floor((Date.now() - startedAtMs) / 1000) : 0,
    chunkIndex: currentChunkIndex,
    micUnavailable,
  };
}

function emitStatus(): void {
  const status = getRecordingStatus();
  for (const fn of statusListeners) {
    try {
      fn(status);
    } catch (err) {
      log('[recorder] Error en listener de estado:', err);
    }
  }
}

// Temp dir for chunks waiting to be uploaded
const TEMP_DIR = path.join(os.tmpdir(), 'timesheet-chunks');

// El uploader la necesita para rescatar chunks de sesiones anteriores.
export function getTempDir(): string {
  return TEMP_DIR;
}

export function setRecordingConfig(partial: Partial<RecordingConfig>): void {
  const scaleChanged =
    partial.resolutionScale !== undefined &&
    partial.resolutionScale !== config.resolutionScale;

  config = { ...config, ...partial };

  // Cambiar la escala no sirve de nada por sí solo: lo que la captura usa son
  // width/height, así que hay que recalcularlos desde la pantalla.
  if (scaleChanged) applyResolutionScale();
}

export function getRecordingConfig(): RecordingConfig {
  return { ...config };
}

// Resolución nativa de la pantalla principal. El dashboard la necesita para
// recomendar un perfil y para avisar cuando una combinación se pasa de frenada:
// 30 fps es trivial en 1366x768 y una barbaridad en 5120x1440.
export function getScreenInfo(): { width: number; height: number } {
  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    return { width, height };
  } catch {
    return { width: 1920, height: 1080 };
  }
}

// Inicia una grabación bajo demanda. El id se genera aquí (ya no viene de un
// fichaje) y devuelve el recId para que la UI pueda mostrarlo.
export async function startRecording(userId: string, win: BW): Promise<string | null> {
  if (isRecording) return currentRecId;

  const now = new Date();
  isRecording = true;
  currentRecId = generateRecordingId(now);
  currentDateStamp = localDateStamp(now);
  currentUserId = userId;
  startedAtMs = now.getTime();
  currentChunkIndex = 0;
  micUnavailable = false;   // se vuelve a intentar en cada grabación
  mainWindow = win;

  fs.mkdirSync(TEMP_DIR, { recursive: true });

  log(`[recorder] Iniciando grabación ${currentRecId} — userId ${userId}`);
  emitStatus();
  await startChunk();
  return currentRecId;
}

export async function stopRecording(): Promise<void> {
  if (!isRecording) return;

  isRecording = false;

  if (chunkTimer) {
    clearTimeout(chunkTimer);
    chunkTimer = null;
  }

  // Stop current chunk and upload it
  await stopCurrentChunk();
  log('[recorder] Grabación detenida');
  emitStatus();
}

async function startChunk(): Promise<void> {
  if (!isRecording || !currentRecId || !currentUserId) return;

  const chunkPath = getChunkPath(currentUserId, currentRecId, currentChunkIndex);
  fs.mkdirSync(path.dirname(chunkPath), { recursive: true });

  // Ask renderer to start capturing via desktopCapturer
  log('[recorder] Enviando start-capture al renderer:', chunkPath);
  mainWindow?.webContents.send('start-capture', {
    chunkPath,
    config,
  });

  // Schedule end of this chunk
  chunkTimer = setTimeout(async () => {
    if (!isRecording) return;
    await rotateChunk();
  }, config.chunkDurationSec * 1000);
}

async function rotateChunk(): Promise<void> {
  const finishedPath = getChunkPath(currentUserId!, currentRecId!, currentChunkIndex);

  // Tell renderer to stop capture and save the blob
  mainWindow?.webContents.send('stop-capture');

  // Wait for renderer to confirm file is saved
  await waitForFile(finishedPath, 10_000);

  // Compress with FFmpeg
  const compressedPath = finishedPath.replace('.webm', '.mp4');
  await compressChunk(finishedPath, compressedPath);

  // Delete raw webm after compression
  fs.unlink(finishedPath, () => {});

  // Queue for upload
  queueChunkForUpload({
    localPath: compressedPath,
    userId: currentUserId!,
    recId: currentRecId!,
    dateStamp: currentDateStamp!,
    chunkIndex: currentChunkIndex,
  });

  currentChunkIndex++;
  emitStatus();
  await startChunk();
}

async function stopCurrentChunk(): Promise<void> {
  if (!currentRecId || !currentUserId) return;

  const rawPath = getChunkPath(currentUserId, currentRecId, currentChunkIndex);

  mainWindow?.webContents.send('stop-capture');

  try {
    await waitForFile(rawPath, 15_000);
    const compressedPath = rawPath.replace('.webm', '.mp4');
    await compressChunk(rawPath, compressedPath);
    fs.unlink(rawPath, () => {});

    queueChunkForUpload({
      localPath: compressedPath,
      userId: currentUserId,
      recId: currentRecId,
      dateStamp: currentDateStamp!,
      chunkIndex: currentChunkIndex,
    });
  } catch (err) {
    console.error('[recorder] Error al guardar último chunk:', err);
  }

  currentRecId = null;
  currentUserId = null;
  currentDateStamp = null;
  startedAtMs = 0;
  currentChunkIndex = 0;
}

function compressChunk(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      reject(new Error(`ffmpeg no encontrado en: ${ffmpegPath}`));
      return;
    }

    ffmpeg.setFfmpegPath(ffmpegPath);

    const command = ffmpeg(inputPath)
      // -fflags +genpts + -reset_timestamps regenerate clean timestamps from 0.
      // MediaRecorder's desktop audio stream starts at a huge base timestamp
      // (system clock), which otherwise inflates the reported duration and
      // breaks concatenation. Applied as INPUT options.
      .inputOptions(['-fflags', '+genpts'])
      .videoCodec('libx264')
      .outputOptions([
        `-crf ${config.crf}`,
        `-r ${config.fps}`,
        // veryfast (not ultrafast) gives noticeably sharper output at the same CRF.
        // At 5fps with batch compression every 10 min, the CPU cost is negligible.
        '-preset veryfast',
        '-movflags +faststart',
        // Force clean output timestamps starting at 0 (avoids inflated duration).
        '-reset_timestamps', '1',
        '-avoid_negative_ts', 'make_zero',
        // -2 keeps dimensions even (required by H.264) while preserving aspect ratio.
        '-vf', `scale=${config.width}:-2`,
      ]);

    if (config.captureAudio) {
      // Re-encode the Opus audio from the webm to AAC for MP4 compatibility.
      command.audioCodec('aac').audioBitrate('128k');
    } else {
      // No audio track expected — tell ffmpeg not to look for one.
      command.noAudio();
    }

    command
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// Usa currentDateStamp (fijado al iniciar), no la fecha de ahora: si no, una
// grabación que cruza la medianoche partiría sus chunks en dos carpetas.
function getChunkPath(userId: string, recId: string, index: number): string {
  const paddedIndex = String(index + 1).padStart(3, '0');
  return path.join(TEMP_DIR, userId, currentDateStamp!, recId, `chunk_${paddedIndex}.webm`);
}

function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout esperando archivo: ${filePath}`));
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

// Called once from index.ts after app is ready
export function initRecorderIPC(): void {
  // Calcular width/height ahora que la API screen ya está disponible
  applyResolutionScale();

  // desktopCapturer only works in the main process (Electron 17+).
  // The renderer requests the screen source id through this handler.
  ipcMain.handle('get-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.map((s) => ({ id: s.id, name: s.name }));
  });

  ipcMain.on('capture-saved', (_event, filePath: string) => {
    log('[recorder] Chunk guardado por renderer:', filePath);
  });

  // El micrófono falló (sin permiso, sin dispositivo, en uso por otra app).
  // La grabación continúa sin voz, pero hay que avisar: si no, el empleado
  // descubre que falta su audio cuando ya es tarde.
  ipcMain.on('capture-mic-error', (_event, message: string) => {
    log('[recorder] Micrófono no disponible:', message);
    micUnavailable = true;
  });

  // La captura no arrancó: sin esto la app seguiría marcando "Grabando" con
  // el cronómetro corriendo mientras no se graba absolutamente nada, y el
  // empleado lo descubriría al terminar.
  ipcMain.on('capture-error', (_event, message: string) => {
    console.error('[recorder] Error en renderer:', message);
    for (const fn of captureFailListeners) {
      try {
        fn(message);
      } catch (err) {
        log('[recorder] Error en listener de fallo de captura:', err);
      }
    }
  });

  ipcMain.on('capture-debug', (_event, message: string) => {
    log('[renderer]', message);
  });
}
