import { createHash } from 'crypto';

export interface RecordingRef {
  userId: string; fecha: string; recId: string; chunks: number; bytes: number;
}
export interface TranscriptionState {
  status: string; percent?: number; eta_seconds?: number | null;
  error?: string; worker_online?: boolean; jobId?: string;
}
interface Snapshot {
  job: { id: string; status: string; error?: string };
  percent: number; eta_seconds: number | null; worker_online: boolean;
}
export interface TranscriptionConfig { apiUrl: string; publicUrl: string; key: string; recordingUrl: string }

export function validateRecording(rec: RecordingRef): void {
  if (!rec || ![rec.userId, rec.fecha, rec.recId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v))
      || !Number.isSafeInteger(rec.chunks) || rec.chunks < 1 || !Number.isSafeInteger(rec.bytes) || rec.bytes < 1) {
    throw new Error('Referencia de grabación inválida');
  }
}

export function recordingKey(rec: RecordingRef): string {
  return JSON.stringify([rec.userId, rec.fecha, rec.recId, rec.chunks, rec.bytes]);
}

export function transcriptionSource(actor: string, rec: RecordingRef, config: TranscriptionConfig): string {
  validateRecording(rec);
  return createHash('sha256').update(JSON.stringify([config.recordingUrl.replace(/\/$/, ''), actor, recordingKey(rec)])).digest('hex');
}

export function transcriptUrl(config: TranscriptionConfig, jobId: string): string {
  if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error('Identificador de transcripción inválido');
  const url = new URL(config.publicUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL de Transcriptor inválida');
  url.pathname = '/'; url.search = new URLSearchParams({ recording: jobId }).toString(); url.hash = '';
  return url.toString();
}

// No Electron dependency: exercise the real streaming bridge against isolated HTTP servers.
export class TranscriptionClient {
  private states = new Map<string, { state: TranscriptionState; checked: number }>();
  private tasks = new Map<string, Promise<TranscriptionState>>();
  constructor(private changed: (actor: string, rec: RecordingRef, state: TranscriptionState) => void) {}

  private save(source: string, actor: string, rec: RecordingRef, state: TranscriptionState): TranscriptionState {
    this.states.set(source, { state, checked: Date.now() });
    this.changed(actor, rec, state);
    return state;
  }

  private endpoint(config: TranscriptionConfig, source: string): string {
    if (!config.key) throw new Error('Configura TRANSCRIPTOR_API_KEY y BRAINRECORD_API_KEY con el mismo valor');
    const url = new URL(config.apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL de Transcriptor inválida');
    return new URL(`/api/integrations/brainrecord/${source}`, url).toString();
  }

  private async response(response: Response): Promise<TranscriptionState> {
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { detail?: string };
      throw new Error(typeof data.detail === 'string' ? data.detail : `Transcriptor respondió ${response.status}`);
    }
    const data = await response.json() as Snapshot;
    if (!data.job || !/^[a-f0-9]{32}$/.test(data.job.id)) throw new Error('Respuesta de Transcriptor inválida');
    return { status: data.job.status, jobId: data.job.id, error: data.job.error,
      percent: data.percent, eta_seconds: data.eta_seconds, worker_online: data.worker_online };
  }

  async status(actor: string, rec: RecordingRef, config: TranscriptionConfig, force = false): Promise<TranscriptionState> {
    const source = transcriptionSource(actor, rec, config);
    const cached = this.states.get(source);
    if (this.tasks.has(source)) return cached?.state ?? { status: 'preparing' };
    const ttl = cached?.state.status === 'idle' || cached?.state.status === 'completed' ? 60000 : 4000;
    if (!force && cached && Date.now() - cached.checked < ttl) return cached.state;
    try {
      const response = await fetch(this.endpoint(config, source), {
        headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      return this.save(source, actor, rec, response.status === 404 ? { status: 'idle' } : await this.response(response));
    } catch (error) {
      // Preserve the saved association after temporary outages. Retry looks it up before uploading.
      return this.save(source, actor, rec, { ...cached?.state, status: 'connection_error', error: (error as Error).message });
    }
  }

  start(actor: string, rec: RecordingRef, config: TranscriptionConfig, token: () => Promise<string | null>): Promise<TranscriptionState> {
    const source = transcriptionSource(actor, rec, config);
    const existing = this.tasks.get(source);
    if (existing) return existing;
    const task = this.submit(actor, rec, config, token, source).finally(() => this.tasks.delete(source));
    this.tasks.set(source, task);
    return task;
  }

  private async submit(actor: string, rec: RecordingRef, config: TranscriptionConfig, token: () => Promise<string | null>, source: string): Promise<TranscriptionState> {
    let media: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const endpoint = this.endpoint(config, source);
      // Status lookup must succeed before transfer, preventing duplicates after lost responses/restarts.
      const previous = await this.status(actor, rec, config, true);
      if (previous.status === 'connection_error') throw new Error(previous.error);
      if (previous.status !== 'idle') {
        if (['failed', 'cancelled'].includes(previous.status)) {
          const result = await fetch(endpoint + '/retry', { method: 'POST', headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
          return this.save(source, actor, rec, await this.response(result));
        }
        return previous;
      }
      this.save(source, actor, rec, { status: 'preparing' });
      const accessToken = await token();
      if (!accessToken) throw new Error('Sin sesión activa');
      const url = new URL(`/concat/${rec.userId}/${rec.fecha}/${rec.recId}`, config.recordingUrl);
      // Same authenticated route used by Play/Download. Tokens never reach Transcriptor.
      url.searchParams.set('token', accessToken);
      timer = setTimeout(() => controller.abort(), 2 * 60 * 60 * 1000);
      media = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!media.ok || !media.body) throw new Error(`No se pudo preparar el vídeo (${media.status})`);
      const total = Number(media.headers.get('content-length'));
      const client = this;
      let sent = 0, emitted = 0;
      const body = media.body;
      async function* stream() {
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          sent += chunk.byteLength;
          if (Date.now() - emitted > 250) {
            client.save(source, actor, rec, { status: 'uploading', percent: total > 0 ? Math.min(99, Math.floor(sent / total * 100)) : undefined });
            emitted = Date.now();
          }
          yield chunk;
        }
        client.save(source, actor, rec, { status: 'validating' });
      }
      const options = { method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/octet-stream' },
        body: stream(), duplex: 'half', signal: controller.signal, redirect: 'error' } as unknown as RequestInit;
      const response = await fetch(endpoint + '?filename=' + encodeURIComponent(rec.recId + '.mp4'), options);
      return this.save(source, actor, rec, await this.response(response));
    } catch (error) {
      return this.save(source, actor, rec, { status: 'connection_error', error: (error as Error).message });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      await media?.body?.cancel().catch(() => {});
    }
  }
}
