import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { SessionData, saveSession } from './auth';
import { log } from './logger';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket = require('ws');

interface FichajeCallbacks {
  onFichar: (fichajeId: number) => Promise<void>;
  onDesfichar: () => Promise<void>;
}

interface FichajeRow {
  id: number;
  user_id: number;
  start_time: string;
  end_time: string | null;
}

let supabase: SupabaseClient | null = null;
let channel: RealtimeChannel | null = null;
// Consecutive polls that returned "no open fichaje" while recording was active.
// We require 2 in a row before stopping, to avoid false stops from a single
// network glitch / timeout returning null.
let emptyPollStreak = 0;
let pollingInterval: NodeJS.Timeout | null = null;

// Guardamos los tokens en memoria porque persistSession:false hace que
// getSession() devuelva null. El access_token caduca (~1h); lo refrescamos
// manualmente con el refresh_token cuando se acerca su expiración.
let currentAccessToken: string | null = null;
let currentRefreshToken: string | null = null;
let accessTokenExpiresAt = 0; // epoch seconds

// Sesión completa (incluye authUserId/numericUserId/email) para poder reescribir
// el fichero de sesión entero cada vez que rotan los tokens.
let currentSession: SessionData | null = null;

// Supabase rota el refresh_token en cada refresco: el token usado queda muerto.
// Si sólo guardásemos los tokens en memoria, el fichero de disco conservaría el
// refresh_token del login y, al reiniciar el PC, ese token ya invalidado haría
// fallar la validación de arranque → login manual en cada reinicio. Por eso
// persistimos la sesión tras CADA refresco exitoso.
async function persistTokens(accessToken: string, refreshToken: string, expiresAt: number): Promise<void> {
  currentAccessToken = accessToken;
  currentRefreshToken = refreshToken;
  accessTokenExpiresAt = expiresAt;

  if (!currentSession) return;
  currentSession = { ...currentSession, accessToken, refreshToken };
  try {
    await saveSession(currentSession);
  } catch (err) {
    // No es fatal: seguimos con los tokens en memoria. El siguiente refresco
    // exitoso reintentará la escritura.
    log('[supabase] No se pudo persistir la sesión refrescada:', err);
  }
}

// Error específico de sesión inválida/caducada, para que el arranque distinga
// "no se pudo validar la sesión" (→ pedir login) de otros fallos de red.
export class InvalidSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionError';
  }
}

export async function initSupabase(session: SessionData): Promise<void> {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_ANON_KEY ?? '';

  if (!url) throw new Error('SUPABASE_URL no está definida en el .env');
  if (!key) throw new Error('SUPABASE_ANON_KEY no está definida en el .env');

  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });

  currentSession = session;

  await supabase.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });

  // VALIDACIÓN REAL al arrancar: refrescamos la sesión contra Supabase. setSession
  // no comprueba si el refresh_token sigue vivo — solo guarda los tokens. Sin esta
  // validación, un refresh_token caducado dejaría la app "logueada" en apariencia
  // pero sin poder subir chunks (fallo silencioso). Si el refresh falla, lanzamos
  // InvalidSessionError para que el arranque borre la sesión y muestre el login.
  let data, error;
  try {
    ({ data, error } = await supabase.auth.refreshSession({
      refresh_token: session.refreshToken,
    }));
  } catch (netErr) {
    // Error de red (arranque sin internet): NO invalidamos la sesión. Reutilizamos
    // los tokens guardados y dejamos que se reintente cuando haya conexión.
    log('[supabase] Sin conexión al validar sesión, reusando tokens guardados:', netErr);
    currentAccessToken = session.accessToken;
    currentRefreshToken = session.refreshToken;
    accessTokenExpiresAt = 0;
    return;
  }

  if (error) {
    // Distinguir token muerto (→ pedir login) de otros errores del servidor.
    const msg = error.message ?? '';
    if (/refresh token|invalid|expired|not found/i.test(msg)) {
      throw new InvalidSessionError(msg);
    }
    // Otro error de servidor: reusar tokens y seguir (se reintentará al subir).
    log('[supabase] Error no fatal al validar sesión, reusando tokens:', msg);
    currentAccessToken = session.accessToken;
    currentRefreshToken = session.refreshToken;
    accessTokenExpiresAt = 0;
    return;
  }

  if (!data.session) {
    throw new InvalidSessionError('Supabase no devolvió sesión al refrescar');
  }

  await persistTokens(
    data.session.access_token,
    data.session.refresh_token,
    data.session.expires_at ?? 0
  );
}

