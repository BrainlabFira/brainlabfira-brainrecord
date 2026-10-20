import fs from 'fs';
import path from 'path';
import { log } from './logger';
import { getFreshAccessToken } from './supabase';

interface ChunkJob {
  localPath: string;
  userId: string;
  recId: string;
  dateStamp: string;
  chunkIndex: number;
  retries: number;
}

const MAX_RETRIES = 10;
const RETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

const queue: ChunkJob[] = [];
let retryTimer: NodeJS.Timeout | null = null;
let uploadingNow = 0;
let uploadedTotal = 0;
let failedTotal = 0;

// Estado agregado de la cola, para el semáforo del panel flotante y el
// dashboard. 'ok' = todo subido, 'uploading' = hay trabajo en curso,
// 'failing' = algún chunk ya ha fallado y está esperando reintento.
export type UploadHealth = 'ok' | 'uploading' | 'failing';

export interface UploadStatus {
  health: UploadHealth;
  pending: number;
  uploading: number;
  uploaded: number;
  failed: number;
}

type UploadListener = (status: UploadStatus) => void;
const uploadListeners: UploadListener[] = [];

export function onUploadStatusChange(fn: UploadListener): void {
  uploadListeners.push(fn);
}

export function getUploadStatus(): UploadStatus {
  const anyRetrying = queue.some((j) => j.retries > 0);
  const health: UploadHealth = anyRetrying
    ? 'failing'
    : queue.length > 0 || uploadingNow > 0
      ? 'uploading'
      : 'ok';
  return {
    health,
    pending: queue.length,
    uploading: uploadingNow,
    uploaded: uploadedTotal,
    failed: failedTotal,
  };
}

function emitUploadStatus(): void {
  const status = getUploadStatus();
  for (const fn of uploadListeners) {
    try {
      fn(status);
    } catch (err) {
      log('[uploader] Error en listener de estado:', err);
    }
  }
}

// Al terminar una grabación el contador de subidos debe volver a cero, o el
// dashboard mostraría acumulado de toda la sesión de la app.
export function resetUploadCounters(): void {
  uploadedTotal = 0;
  failedTotal = 0;
  emitUploadStatus();
}

// URL del concat-service que entrega las presigned URLs de subida.
// La app NO tiene credenciales de MinIO: se autentica con el JWT de Supabase
// y el servicio devuelve una URL firmada temporal para subir cada chunk.
function getUploadServiceUrl(): string {
  return process.env.UPLOAD_SERVICE_URL ?? 'http://192.168.1.175:9210';
}

export interface QueueChunkParams {
  localPath: string;
  userId: string;
  recId: string;
  dateStamp: string;
  chunkIndex: number;
}

export function queueChunkForUpload(params: QueueChunkParams): void {
  const job: ChunkJob = { ...params, retries: 0 };
  queue.push(job);
  log(`[uploader] Chunk encolado: ${path.basename(params.localPath)}`);
  emitUploadStatus();
  processQueue();
}

async function processQueue(): Promise<void> {
  if (queue.length === 0) return;

  const failed: ChunkJob[] = [];

  for (const job of queue) {
    uploadingNow++;
    emitUploadStatus();
    const success = await uploadChunk(job);
    uploadingNow--;

    if (success) {
      uploadedTotal++;
    } else {
      job.retries++;
      if (job.retries < MAX_RETRIES) {
        failed.push(job);
      } else {
        failedTotal++;
        console.error(`[uploader] Chunk descartado tras ${MAX_RETRIES} intentos: ${job.localPath}`);
      }
    }
    emitUploadStatus();
  }

  // Clear queue and re-add failed jobs
  queue.length = 0;
  queue.push(...failed);

  if (queue.length > 0) {
    scheduleRetry();
  }
  emitUploadStatus();
}

