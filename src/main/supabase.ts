// Este módulo solo gestiona AUTENTICACIÓN: validar la sesión al arrancar y
// mantener vivo un access_token para firmar las subidas contra el concat-service.
//
// Ya NO lee la tabla `fichajes`. Antes la app se suscribía por Realtime y hacía
// polling cada 30s para arrancar a grabar en cuanto el empleado fichaba. Eso se
// eliminó: la grabación la inicia el empleado desde el dashboard o con Ctrl+Alt+R,
// así que la app no necesita saber nada de su presencia.
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SessionData, saveSession } from './auth';
import { log } from './logger';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket = require('ws');

let supabase: SupabaseClient | null = null;

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

  // `transport: WebSocket` sigue siendo obligatorio aunque ya no usemos
  // Realtime: createClient instancia un RealtimeClient en el constructor, y en
  // Node 20 (el de Electron 33) no hay WebSocket nativo, así que lanza
  // "Node.js 20 detected without native WebSocket support" y la app no conecta.
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

// Cierra la sesión en memoria. Debe llamarse SIEMPRE que se borre session.enc:
// si no, un refresco en vuelo (p.ej. una subida pendiente) volvería a escribir el
// fichero con persistTokens y resucitaría la sesión que acabamos de borrar.
export function resetSupabaseSession(): void {
  currentSession = null;
  currentAccessToken = null;
  currentRefreshToken = null;
  accessTokenExpiresAt = 0;
  supabase = null;
}

// Email del empleado logueado, para mostrarlo en el dashboard.
export function getCurrentUserEmail(): string | null {
  return currentSession?.email ?? null;
}
