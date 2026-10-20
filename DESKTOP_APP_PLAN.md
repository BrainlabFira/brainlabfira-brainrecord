# Plan de Desarrollo — TimeSheet Desktop (Electron)

> Documento interno de planificación. No commitear.
> Última actualización: 2026-05-19

---

## Objetivo

Crear una aplicación de escritorio para Windows (Electron) que:
- Corra en segundo plano (system tray, sin ventana visible)
- Arranque automáticamente con Windows
- Detecte cuando el usuario ficha/desficha (via Supabase Realtime)
- Grabe la pantalla completa mientras el usuario está fichado
- Comprima el video con FFmpeg para minimizar peso
- Suba la grabación en chunks al servidor local de la oficina (MinIO en Docker)

La web Next.js existente **no se toca** — sigue siendo la fuente de verdad del fichaje.

---

## Arquitectura

```
[Web Next.js] ──ficha/desficha──► [Supabase DB]
                                        │
                              Supabase Realtime
                                        │
                              [App Electron] ──graba──► FFmpeg
                                        │
                                  chunks via red local
                                        │
                              [Servidor oficina]
                              [MinIO en Docker] ──guarda──► Disco duro servidor
                                        │
                              [Web Next.js admin] ──consulta y reproduce──► Admin
```

**Scope actual:** red local de oficina únicamente.
**Futuro:** añadir VPN para teletrabajadores (fuera del scope actual).
**SUPABASE** Hacerla local y sustituirla (NO USAR SUPABASE)
---

## Stack técnico

| Tecnología | Uso |
|---|---|
| Electron | App de escritorio Windows |
| Node.js | Runtime dentro de Electron |
| `desktopCapturer` | Captura de pantalla completa (API nativa Electron) |
| FFmpeg (ffmpeg-static) | Compresión H.264 en tiempo real |
| Supabase JS SDK | Realtime — escuchar eventos de fichaje/desfichaje |
| MinIO (Docker) | Almacenamiento de videos en servidor local de oficina |
| MinIO JS SDK | Cliente para subir chunks desde Electron al MinIO local |
| electron-builder | Generar instalador .exe para Windows |

---

## Infraestructura — MinIO en el servidor de oficina

MinIO es un servidor de almacenamiento compatible con S3, se despliega como contenedor Docker en minutos.

```yaml
# docker-compose.yml en el servidor de oficina
services:
  minio:
    image: minio/minio
    ports:
      - "9000:9000"   # API (subida/descarga de archivos)
      - "9001:9001"   # Panel web de administración
    volumes:
      - ./minio-data:/data
    environment:
      MINIO_ROOT_USER: admin
      MINIO_ROOT_PASSWORD: password_seguro
    command: server /data --console-address ":9001"
```

- La app Electron apunta a `http://192.168.1.175:9000`
- El panel admin de la web también apunta a `http://192.168.1.175:9000`
- Los videos se guardan en disco en el propio servidor
- **Sin límites de tamaño** — solo limitado por el disco del servidor

---

## Fases de desarrollo

### FASE 0 — MinIO en el servidor de oficina
**Estimación: 4h**

| Tarea | Horas estimadas |
|---|---|
| Añadir contenedor MinIO al docker-compose del servidor | 2h |
| Crear bucket `recordings`, configurar acceso y credenciales | 2h |

**Resultado:** MinIO corriendo en `http://IP_SERVIDOR:9000`, accesible desde la red local.

---

### FASE 1 — Grabación + FFmpeg (núcleo crítico)
**Estimación: 40h** (con margen para imprevistos)

| Tarea | Horas estimadas |
|---|---|
| Configurar proyecto Electron base | 4h |
| Integrar `desktopCapturer` — captura de pantalla completa sin diálogo | 8h |
| Integrar FFmpeg (ffmpeg-static) + compresión H.264 en tiempo real | 12h |
| Sistema de grabación en chunks (segmentos de 5-10 min) | 12h |
| Tests de grabación larga (8h simuladas), comprobar memoria y CPU | 4h |

**Riesgos:**
- FFmpeg puede dar problemas de rendimiento en PCs lentos
- `desktopCapturer` puede requerir permisos especiales en Windows 11
- La grabación en chunks sin cortes visibles puede ser compleja de sincronizar

---

### FASE 2 — Subida robusta a MinIO (red local)
**Estimación: 20h** (con margen)

| Tarea | Horas estimadas |
|---|---|
| Integrar MinIO JS SDK en Electron | 4h |
| Lógica de subida de chunks en background mientras graba | 8h |
| Sistema de reintentos automáticos si falla la subida | 4h |
| Manejo de reconexión si el PC pierde acceso al servidor momentáneamente | 4h |

