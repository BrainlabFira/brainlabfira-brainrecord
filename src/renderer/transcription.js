/* Progress is phase-specific: transfer bytes, then completed analysis sections. */
window.createTranscriptionButtons = function (list, ipc) {
  const states = new Map();
  let records = [], polling = false;
  const key = r => JSON.stringify([String(r.userId), String(r.fecha), String(r.recId), Number(r.chunks), Number(r.bytes)]);
  const ref = b => ({ userId: b.dataset.u, fecha: b.dataset.f, recId: b.dataset.r,
    chunks: Number(b.dataset.chunks), bytes: Number(b.dataset.bytes) });
  const busy = ['preparing', 'uploading', 'validating', 'queued', 'running', 'summarizing', 'cancelling'];
  function paint() {
    for (const button of list.querySelectorAll('[data-act="transcribe"]')) {
      const state = states.get(key(ref(button))) || { status: 'idle' };
      const active = busy.includes(state.status);
      let label = 'Transcribir con IA', detail = '';
      const labels = { preparing: 'Preparando vídeo…', uploading: 'Enviando vídeo', validating: 'Validando vídeo…',
        queued: 'En cola…', running: 'Analizando', summarizing: 'Generando resumen…',
        cancelling: 'Cancelando…', completed: 'Abrir transcripción', failed: 'Reintentar análisis',
        cancelled: 'Reanudar análisis', connection_error: 'Reintentar conexión' };
      label = labels[state.status] || label;
      if (['uploading', 'running'].includes(state.status) && Number.isFinite(state.percent)) label += ` · ${state.percent}%`;
      if (state.status === 'running') {
        detail = state.eta_seconds != null ? `≈ ${Math.max(1, Math.ceil(state.eta_seconds / 60))} min + resumen` : 'Calculando tiempo…';
      }
      if (['queued', 'running', 'summarizing'].includes(state.status) && state.worker_online === false) detail = 'Esperando al procesador';
      if (state.error) detail = state.error;
      button.disabled = active;
      button.classList.toggle('ai-busy', active);
      button.classList.toggle('ai-error', Boolean(state.error));
      button.classList.toggle('ai-done', state.status === 'completed');
      button.classList.toggle('ai-indeterminate', active && !Number.isFinite(state.percent));
      button.querySelector('.ai-label').textContent = label;
      button.querySelector('.ai-detail').textContent = detail;
      button.querySelector('.ai-fill').style.width = `${Math.max(0, Math.min(100, state.percent || 0))}%`;
      button.title = detail || label;
      button.setAttribute('aria-label', `${label}${detail ? '. ' + detail : ''}`);
      button.setAttribute('aria-busy', String(active));
    }
  }
  async function poll() {
    if (polling || !records.length) return;
    polling = true;
    // Bound fan-out for large recording libraries.
    const queue = [...records];
    try {
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const r = queue.shift();
          try { states.set(key(r), await ipc.invoke('transcription:status', r)); }
          catch (error) { states.set(key(r), { status: 'connection_error', error: error.message }); }
        }
      }));
    } finally { polling = false; paint(); }
  }
  ipc.on('transcription:state', (_event, payload) => { states.set(payload.key, payload.state); paint(); });
  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-act="transcribe"]');
    if (!button || button.disabled) return;
    const r = ref(button), id = key(r), state = states.get(id);
    if (state?.status === 'completed') {
      try {
        const result = await ipc.invoke('transcription:open', r);
        if (result.error) states.set(id, { status: 'connection_error', error: result.error });
      } catch (error) { states.set(id, { status: 'connection_error', error: error.message }); }
    } else {
      states.set(id, { status: 'preparing' }); paint();
      try { states.set(id, await ipc.invoke('transcription:start', r)); }
      catch (error) { states.set(id, { status: 'connection_error', error: error.message }); }
    }
    paint();
  });
  const timer = setInterval(poll, 5000);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  return { update(rows) { records = rows.map(r => ({ userId: String(r.userId), fecha: String(r.fecha), recId: String(r.recId), chunks: Number(r.chunks), bytes: Number(r.bytes) })); paint(); void poll(); } };
};
