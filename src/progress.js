import path from 'node:path';

export function formatMigrationSummary(report, cwd = process.cwd()) {
  const plural = (count, singular, multiple = `${singular}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? singular : multiple}`;
  const elapsed = Math.max(0, Math.round((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000) || 0);
  const blockers = report.blockers || [];
  const warnings = (report.warnings || []).filter(({ count }) => count > 0);
  const label = report.dryRun ? 'Dry-run' : 'Migration';
  const outcome = blockers.length ? 'blocked after' : report.dryRun ? 'completed in' : 'succeeded in';
  const lines = [`${label} ${outcome} **${plural(elapsed, 'second')}**.`, ''];
  if (report.dryRun) {
    if (report.validation === 'inventory') {
      lines.push(`- **${plural(report.sourceObjects || 0, 'source object')}** (${(report.sourceBytes || 0).toLocaleString('en-US')} stored bytes).`);
      lines.push(`- **${plural(report.targetObjects || 0, 'target object')}** (${(report.targetBytes || 0).toLocaleString('en-US')} stored bytes).`);
    } else {
      lines.push(`- **${plural(report.objects || report.plannedObjects?.length || 0, 'object')} planned**.`);
    }
    lines.push('- No content writes or image uploads.');
  } else {
    const written = (report.results || []).filter(({ status }) => status === 'written');
    const statuses = new Map((report.statuses || []).map(({ key, status }) => [key, status]));
    const overwritten = written.filter(({ key }) => statuses.get(key) === 'overwrite').length;
    const created = written.filter(({ key }) => statuses.get(key) === 'planned').length;
    const counts = overwritten + created === written.length
      ? ` ${overwritten.toLocaleString('en-US')} overwritten, ${created.toLocaleString('en-US')} newly created` : '';
    lines.push(`- **${plural(written.length, 'object')} written${counts ? ':' : ''}**${counts}.`);
    const uploaded = report.uploadedImageUrls?.length || 0;
    const errors = report.imageErrors?.length || 0;
    lines.push(`- **${plural(uploaded, 'image')} uploaded**, ${errors ? `**${plural(errors, 'image error')}**; original URLs retained` : 'no image errors'}.`);
  }
  const config = {
    exists: 'Project config already matched', written: 'Project config written',
    planned: report.dryRun ? 'Project config change planned' : 'Project config not written',
    absent: 'No source project config to migrate',
  }[report.projectConfig?.status] || 'Project config not checked';
  const issues = warnings.length || blockers.length
    ? `${warnings.length ? `**${plural(warnings.length, 'warning category', 'warning categories')}**` : 'no warnings'}; ${blockers.length ? `**${plural(blockers.length, 'blocker')}**` : 'no blockers'}`
    : 'no warnings or blockers';
  lines.push(`- ${config}; ${issues}.`);
  if (report.sourceDump) {
    const relative = path.relative(cwd, report.sourceDump);
    const location = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? `./${relative.split(path.sep).join('/')}` : report.sourceDump;
    const snapshot = report.sourceSnapshotComplete === false ? 'Partial source snapshot retained locally'
      : report.sourceSnapshotComplete && report.sourceObjects !== undefined
        ? `All **${plural(report.sourceObjects, 'source object')}** retained locally` : 'Source snapshot available locally';
    lines.push(`- ${snapshot}: \`${location}\`.`);
  }
  blockers.forEach((error) => lines.push(`- Blocker: ${error}`));
  return lines.join('\n');
}

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
