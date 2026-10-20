// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app } = require('electron') as typeof import('electron');
import path from 'path';
import fs from 'fs';

let LOG_PATH = 'C:\\Users\\Nitropc\\Desktop\\recording_app\\timesheet-debug.log';

export function initLogPath(): void {
  try {
    LOG_PATH = path.join(app.getPath('userData'), 'timesheet-debug.log');
  } catch {
    /* app not ready — keep fallback path */
  }
}

export function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'object') return JSON.stringify(a, null, 2);
    return String(a);
  }).join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log(...args);
}