// Devuelve un access_token vigente para autenticarse ante el concat-service.
// Refresca proactivamente si quedan <60s para que caduque.
export async function getFreshAccessToken(): Promise<string | null> {
  if (!supabase || !currentRefreshToken) return currentAccessToken;

  const nowSec = Math.floor(Date.now() / 1000);
  if (accessTokenExpiresAt && nowSec < accessTokenExpiresAt - 60) {
    return currentAccessToken; // aún válido
  }

  // Caducado o a punto de caducar → refrescar
  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: currentRefreshToken,
  });
  if (error || !data.session) {
    console.error('[supabase] No se pudo refrescar el token:', error?.message);
    return currentAccessToken; // devolvemos el viejo por si aún sirve
  }

  await persistTokens(
    data.session.access_token,
    data.session.refresh_token,
    data.session.expires_at ?? 0
  );
  return currentAccessToken;
}

// numericUserId: the bigint id from the fichajes table (NOT the Supabase auth UUID)
export function subscribeToFichajes(numericUserId: number, callbacks: FichajeCallbacks): void {
  if (!supabase) throw new Error('Supabase no inicializado');

  let activeFichajeId: number | null = null;

  channel = supabase
    .channel(`fichajes-user-${numericUserId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'fichajes',
        filter: `user_id=eq.${numericUserId}`,
      },
      (payload) => {
        const row = payload.new as FichajeRow;
        // Only react if no active fichaje already open
        if (!activeFichajeId) {
          activeFichajeId = row.id;
          callbacks.onFichar(row.id);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'fichajes',
        filter: `user_id=eq.${numericUserId}`,
      },
      (payload) => {
        const row = payload.new as FichajeRow;
        if (row.end_time && row.id === activeFichajeId) {
          activeFichajeId = null;
          callbacks.onDesfichar();
        }
      }
    )
    .subscribe((status) => {
      log('[supabase] Realtime status:', status, '| filtro user_id=', numericUserId);
      if (status === 'SUBSCRIBED') {
        // Start polling fallback immediately to catch any already-open fichaje
        startPollingFallback(
          numericUserId,
          callbacks,
          () => activeFichajeId,
          (id) => { activeFichajeId = id; }
        );
      }
    });
}

function startPollingFallback(
  numericUserId: number,
  callbacks: FichajeCallbacks,
  getActiveId: () => number | null,
  setActiveId: (id: number | null) => void
): void {
  if (pollingInterval) clearInterval(pollingInterval);

  // Run immediately on start to detect open fichajes before first Realtime event
  checkOpenFichaje(numericUserId, callbacks, getActiveId, setActiveId);

  pollingInterval = setInterval(() => {
    checkOpenFichaje(numericUserId, callbacks, getActiveId, setActiveId);
  }, 30_000);
}

async function checkOpenFichaje(
  numericUserId: number,
  callbacks: FichajeCallbacks,
  getActiveId: () => number | null,
  setActiveId: (id: number | null) => void
): Promise<void> {
  if (!supabase) return;

  const { data, error } = await supabase
    .from('fichajes')
    .select('id, start_time, end_time')
    .eq('user_id', numericUserId)
    .is('end_time', null)
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[supabase] Error en polling:', error.message);
    return;
  }

  log('[supabase] Polling — fichaje abierto:', data ? `id=${data.id}` : 'ninguno', '| activo actual=', getActiveId(), '| rachaVacia=', emptyPollStreak);

  if (!data) {
    // No open fichaje in this poll.
    if (getActiveId() !== null) {
      // We were recording. Require 2 consecutive empty polls before stopping,
      // so a single network glitch / timeout returning null doesn't kill recording.
      emptyPollStreak++;
      if (emptyPollStreak >= 2) {
        log('[supabase] Desfichaje confirmado tras 2 polls vacíos — deteniendo grabación');
        emptyPollStreak = 0;
        setActiveId(null);
        callbacks.onDesfichar();
      } else {
        log('[supabase] Poll vacío 1/2 mientras grababa — ignorando (posible glitch)');
      }
    }
    return;
  }

  // Open fichaje found — reset the empty streak
  emptyPollStreak = 0;
  if (getActiveId() === null) {
    setActiveId(data.id);
    callbacks.onFichar(data.id);
  }
}

// Cierra la sesión en memoria. Debe llamarse SIEMPRE que se borre session.enc:
// si no, un refresco en vuelo (p.ej. una subida pendiente) volvería a escribir el
// fichero con persistTokens y resucitaría la sesión que acabamos de borrar.
export function resetSupabaseSession(): void {
  unsubscribeFromFichajes();
  currentSession = null;
  currentAccessToken = null;
  currentRefreshToken = null;
  accessTokenExpiresAt = 0;
  emptyPollStreak = 0;
  supabase = null;
}

export function unsubscribeFromFichajes(): void {
  if (channel) {
    channel.unsubscribe();
    channel = null;
  }
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
