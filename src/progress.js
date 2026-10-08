export function createProgress({
  output = console.log,
  now = Date.now,
  intervalMs = 15000,
} = {}) {
  const started = now();
  let lastOutput = started;
  let current = 'Starting';
  const phases = new Set();
  const log = (message) => {
    current = message;
    lastOutput = now();
    output(`[${new Date(now()).toISOString()} +${((now() - started) / 1000).toFixed(1)}s] ${message}`);
  };
  const timer = setInterval(() => {
    if (now() - lastOutput >= Math.min(5000, intervalMs)) {
      log(`Still working: ${current.replace(/^Still working: /, '')}`);
    }
  }, intervalMs);
  timer.unref();
  return {
    log,
    summary(mode, source, target) {
      log(mode);
      for (const [label, value] of [['Source', source], ['Target', target]]) {
        if (!value) continue;
        log(`${label}: ${Object.entries({
          org: 'unknown (local dump or not resolved)',
          repo: 'unknown (local dump or not resolved)',
          contentBusId: 'unknown (not resolved; no additional config permissions required)',
          ...value,
        }).map(([key, item]) => `${key}=${item}`).join('; ')}`);
      }
    },
    onProgress(event) {
      const { phase = event.status || 'Progress', completed, total, key, bytes } = event;
      current = `${phase}${completed === undefined ? '' : `: ${completed}${total === undefined ? '' : `/${total}`}`}`
        + `${bytes === undefined ? '' : `; ${bytes} bytes`}${key ? `; ${key}` : ''}`
        + `${event.status ? `; status=${event.status}` : ''}`
        + `${event.shardsTotal === undefined ? '' : `; shards=${event.shardsCompleted}/${event.shardsTotal}; pages=${event.pages}`}`;
      if (!phases.has(phase) || completed === 0 || (total !== undefined && completed === total)
        || now() - lastOutput >= 5000) log(current);
      phases.add(phase);
    },
    async run(label, operation) {
      log(`${label}: starting`);
      try {
        const result = await operation();
        log(`${label}: done`);
        return result;
      } catch (error) {
        log(`${label}: FAILED (${error.message})`);
        throw error;
      }
    },
    close() {
      clearInterval(timer);
    },
  };
}
