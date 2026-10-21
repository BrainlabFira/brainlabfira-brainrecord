# Publicar una versión de Brainlabrecord

El empleado **instala la app una sola vez**. A partir de ahí se actualiza sola:
comprueba si hay versión nueva al iniciar sesión y cada 4 horas, se la descarga
en segundo plano y se reinicia actualizada. No pregunta nada.

Lo único que la frena es una grabación en curso: si está grabando o quedan
fragmentos por subir, espera y reintenta cada minuto. **Una actualización nunca
interrumpe una grabación.**

---

## El ciclo completo

```
TÚ                                           EL EMPLEADO
──                                           ───────────
1. subir "version" en package.json
2. npm run dist      (construye)
3. npm run publish   (sube al servidor)
                                             (no hace nada)
                                             la app comprueba sola
                                             descarga en segundo plano
                                             se reinicia actualizada
```

> **`git push` NO publica nada.** GitHub guarda el código; lo que ven las apps
> es lo que sube `npm run publish` al servidor. Si solo haces push, nadie se
> actualiza.

---

## Paso 1 — Subir el número de versión

En `package.json`, campo `version`. Es lo que compara electron-updater: si el
número no sube, las apps no ven nada nuevo aunque el instalador haya cambiado.

```json
{
  "version": "1.0.3"
}
```

> **Trampa del BOM.** No edites este archivo con
> `Set-Content -Encoding utf8` de PowerShell: añade un BOM invisible al
> principio y el build falla con
> `readObjectStart: expect { or n, but found ﻿`.
>
> Usa el editor de código. Si ya pasó:
> ```bash
> python -c "raw=open('package.json','rb').read(); open('package.json','wb').write(raw[3:] if raw[:3]==b'\xef\xbb\xbf' else raw)"
> ```

---

## Paso 2 — Construir

```powershell
npm run dist
```

Compila TypeScript, copia los renderers y genera en `release/`:

| Archivo | Para qué |
|---|---|
| `Brainlabrecord Setup 1.0.3.exe` | El instalador (~100 MB) |
| `latest.yml` | Manifiesto: versión, hash y tamaño. **Es lo que consultan las apps** |
| `...exe.blockmap` | Permite descargas diferenciales |

Comprueba que el manifiesto tiene la versión correcta:

```powershell
Get-Content release\latest.yml
```

```yaml
version: 1.0.3
path: Brainlabrecord Setup 1.0.3.exe
sha512: ...
```

> El build necesita el **Modo Desarrollador de Windows** activado
> (Configuración → Sistema → Para programadores). Sin él, electron-builder
> falla al extraer winCodeSign con "A required privilege is not held".

---

## Paso 3 — Publicar

```powershell
$env:MINIO_ACCESS_KEY = "brainlab"
$env:MINIO_SECRET_KEY = "<la del .env del concat-service>"
npm run publish
```

```
Publicando versión 1.0.3 en recordings/releases/

  Brainlabrecord Setup 1.0.3.exe (100.5 MB)… ok
  Brainlabrecord Setup 1.0.3.exe.blockmap (0.1 MB)… ok
  latest.yml (0.0 MB)… ok

Publicado. Las apps lo verán en su próxima comprobación.
```

El manifiesto se sube **el último** a propósito: si fuera el primero, una app
podría leerlo y pedir un instalador que todavía no está en el bucket.

Al terminar, el script **borra del bucket los instaladores de versiones
anteriores** (cada uno ocupa ~100 MB y solo hace falta el actual). Los
`.blockmap` se conservan: pesan unos KB y electron-updater los usa para
descargas diferenciales.

```
Limpiando instaladores antiguos:
  Brainlabrecord Setup 1.0.2.exe eliminado
```

---

## Verificar que se publicó bien

```bash
TOKEN=<jwt de cualquier usuario>
curl -H "Authorization: Bearer $TOKEN" http://192.168.1.175:9210/updates/latest.yml
```

Debe devolver el `version:` que acabas de publicar. Si devuelve el anterior, el
`npm run publish` no llegó a subir el manifiesto.

Para ver el ciclo en una app real, con la app abierta:

