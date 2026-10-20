// Identidad de una grabación bajo demanda.
//
// Antes los chunks se agrupaban por el id del fichaje abierto: la grabación
// nacía y moría con la presencia del empleado. Ahora la inicia él mismo, así
// que la app genera su propio id de grabación.
//
// El formato rec_YYYYMMDD_HHMMSS es legible y ordenable: un admin que mira el
// bucket sabe cuándo se grabó sin consultar la base de datos. Ocupa el mismo
// nivel de ruta que ocupaba el fichaje_id, así que el concat-service sigue
// funcionando sin cambios (solo ve carpetas y concatena los .mp4 que hay dentro).

export function generateRecordingId(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `rec_${stamp}`;
}

// Fecha local en YYYY-MM-DD, el segundo nivel de la ruta en MinIO.
//
// OJO: se usa la fecha LOCAL, no toISOString(). Con UTC, una grabación hecha a
// las 00:30 en España caería en la carpeta del día anterior, y el empleado no
// encontraría su grabación donde espera.
export function localDateStamp(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}
