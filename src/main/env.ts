import path from 'path';
import fs from 'fs';

// Config PÚBLICA embebida (por defecto). Se usa en la app empaquetada, donde no
// hay .env. Es seguro embeberla: el anon key de Supabase está diseñado para ir en
// clientes (protegido por RLS) y ya no hay credenciales de MinIO (la subida va por
// presigned URLs del concat-service). En desarrollo, un .env local sobrescribe esto.
const DEFAULT_ENV: Record<string, string> = {
  SUPABASE_URL: 'https://hvwkhoqomucqyxiuerav.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2d2tob3FvbXVjcXl4aXVlcmF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzODYyMzgsImV4cCI6MjA3ODk2MjIzOH0.NrvFPS8NIExZPgbQjC1lwFLf-NiqcyVRt2tR-SfbuSI',
  UPLOAD_SERVICE_URL: 'http://192.168.1.175:9210',
};

// Carga la config: primero los defaults embebidos, luego (si existe) un .env local
// que los sobrescribe. Sin dependencia de dotenv.
export function loadEnv(): void {
  // 1. Defaults embebidos
  for (const [key, value] of Object.entries(DEFAULT_ENV)) {
    if (!(key in process.env)) process.env[key] = value;
  }

  // 2. .env local (solo en desarrollo) — sobrescribe los defaults
  const envPath = path.join(process.cwd(), '.env');
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8').split('\n') : [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (key) process.env[key] = value; // el .env local tiene prioridad en dev
  }

  // Callers append routes with a leading slash. Avoid //recordings, which the
  // recording service treats as a different route and returns 404 for.
  for (const key of ['UPLOAD_SERVICE_URL', 'MINIO_CONSOLE_URL', 'TRANSCRIPTOR_API_URL', 'TRANSCRIPTOR_PUBLIC_URL']) {
    if (process.env[key]) process.env[key] = process.env[key]!.trim().replace(/\/+$/, '');
  }
}