```powershell
Get-Content "$env:APPDATA\brainlabrecord\timesheet-debug.log" -Tail 30 |
  Select-String "updater"
```

Una actualización correcta deja este rastro:

```
[updater] Checking for update
[updater] Found version 1.0.3
[updater] Versión nueva disponible: 1.0.3
[updater] New version 1.0.3 has been downloaded
[updater] Instalando actualización y reiniciando
```

---

## Migrar equipos con una versión anterior a la 1.0.1

**Quien tenga instalada la 1.0.0 (o cualquier versión anterior a la 1.0.1)
tiene que reinstalar a mano, una última vez.** Esas versiones no llevan el
código del updater, así que no pueden enterarse de que hay actualizaciones:
el mecanismo no puede entregarse a sí mismo.

| Versión instalada | ¿Se actualiza sola? |
|---|---|
| Anterior a 1.0.1 | **No** — hay que reinstalar una vez |
| 1.0.1 o posterior | Sí |

Para migrarlos, basta con pasarles el enlace de descarga de abajo. **No hace
falta desinstalar antes**: el instalador sobrescribe la versión anterior y
conserva la sesión guardada, así que no tendrán que volver a iniciar sesión.

Para saber qué versión tiene un equipo:

```powershell
(Get-Item "$env:LOCALAPPDATA\Programs\Brainlabrecord\Brainlabrecord.exe").VersionInfo.ProductVersion
```

## Instalación inicial (empleado nuevo)

```
http://192.168.1.175:9210/download?token=<jwt>
```

Resuelve la última versión leyendo el manifiesto, así que el enlace no caduca
al publicar versiones nuevas. Requiere un JWT válido: una app de grabación de
pantalla no debería poder descargarla cualquiera que pase por la red.

**Windows SmartScreen avisará** al instalar, porque los instaladores no están
firmados ("Windows protegió su PC" → *Más información* → *Ejecutar de todas
formas"). Un certificado de firma cuesta unos 200-400 €/año y lo quitaría.

---

## Qué ve el empleado

Dashboard → pestaña **Actualizaciones**:

- Versión instalada
- Estado: *Todo al día* / *Descargando la versión X* / *Lista para instalar*
- Barra de progreso durante la descarga
- Botón **Buscar** para comprobar manualmente
- Si hay actualización lista pero está grabando: *"Se instalará automáticamente
  en cuanto termine la grabación"*

---

## Arquitectura

| | |
|---|---|
| Instaladores y manifiesto | MinIO, prefijo `recordings/releases/` |
| Quién los sirve | concat-service, `GET /updates/:file`, con JWT |
| Quién los sube | `scripts/publish.js` (`npm run publish`) |
| Quién decide cuándo instalar | `src/main/updater.ts` |

`minio` está como **devDependency**: es la herramienta de quien publica, no se
distribuye al empleado. La app sube los chunks por presigned URLs y no tiene
credenciales de MinIO.

---

## Si algo falla

**El build falla con `readObjectStart: expect { or n`**
BOM en `package.json`. Ver la trampa del paso 1.

**`npm run publish` dice "Faltan MINIO_ACCESS_KEY y MINIO_SECRET_KEY"**
No exportaste las variables. Son las mismas del `.env` del concat-service.

**`npm run publish` dice "No hay latest.yml en release/"**
El build no llegó a generarlo. Comprueba que `electron-builder.yml` tiene la
sección `publish:` (sin ella, electron-builder no genera el manifiesto).

**Las apps no detectan la versión nueva**
1. Comprueba el manifiesto con el `curl` de arriba.
2. Mira el log: si dice `Sin sesión activa`, el empleado no ha iniciado sesión
   y no hay token para pedir el manifiesto.
3. En desarrollo (`npm run dev`) el updater no hace nada a propósito:
   `app.isPackaged` es `false`.

**Una app se queda en "Lista para instalar"**
Está esperando a que termine una grabación o a que suban los fragmentos
pendientes. Es el comportamiento correcto. Se puede forzar desde la pestaña
Actualizaciones con *Reiniciar e instalar*.
