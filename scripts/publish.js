#!/usr/bin/env node
'use strict';

// Sube el instalador y el manifiesto a MinIO, donde el concat-service los
// sirve bajo /updates/ para la actualización automática.
//
//   npm run dist      → genera release/ (instalador + latest.yml)
//   npm run publish   → sube ese contenido al bucket
//
// Las credenciales de MinIO NO están en la app (sube por presigned URLs), así
// que este script las pide por variables de entorno. Es una herramienta de
// quien publica la versión, no algo que se distribuya al empleado:
//
//   $env:MINIO_ACCESS_KEY="..."; $env:MINIO_SECRET_KEY="..."; npm run publish

const fs = require('fs');
const path = require('path');
const Minio = require('minio');

const ENDPOINT = process.env.MINIO_ENDPOINT ?? '192.168.1.175';
const PORT = parseInt(process.env.MINIO_PORT ?? '9100', 10);
const BUCKET = process.env.MINIO_BUCKET ?? 'recordings';
const PREFIX = process.env.RELEASES_PREFIX ?? 'releases';
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const SECRET_KEY = process.env.MINIO_SECRET_KEY;

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('Faltan MINIO_ACCESS_KEY y MINIO_SECRET_KEY en el entorno.');
  console.error('Son las mismas que usa el concat-service (ver su .env).');
  process.exit(1);
}

const releaseDir = path.join(__dirname, '..', 'release');
if (!fs.existsSync(releaseDir)) {
  console.error('No existe release/. Ejecuta antes: npm run dist');
  process.exit(1);
}

// Solo lo que necesita electron-updater. builder-debug.yml y win-unpacked/ no
// pintan nada en el bucket.
const files = fs.readdirSync(releaseDir).filter((f) => {
  if (f === 'latest.yml') return true;
  if (f.endsWith('.exe') && !f.startsWith('__uninstaller')) return true;
  if (f.endsWith('.exe.blockmap')) return true;   // descargas diferenciales
  return false;
});

if (!files.includes('latest.yml')) {
  console.error('No hay latest.yml en release/.');
  console.error('Comprueba que electron-builder.yml tiene configurado `publish`.');
  process.exit(1);
}

const minio = new Minio.Client({
  endPoint: ENDPOINT,
  port: PORT,
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
});

(async () => {
  const version = /version:\s*(.+)/.exec(
    fs.readFileSync(path.join(releaseDir, 'latest.yml'), 'utf-8')
  );
  console.log(`Publicando versión ${version ? version[1].trim() : '?'} en ${BUCKET}/${PREFIX}/\n`);

  // El manifiesto va el ÚLTIMO: si se subiera primero, una app podría leerlo y
  // pedir un instalador que todavía no está en el bucket.
  const ordered = [...files.filter((f) => f !== 'latest.yml'), 'latest.yml'];

  for (const file of ordered) {
    const local = path.join(releaseDir, file);
    const size = fs.statSync(local).size;
    process.stdout.write(`  ${file} (${(size / 1024 / 1024).toFixed(1)} MB)… `);
    await minio.fPutObject(BUCKET, `${PREFIX}/${file}`, local, {
      'Content-Type': file.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
    });
    console.log('ok');
  }

  // Borrar instaladores de versiones anteriores: cada uno ocupa ~100 MB y solo
  // hace falta el actual. Los .blockmap de la versión anterior SÍ se conservan
  // (electron-updater los usa para descargas diferenciales), pero son de KB.
  const keep = new Set(ordered);
  const stale = [];
  await new Promise((resolve, reject) => {
    const stream = minio.listObjectsV2(BUCKET, `${PREFIX}/`, true);
    stream.on('data', (obj) => {
      const name = obj.name.slice(PREFIX.length + 1);
      if (name.endsWith('.exe') && !keep.has(name)) stale.push(obj.name);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  if (stale.length > 0) {
    console.log('\nLimpiando instaladores antiguos:');
    for (const obj of stale) {
      await minio.removeObject(BUCKET, obj);
      console.log(`  ${obj.slice(PREFIX.length + 1)} eliminado`);
    }
  }

  console.log('\nPublicado. Las apps lo verán en su próxima comprobación.');
})().catch((err) => {
  console.error('\nError al publicar:', err.message);
  process.exit(1);
});
