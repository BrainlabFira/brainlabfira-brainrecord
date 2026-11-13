# Contexto del proyecto Electron — TimeSheet Desktop

> Este documento es el punto de entrada para cualquier nueva conversación sobre el proyecto Electron.
> Léelo entero antes de escribir una sola línea de código.
> Última actualización: 2026-05-19

---

## Qué es este proyecto

Una aplicación de escritorio para Windows que graba la pantalla completa de los empleados mientras están fichados. Corre en segundo plano, sin ventana visible, y sube la grabación al servidor local de la oficina.

**Este proyecto es independiente del proyecto web** (Next.js en `TimeSheet/my-app-timesheet/`). Son dos repos/carpetas separadas que comparten el mismo Supabase.

---

## El proyecto web que ya existe

- **Ruta local:** `C:\Users\Nitropc\Desktop\TimeSheet\TimeSheet\my-app-timesheet\`
- **Stack:** Next.js 15, React 19, TypeScript, TailwindCSS, Supabase, Shadcn/ui, Jotai
- **Lo que hace:** gestión de fichajes (clock in/out), panel de horas, admin de usuarios
- **API de fichajes:**
  - `POST /api/fichajes/start` — ficha al usuario (crea registro en tabla `fichajes`)
  - La tabla `fichajes` tiene: `id, user_id, start_time, end_time, ...`
  - Cuando `end_time` se rellena → el usuario ha desfichado
- **La web NO se toca** — sigue siendo la fuente de verdad del fichaje

---

## Arquitectura completa del sistema

```
[Empleado] ──abre navegador──► [Web Next.js]
                                     │
                              ficha/desficha
                                     │
                              [Supabase DB] ◄── fuente de verdad
                                     │
                           Supabase Realtime
                           (escucha cambios)
                                     │
                         [App Electron] ← corre en background en el PC del empleado
                              │
                    ┌─────────┴─────────┐
                    │                   │
               desktopCapturer       Supabase JS SDK
               (graba pantalla)      (detecta fichaje)
                    │
                  FFmpeg
               (comprime H.264)
                    │
               chunks cada 5-10 min
                    │
            red local de oficina
                    │
         [MinIO en Docker] @ 192.168.1.175:9000
                    │
            guarda en disco duro servidor
                    │
         [Web Next.js panel admin]
         consulta MinIO y reproduce videos
```

---

## Infraestructura — servidor de oficina

- **IP fija:** `192.168.1.175`
- **Sistema:** Linux con Docker (ya tiene otros contenedores corriendo)
- **Acceso:** SSH disponible
- **MinIO:**
  - API (subida/descarga): `http://192.168.1.175:9000`
  - Panel web admin: `http://192.168.1.175:9001`
  - Bucket principal: `recordings`
  - Las credenciales se definen al montar el contenedor

### docker-compose para MinIO

```yaml
services:
  minio:
    image: minio/minio
    container_name: minio
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - ./minio-data:/data
    environment:
      MINIO_ROOT_USER: admin
      MINIO_ROOT_PASSWORD: password_seguro
    command: server /data --console-address ":9001"
    restart: unless-stopped
```

---

## Stack técnico del proyecto Electron

| Tecnología | Versión recomendada | Uso |
|---|---|---|
| Electron | 32+ | Framework app de escritorio |
| Node.js | 20 LTS | Runtime |
| TypeScript | 5+ | Lenguaje |
| `desktopCapturer` | (built-in Electron) | Captura pantalla completa sin diálogo |
| `ffmpeg-static` | última | FFmpeg embebido en el .exe final |
| `fluent-ffmpeg` | última | Wrapper Node.js para FFmpeg |
| `minio` (SDK JS) | última | Subir chunks a MinIO |
| `@supabase/supabase-js` | 2+ | Realtime + auth |
| `electron-builder` | última | Generar instalador .exe Windows |

---

## Estructura de carpetas del proyecto Electron

```
timesheet-desktop/
├── src/
│   ├── main/                    ← proceso principal de Electron (Node.js)
│   │   ├── index.ts             ← entry point, crea BrowserWindow oculta
│   │   ├── tray.ts              ← icono bandeja del sistema
│   │   ├── recorder.ts          ← lógica de grabación con desktopCapturer + FFmpeg
│   │   ├── uploader.ts          ← subida de chunks a MinIO con reintentos
│   │   ├── supabase.ts          ← cliente Supabase + suscripción Realtime
│   │   └── auth.ts              ← login del empleado, gestión de sesión
│   └── renderer/                ← UI mínima (solo ventana de login si se necesita)
│       └── login.html
├── assets/
│   └── tray-icon.png            ← icono 16x16 o 32x32 para la bandeja
├── package.json
├── tsconfig.json
├── electron-builder.yml         ← config del instalador .exe
└── .env                         ← credenciales (no commitear)
```