async function uploadChunk(job: ChunkJob): Promise<boolean> {
  if (!fs.existsSync(job.localPath)) {
    log(`[uploader] Archivo no encontrado: ${job.localPath}`);
    return true; // Don't retry missing files
  }

  const objectName = buildObjectName(job);

  try {
    // 1. Token vigente del empleado (Supabase lo refresca si caducó)
    const token = await getFreshAccessToken();
    if (!token) {
      console.error('[uploader] No hay token de sesión — no se puede subir');
      return false;
    }

    // 2. Pedir presigned URL al concat-service
    const presignResp = await fetch(`${getUploadServiceUrl()}/upload-url`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ objectName }),
    });

    if (!presignResp.ok) {
      const detail = await presignResp.text();
      console.error(`[uploader] No se pudo obtener URL de subida (${presignResp.status}): ${detail}`);
      return false;
    }

    const { url } = (await presignResp.json()) as { url: string };

    // 3. Subir el chunk directamente a la presigned URL (PUT, sin credenciales)
    const fileBuffer = fs.readFileSync(job.localPath);
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: fileBuffer,
    });

    if (!putResp.ok) {
      console.error(`[uploader] Fallo al subir ${objectName} (PUT ${putResp.status})`);
      return false;
    }

    log(`[uploader] Subido: ${objectName}`);
    fs.unlink(job.localPath, () => {});
    return true;
  } catch (err) {
    console.error(`[uploader] Error al subir ${objectName} (intento ${job.retries + 1}):`, err);
    return false;
  }
}

// La fecha viene del job (fijada al INICIAR la grabación), no de new Date().
// Antes se calculaba al subir: un chunk encolado a las 23:58 y subido tras un
// reintento a las 00:05 acababa en la carpeta del día siguiente, separado del
// resto de la grabación, y el concat-service solo encontraba una parte.
function buildObjectName(job: ChunkJob): string {
  const paddedIndex = String(job.chunkIndex + 1).padStart(3, '0');
  return `${job.userId}/${job.dateStamp}/${job.recId}/chunk_${paddedIndex}.mp4`;
}

function scheduleRetry(): void {
  if (retryTimer) return; // Already scheduled

  retryTimer = setTimeout(() => {
    retryTimer = null;
    log(`[uploader] Reintentando ${queue.length} chunks pendientes...`);
    processQueue();
  }, RETRY_INTERVAL_MS);
}

export function getPendingCount(): number {
  return queue.length;
}

// Recupera chunks que quedaron en disco sin subir (corte de luz, cierre
// forzado, caída de red al final de la jornada). Se llama al arrancar: si no,
// esos ficheros se quedan en el temporal para siempre y la grabación se pierde
// aunque el vídeo esté completo.
//
// La ruta codifica todo lo necesario, así que se puede reconstruir el job sin
// guardar estado aparte:
//   {TEMP_DIR}/{userId}/{fecha}/{recId}/chunk_NNN.mp4
export function recoverPendingChunks(tempDir: string): number {
  if (!fs.existsSync(tempDir)) return 0;

  let recovered = 0;

  for (const userId of safeReaddir(tempDir)) {
    for (const dateStamp of safeReaddir(path.join(tempDir, userId))) {
      for (const recId of safeReaddir(path.join(tempDir, userId, dateStamp))) {
        const dir = path.join(tempDir, userId, dateStamp, recId);

        for (const file of safeReaddir(dir)) {
          const full = path.join(dir, file);

          // Los .webm son material intermedio sin comprimir: su .mp4 o bien ya
          // existe, o bien el proceso murió a mitad y el webm puede estar
          // truncado. No se suben.
          if (!file.endsWith('.mp4')) continue;

          const match = /^chunk_(\d+)\.mp4$/.exec(file);
          if (!match) continue;

          try {
            if (fs.statSync(full).size === 0) continue;
          } catch {
            continue;
          }

          queue.push({
            localPath: full,
            userId,
            recId,
            dateStamp,
            // El nombre está en base 1 y chunkIndex en base 0.
            chunkIndex: Number(match[1]) - 1,
            retries: 0,
          });
          recovered++;
        }
      }
    }
  }

  if (recovered > 0) {
    log(`[uploader] Recuperados ${recovered} chunk(s) de una sesión anterior`);
    emitUploadStatus();
    processQueue();
  }

  return recovered;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