**Ventajas vs Supabase Storage:**
- Red local = subida mucho más rápida (100Mbps–1Gbps vs. internet)
- Sin límite de tamaño por archivo
- Sin coste de almacenamiento en la nube

**Riesgos:**
- Si el servidor está apagado o caído, los chunks se acumulan localmente hasta que vuelva
- Necesita que el PC del empleado tenga visibilidad de red al servidor (misma red local)

---

### FASE 3 — Sincronización con Supabase Realtime
**Estimación: 16h** (con margen)

| Tarea | Horas estimadas |
|---|---|
| Suscripción Realtime a tabla `fichajes` filtrando por `user_id` | 4h |
| Lógica: detectar INSERT (fichar) → iniciar grabación | 4h |
| Lógica: detectar UPDATE con `end_time` (desfichar) → parar y subir último chunk | 4h |
| Manejo de sesión (login del trabajador en la app Electron) | 4h |

**Riesgos:**
- Realtime puede tener latencia — añadir fallback de polling cada 30s como seguro

---

### FASE 4 — System Tray + Auto-start Windows
**Estimación: 16h** (con margen)

| Tarea | Horas estimadas |
|---|---|
| Icono en bandeja del sistema (sin ventana visible) | 4h |
| Menú contextual del tray (estado: grabando / inactivo, versión, salir) | 4h |
| Auto-start con Windows (registro de Windows o carpeta Startup) | 4h |
| Notificaciones nativas Windows (grabando, error de subida, etc.) | 4h |

---

### FASE 5 — Instalador Windows + distribución
**Estimación: 12h** (con margen)

| Tarea | Horas estimadas |
|---|---|
| Configurar electron-builder para generar .exe | 4h |
| Firma de código (recomendable para evitar alertas de Windows Defender) | 4h |
| Documentación de instalación para el trabajador | 4h |

---

### FASE 6 — Panel admin en la web
**Estimación: 20h** (con margen)

| Tarea | Horas estimadas |
|---|---|
| Nueva sección en el panel admin para ver grabaciones por usuario/día | 8h |
| Listado de chunks/segmentos con opción de reproducir o descargar | 8h |
| Indicador de estado (grabando / sin app instalada / error de subida) | 4h |

> El panel admin llama directamente al MinIO local para listar y servir los videos.

---

## Resumen de tiempos

| Fase | Estimación |
|---|---|
| Fase 0 — MinIO en servidor | 4h |
| Fase 1 — Grabación + FFmpeg | 40h |
| Fase 2 — Subida a MinIO (red local) | 20h |
| Fase 3 — Realtime sincronización | 16h |
| Fase 4 — System Tray + Auto-start | 16h |
| Fase 5 — Instalador Windows | 12h |
| Fase 6 — Panel admin web | 20h |
| **TOTAL** | **128h** |

> Estimación con margen incluido para imprevistos, bugs de integración y pruebas.
> No son 128h seguidas — son horas de trabajo real repartidas en el calendario junto con otras tareas.

---

## Orden recomendado de desarrollo

1. **Fase 0** — Montar MinIO en el servidor (desbloquea todo lo demás)
2. **Fase 1** — Grabación + FFmpeg (núcleo crítico, si esto falla nada más importa)
3. **Fase 2** — Subida a MinIO (en paralelo mental con Fase 1, diseñar chunks desde el inicio)
4. **Fase 3** — Realtime con Supabase
5. **Fase 4** — System Tray + Auto-start
6. **Fase 5** — Instalador Windows (cuando todo lo demás está probado)
7. **Fase 6** — Panel admin web (puede hacerse en cualquier momento, no bloquea nada)

---

## Consideraciones legales (importante)

- En España, grabar la pantalla de un empleado requiere **consentimiento explícito** por escrito
- Debe quedar reflejado en el contrato o en un documento firmado aparte
- Los datos deben tratarse según el **RGPD** — definir tiempo de retención de los videos y quién tiene acceso
- Recomendable añadir un aviso visible en la app (icono de tray) indicando que la grabación está activa

---

## Notas pendientes

- [x] IP del servidor confirmada: `192.168.1.175`
- [ ] Decidir si el login en la app Electron es independiente o reutiliza la sesión del navegador
- [ ] Decidir resolución y FPS de grabación (afecta directamente al peso)
- [ ] Confirmar espacio disponible en disco del servidor para los videos
- [ ] Confirmar si se necesita firma de código para el instalador .exe
- [ ] Futuro: planificar acceso VPN para teletrabajadores



PODER CONFIGURAR CALIDAD DEL VIDEO, FRAMES POR SEGUNDO, ACTIVAR/DESACTIVAR AUDIO, REPRODUCCIÓN AUTOMÁTICA