---

## Flujo completo paso a paso

### Al arrancar Windows
1. La app Electron arranca automáticamente (registro de Windows / carpeta Startup)
2. Aparece solo el icono en la bandeja del sistema — sin ventana
3. La app hace login en Supabase con las credenciales del empleado
4. Se suscribe a Supabase Realtime escuchando la tabla `fichajes` filtrada por `user_id`
5. Estado inicial: **inactivo** (icono gris)

### Cuando el empleado ficha (desde la web)
1. La web hace `POST /api/fichajes/start` → se crea un registro en `fichajes` con `start_time`
2. Supabase Realtime emite un evento `INSERT` en la tabla `fichajes`
3. La app Electron detecta el evento
4. Inicia grabación con `desktopCapturer` (pantalla completa, sin diálogo)
5. FFmpeg comprime en tiempo real a H.264, baja calidad (720p, 5fps)
6. Cada 5-10 minutos → guarda chunk en disco local temporalmente → sube chunk a MinIO
7. Estado: **grabando** (icono rojo o con indicador)

### Cuando el empleado desficha (desde la web)
1. La web actualiza `fichajes` con `end_time`
2. Supabase Realtime emite un evento `UPDATE`
3. La app Electron detecta el evento
4. Para la grabación
5. Sube el último chunk pendiente a MinIO
6. Limpia archivos temporales del disco local
7. Estado: **inactivo** (icono gris)

### Si el servidor MinIO no está disponible
- Los chunks se acumulan en una carpeta temporal local
- La app reintenta la subida automáticamente cada 2 minutos
- Cuando el servidor vuelve, sube todos los chunks pendientes

---

## Nomenclatura de archivos en MinIO

```
recordings/
└── {user_id}/
    └── {fecha-fichaje}/         ← ej: 2026-05-19
        └── {fichaje_id}/
            ├── chunk_001.mp4
            ├── chunk_002.mp4
            └── chunk_003.mp4
```

Esto permite al panel admin filtrar por usuario y día fácilmente.

---

