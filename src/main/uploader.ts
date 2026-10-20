import fs from 'fs';
import path from 'path';
import { log } from './logger';
import { getFreshAccessToken } from './supabase';

interface ChunkJob {
  localPath: string;
  userId: string;
  fichajeId: string;
  chunkIndex: number;
  retries: number;
}

const MAX_RETRIES = 10;
const RETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

const queue: ChunkJob[] = [];
let retryTimer: NodeJS.Timeout | null = null;

// URL del concat-service que entrega las presigned URLs de subida.
// La app NO tiene credenciales de MinIO: se autentica con el JWT de Supabase
// y el servicio devuelve una URL firmada temporal para subir cada chunk.
function getUploadServiceUrl(): string {
  return process.env.UPLOAD_SERVICE_URL ?? 'http://192.168.1.175:9210';
}

export interface QueueChunkParams {
  localPath: string;
  userId: string;
  fichajeId: string;
  chunkIndex: number;
}

export function queueChunkForUpload(params: QueueChunkParams): void {
  const job: ChunkJob = { ...params, retries: 0 };
  queue.push(job);
  log(`[uploader] Chunk encolado: ${path.basename(params.localPath)}`);
  processQueue();
}

async function processQueue(): Promise<void> {
  if (queue.length === 0) return;

  const failed: ChunkJob[] = [];

  for (const job of queue) {
    const success = await uploadChunk(job);
    if (!success) {
      job.retries++;
      if (job.retries < MAX_RETRIES) {
        failed.push(job);
      } else {
        console.error(`[uploader] Chunk descartado tras ${MAX_RETRIES} intentos: ${job.localPath}`);
      }
    }
  }

  // Clear queue and re-add failed jobs
  queue.length = 0;
  queue.push(...failed);

  if (queue.length > 0) {
    scheduleRetry();
  }
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

function buildObjectName(job: ChunkJob): string {
  const date = new Date().toISOString().split('T')[0];
  const paddedIndex = String(job.chunkIndex + 1).padStart(3, '0');
  return `${job.userId}/${date}/${job.fichajeId}/chunk_${paddedIndex}.mp4`;
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
