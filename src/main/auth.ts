import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('electron') as typeof import('electron');

export interface SessionData {
  authUserId: string;    // UUID from Supabase Auth
  numericUserId: number; // integer id from public.users (used in fichajes.user_id)
  email: string;
  accessToken: string;
  refreshToken: string;
}

const ENCRYPTION_KEY = 'timesheet-desktop-key-2026-xxxxx'.slice(0, 32); // 32 bytes for AES-256
const IV_LENGTH = 16;

function getSessionPath(): string {
  return path.join(app.getPath('userData'), 'session.enc');
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString();
}

export async function loadSession(): Promise<SessionData | null> {
  const sessionPath = getSessionPath();
  if (!fs.existsSync(sessionPath)) return null;

  try {
    const encrypted = fs.readFileSync(sessionPath, 'utf-8');
    const json = decrypt(encrypted);
    return JSON.parse(json) as SessionData;
  } catch {
    return null;
  }
}

export async function saveSession(session: SessionData): Promise<void> {
  const sessionPath = getSessionPath();
  const encrypted = encrypt(JSON.stringify(session));
  fs.writeFileSync(sessionPath, encrypted, 'utf-8');
}

export async function clearSession(): Promise<void> {
  const sessionPath = getSessionPath();
  if (fs.existsSync(sessionPath)) {
    fs.unlinkSync(sessionPath);
  }
}
