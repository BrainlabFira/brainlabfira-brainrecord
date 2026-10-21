# Publicar una versión nueva

La app se actualiza sola: consulta el manifiesto al iniciar sesión y cada 4
horas, descarga la versión nueva en segundo plano y la instala **en cuanto no
haya ninguna grabación en curso ni fragmentos pendientes de subir**. Una
actualización nunca interrumpe una grabación.

## Pasos

```powershell
# 1. Subir la versión en package.json (1.0.2 → 1.0.3)
#    electron-updater compara este número con el del manifiesto.

# 2. Construir el instalador y el manifiesto
npm run dist

# 3. Publicar al bucket
$env:MINIO_ACCESS_KEY = "..."    # las mismas del .env del concat-service
$env:MINIO_SECRET_KEY = "..."
npm run publish
```

Eso es todo. Las apps abiertas la verán en su próxima comprobación; las
cerradas, al arrancar.

> **Ojo con el BOM.** No edites `package.json` con
> `Set-Content -Encoding utf8` de PowerShell: añade un BOM al principio y
> electron-builder falla con `readObjectStart: expect { or n`. Usa el editor o
> `-NoNewline` con `utf8NoBOM`.

## Dónde vive cada cosa

| | |
|---|---|
| Instalador y manifiesto | MinIO, `recordings/releases/` |
| Quien los sirve | concat-service, `GET /updates/:file` |
| Quien los sube | `scripts/publish.js` (`npm run publish`) |

El manifiesto (`latest.yml`) se sube **el último**: si fuera el primero, una
app podría leerlo y pedir un instalador que aún no está en el bucket.

## Descarga inicial

Para instalar la app por primera vez:

```
http://192.168.1.175:9210/download?token=<jwt>
```

Resuelve la última versión leyendo el manifiesto. Requiere un JWT válido —
una app de grabación de pantalla no debería poder descargarla cualquiera que
pase por la red.

## Qué ve el empleado

En el dashboard, pestaña **Actualizaciones**: versión instalada, estado, barra
de progreso durante la descarga y un botón para buscar manualmente. Si la
actualización está lista pero hay una grabación en curso, lo dice y espera.

## Sin firma de código

Los instaladores no están firmados, así que **Windows SmartScreen avisará** al
instalar. Es asumible para uso interno; un certificado de firma cuesta unos
200-400 €/año y lo quitaría.

## Comprobar que una versión se publicó bien

```bash
TOKEN=<jwt>
curl -H "Authorization: Bearer $TOKEN" http://192.168.1.175:9210/updates/latest.yml
```

Debe devolver el `version:` que acabas de publicar.