## Variables de entorno (.env)

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=xxxx
MINIO_ENDPOINT=192.168.1.175
MINIO_PORT=9000
MINIO_ACCESS_KEY=admin
MINIO_SECRET_KEY=password_seguro
MINIO_BUCKET=recordings
MINIO_USE_SSL=false
```

---

## Configuración de grabación recomendada

| Parámetro | Valor recomendado | Justificación |
|---|---|---|
| Resolución | 1280x720 (720p) | Equilibrio calidad/peso |
| FPS | 5 | Suficiente para ver actividad, muy ligero |
| Codec | H.264 (libx264) | Máxima compatibilidad, buena compresión |
| CRF | 28-32 | Calidad baja-media, archivo pequeño |
| Duración chunk | 10 minutos | Balance entre pérdida de datos y frecuencia de subida |
| Peso estimado | ~30-50 MB/hora | A 5fps y CRF 30 |

---

## Orden de implementación

Seguir este orden estrictamente — cada fase desbloquea la siguiente:

1. **Fase 0** — Montar MinIO en el servidor vía SSH + docker-compose
2. **Fase 1** — Grabación con `desktopCapturer` + FFmpeg + sistema de chunks
3. **Fase 2** — Subida de chunks a MinIO con reintentos
4. **Fase 3** — Suscripción Supabase Realtime (fichar/desfichar dispara grabación)
5. **Fase 4** — System tray + auto-start Windows
6. **Fase 5** — Instalador .exe con electron-builder
7. **Fase 6** — Panel admin en la web Next.js para ver/descargar grabaciones

**Regla de oro:** no pasar a la siguiente fase hasta que la anterior esté probada y estable.

---

## Lo que NO hay que hacer

- No tocar nada del proyecto web Next.js
- No cambiar la lógica de fichaje existente
- No intentar hacer la grabación desde el navegador (requiere `desktopCapturer` de Electron)
- No subir archivos de más de 50MB de una vez (partir siempre en chunks)
- No guardar las credenciales en el código — siempre en `.env`

---

## Consideraciones legales

- En España, grabar la pantalla de un empleado requiere **consentimiento explícito por escrito**
- Debe estar reflejado en contrato o documento firmado
- RGPD: definir tiempo de retención de videos y quién tiene acceso
- La app debe mostrar visualmente que está grabando (icono de tray diferenciado)

---

## Decisiones pendientes antes de arrancar

- [ ] Decidir si el login en Electron es manual (el empleado introduce email/password) o automático (comparte sesión con el navegador)
- [ ] Confirmar espacio disponible en disco del servidor para los videos
- [ ] Confirmar si se necesita firma de código para el .exe (evita alertas de Windows Defender)
- [ ] Futuro: planificar acceso VPN para empleados en teletrabajo

## Desarrollo local: integración con AI Transcriptor

`npm ci` instala las dependencias fijadas. `npm run dev` detecta el sistema:
Windows conserva el comando original (`npm run dev:windows`); Linux/macOS usan
un runner separado con copia nativa y limpieza de `ELECTRON_RUN_AS_NODE`.
También existen `dev:linux` y `dev:mac`. `npm run build` compila y copia los
renderers sin abrir la app. El instalador (`npm run dist`) sigue siendo Windows.
No hay recarga automática: reinicia el comando tras cambiar código.

La Biblioteca incorpora **Transcribir con IA** por grabación. La app obtiene el
MP4 desde el endpoint existente `/concat/:userId/:fecha/:recId` y lo transmite a
FastAPI sin cargarlo entero en memoria ni guardarlo en otro fichero local.
El servicio de concatenación sigue siendo responsable de juntar los fragmentos
y de su caché en MinIO. No se modifican el servidor ni las credenciales de MinIO.

Para el desarrollo aislado de Transcriptor (ver su `compose.dev.yaml`), añade a
un `.env` local de Brainrecord:

```env
TRANSCRIPTOR_API_URL=http://192.168.1.171:18766
TRANSCRIPTOR_PUBLIC_URL=http://192.168.1.171:18766
TRANSCRIPTOR_API_KEY=<mismo valor que BRAINRECORD_API_KEY en Transcriptor>
```

Usa `127.0.0.1:18766` si ambos procesos están en este ordenador y Transcriptor
solo escucha en localhost. La URL pública debe ser accesible desde el navegador
del usuario. Para la futura instancia normal usa el puerto 18765. Las claves
reales van en `.env`, nunca en Git. No copies los placeholders de Supabase de
`.env.example` sin sustituirlos: prevalecen sobre los valores predeterminados.
Los valores públicos de Supabase y `UPLOAD_SERVICE_URL` ya tienen defaults.

El API de integración está protegido por una clave compartida. No se envía el
JWT de Supabase a Transcriptor. Su interfaz web conserva el modelo existente de
acceso en una LAN de confianza; los enlaces no son permisos por usuario.

El progreso distingue envío de bytes y análisis de secciones completadas. La
estimación empieza cuando hay tiempos medidos y excluye cola/carga inicial y
resumen final. Los estados sobreviven a reinicios por su asociación persistente
en Transcriptor. Un doble clic no duplica trabajos. Errores de conexión permiten
reconsultar; trabajos fallidos/cancelados se reanudan con las secciones guardadas.

Se impide enviar mientras la grabación local termina o quedan subidas, y se
revalida el manifiesto antes del envío. El servidor actual no ofrece una marca
autoritativa de grabación finalizada para otros ordenadores: un administrador
debe esperar a que termine una grabación remota. Si llegan más fragmentos, su
manifiesto cambia y se genera una nueva asociación al transcribir de nuevo.

Comprobaciones:

```sh
npm test
npm run typecheck
# Con una instalación existente de Playwright (exporta chromium):
PLAYWRIGHT_PACKAGE=/ruta/a/playwright node tests/transcription-ui.cjs
```

`tests/transcription-e2e.cjs` admite `TRANSCRIPTOR_TEST_API_URL` y
`TRANSCRIPTOR_TEST_API_KEY` y debe apuntar **solo a un API desechable**. Genera
un MP4 con audio sintético y verifica el puente con FastAPI real, sin ejecutar
inferencia. Los tests unitarios de Transcriptor cubren el worker por separado.
