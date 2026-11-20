const $ = (selector) => document.querySelector(selector);
const form = $('#prepare-form');
const differentTarget = $('#different-target');
const targetFields = $('#target-fields');
const SELECTION_KEY = 'da-hlx6-migration.site-selection.v1';
const headings = [
  ['Connect your accounts', 'Sign in to inspect your sites and prepare a safe migration from DA to HLX6.'],
  ['Choose your migration scope', 'Tell us where your content lives and where it would go. No changes will be made.'],
  ['Understand your starting point', 'A first look at site configuration, source inventory and the HLX6 destination.'],
  ['Rehearse your migration', 'Build and validate the full plan before considering any real migration.'],
  ['Your migration, made clear', 'Review what would happen, what needs attention and what stays unchanged.'],
];
let step = 1;
let unlocked = 1;
let currentJob;
let currentAuth;
let currentAwsAuth;
let pendingAction = 'status';
let connectionError = false;
let actionError = '';
let following = false;
let hasSelection = false;
let displayedConfigs;
let displayedReport;
let refreshingAuth = false;

const sessionReady = (auth) => auth?.status === 'authenticated'
  && (!auth.expiresAt || Date.parse(auth.expiresAt) > Date.now() + 60_000);
const authenticated = () => sessionReady(currentAuth) && sessionReady(currentAwsAuth);
const active = () => currentJob?.status === 'running'
  || ['signing-in', 'checking'].includes(currentAuth?.status)
  || ['signing-in', 'checking'].includes(currentAwsAuth?.status);
const locked = () => active() || Boolean(pendingAction) || connectionError || refreshingAuth;
const analysisReport = () => currentJob?.fullValidation ? currentJob.analysisReport : currentJob?.report;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function jsonDetails(title, value) {
  const details = element('details');
  details.append(element('summary', title), element('pre', JSON.stringify(value, null, 2)));
  return details;
}

function number(value) {
  return typeof value === 'number' ? value.toLocaleString() : 'Not checked';
}

function size(bytes) {
  if (typeof bytes !== 'number') return 'Not checked';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`;
}

function metrics(container, values) {
  container.replaceChildren();
  for (const [label, value] of values) {
    const card = element('div', undefined, 'metric');
    card.append(element('strong', value), element('span', label));
    container.append(card);
  }
}

function findings(container, report) {
  container.replaceChildren();
  for (const [title, items] of [
    ['Blockers', report.blockers ?? []],
    ['Warnings', report.warnings ?? []],
    ['Checks not performed', report.skippedChecks ?? []],
  ]) {
    if (!items.length) continue;
    const group = element('div', undefined, 'findings');
    group.append(element('h3', `${title} (${items.length})`));
    const list = element('ul');
    for (const item of items) {
      list.append(element('li', typeof item === 'string' ? item
        : `${item.id}: ${item.description ?? item.reason}${item.count === undefined ? '' : ` (${number(item.count)})`}`));
    }
    group.append(list);
    container.append(group);
  }
  if (report.sourceConfigWarning) container.append(element('p', report.sourceConfigWarning, 'notice'));
}

function setStep(next, focus = true) {
  step = next;
  renderWorkflow();
  if (focus) {
    $('#page-title').focus();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

function renderActivity() {
  let title;
  let detail;
  let state = 'running';
  if (connectionError) {
    title = 'Connection to the local server lost';
    detail = 'An operation may still be running. Reconnect before starting anything else.';
    state = 'warning';
  } else if (pendingAction) {
    title = {
      status: 'Connecting to your local workspace',
      auth: 'Starting DA sign-in',
      'aws-auth': 'Starting AWS sign-in',
      analysis: 'Starting first-pass analysis',
      'dry-run': 'Starting full dry run',
    }[pendingAction];
    detail = 'Waiting for the local server.';
  } else if (currentAuth?.status === 'signing-in' || currentAwsAuth?.status === 'signing-in') {
    const da = currentAuth?.status === 'signing-in';
    title = da ? 'DA sign-in in progress' : 'AWS sign-in in progress';
    detail = da ? currentAuth.message : currentAwsAuth.message;
  } else if (currentJob?.status === 'running') {
    title = currentJob.fullValidation ? 'Full dry run in progress' : 'First-pass analysis in progress';
    detail = currentJob.phase;
  } else if (step === 2 && !authenticated()) {
    title = 'Sign in before starting another analysis';
    detail = 'Return to Sign in to connect both accounts. Your site selection is kept.';
    state = 'warning';
  }
  $('#activity').hidden = !title;
  $('#activity').dataset.state = state;
  $('#activity-title').textContent = title ?? '';
  $('#status').textContent = detail ?? '';
  $('#activity-spinner').hidden = state !== 'running';
  $('#reconnect').hidden = !connectionError;
  const error = actionError || (step >= 4 || (step === 3 && !currentJob?.fullValidation) ? currentJob?.error : '');
  $('#error').hidden = !error;
  $('#error').textContent = error ?? '';
}

function renderAuth(auth, aws = false) {
  if (!auth) return;
  const prefix = aws ? '#aws-auth' : '#auth';
  const connected = sessionReady(auth);
  const signingIn = ['signing-in', 'checking'].includes(auth.status);
  $(`${prefix}-message`).textContent = auth.message;
  $(`${prefix}-error`).hidden = !auth.error;
  $(`${prefix}-error`).textContent = auth.error ?? '';
  const badge = $(`${prefix}-badge`);
  badge.textContent = connected ? 'Connected' : signingIn ? 'Connecting' : auth.status === 'failed' ? 'Sign-in failed' : 'Not connected';
  badge.dataset.state = connected ? 'complete' : signingIn ? 'running' : auth.status === 'failed' ? 'failed' : 'idle';
  $(aws ? '#aws-sign-in' : '#sign-in').textContent = signingIn ? 'Signing in...'
    : connected ? 'Sign in again' : aws ? 'Sign in with AWS / KLAM' : 'Sign in with DA';
  const lifetime = sessionLifetime(auth);
  const refresh = aws && auth.refreshable
    ? 'Automatic credential refresh is available while the saved AWS login session remains valid; its deadline is not provided.'
    : aws ? 'Automatic refresh is not confirmed for this credential source.'
      : 'DA tokens cannot renew silently during a run.';
  $(`${prefix}-expiry`).textContent = `${lifetime.text} ${refresh}`;
}

function sessionLifetime(auth) {
  if (!auth) return { text: 'Checking session lifetime.', warning: false };
  const expires = Date.parse(auth.expiresAt);
  if (!Number.isFinite(expires)) {
    return { text: auth.status === 'authenticated' ? 'Expiry unavailable.' : 'Not connected.', warning: auth.status !== 'checking' };
  }
  const minutes = Math.max(0, Math.ceil((expires - Date.now()) / 60_000));
  const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  const time = new Date(expires).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  return {
    text: `${expires <= Date.now() ? 'Expired' : `Expires in ${remaining}`} (${time}).`,
    warning: minutes <= 30,
  };
}

function renderSessions() {
  $('#session-status').hidden = step === 1;
  for (const [selector, label, auth] of [
    ['#da-session-summary', 'DA token', currentAuth],
    ['#aws-session-summary', 'AWS credentials', currentAwsAuth],
  ]) {
    const lifetime = sessionLifetime(auth);
    $(selector).textContent = `${label}: ${lifetime.text}${auth?.refreshable ? ' Auto-refresh available; login-session deadline unknown.' : ''}`;
    $(selector).dataset.state = lifetime.warning ? 'warning' : 'idle';
  }
  const daExpiry = Date.parse(currentAuth?.expiresAt);
  const warnings = [];
  if (currentAuth?.status === 'authenticated'
    && (!Number.isFinite(daExpiry) || daExpiry - Date.now() <= 30 * 60_000)) {
    warnings.push(Number.isFinite(daExpiry)
      ? 'DA token lifetime is short. Renew your DA sign-in before starting a long run.'
      : 'DA token expiry is unavailable, so its lifetime cannot be guaranteed for a long run.');
    warnings.push('A running job keeps its initial DA token and cannot renew it silently.');
  }
  if (step > 1 && !authenticated() && !active() && !pendingAction) {
    warnings.push('Reconnect the required accounts in Sign in before starting another run. Your site selection is kept.');
  }
  $('#session-warning').hidden = !warnings.length;
  $('#session-warning').textContent = warnings.join(' ');
}

function renderConfigs(configs) {
  const serialized = JSON.stringify(configs);
  if (serialized === displayedConfigs) return;
  displayedConfigs = serialized;
  const area = $('#configs');
  area.replaceChildren();
  for (const [site, config] of Object.entries(configs)) {
    const panel = element('article');
    panel.append(element('h3', site), element('p', 'Aggregated configuration from api.aem.live', 'hint'));
    for (const property of ['content', 'access', 'editor']) {
      panel.append(Object.hasOwn(config, property)
        ? jsonDetails(property, config[property]) : element('p', `${property}: not configured`, 'hint'));
    }
    panel.append(jsonDetails('Whole config', config));
    area.append(panel);
  }
}

function renderState(job, report) {
  const area = $('#migration-state');
  area.replaceChildren(element('h2', 'Configuration & destination'));
  const cards = element('div', undefined, 'state-cards');
  const source = element('article', undefined, 'state-card');
  source.append(element('h3', 'Keep the content bus stable'));
  const config = job.configs?.[job.source];
  const fixed = config?.content?.fixedContentBusId;
  if (!config) {
    source.classList.add('state-unknown');
    source.append(element('p', 'Source configuration unavailable. Content bus preservation has not been checked.'));
  } else if (fixed === true) {
    source.classList.add('state-ok');
    source.append(element('p', 'fixedContentBusId: Enabled'), element('p', 'The existing content and media bus is preserved when the source URL changes.'));
  } else if (typeof fixed === 'string' && /^[0-9a-f]{32,64}$/.test(fixed)) {
    source.classList.add('state-ok');
    source.append(element('p', 'fixedContentBusId: Legacy bus ID'), element('p', 'An explicit bus ID is pinned. The recommended setting before cutover is content.fixedContentBusId: true.'));
  } else {
    source.classList.add('state-warning');
    source.append(element('p', 'Content bus preservation needs attention'), element('p', 'Before cutover, set content.fixedContentBusId to true while the source still points to DA. Without it, switching sources can make existing content or media unavailable.'));
  }
  source.append(element('p', 'This workflow inspects configuration; it never changes it.', 'hint'));
  const target = element('article', undefined, 'state-card');
  target.append(element('h3', 'HLX6 destination'));
  const count = report?.targetObjects;
  target.classList.add(count === undefined ? 'state-unknown' : count === 0 ? 'state-ok' : 'state-warning');
  if (count === undefined) {
    target.append(element('p', 'Target inventory was not completed. An empty destination has not been established.'));
  } else if (count === 0) {
    target.append(element('p', 'No stored objects at the destination'), element('p', 'The target source-bus prefix is empty. This is separate from site configuration existence.'));
  } else {
    target.append(element('p', `${number(count)} stored objects / ${number(report.targetFiles)} files`), element('p', 'The target is not empty. Real execution requires explicit overwrite, even for folder markers. Unplanned objects and conflicts still block execution.'));
  }
  cards.append(source, target);
  area.append(cards);
}

function renderAnalysis() {
  const report = analysisReport();
  const running = currentJob?.status === 'running' && !currentJob.fullValidation;
  $('#analysis-loading').hidden = !running;
  $('#analysis-results').hidden = !report;
  $('#analysis-failed').hidden = running || Boolean(report) || currentJob?.status !== 'failed';
  $('#analysis-footer').hidden = running || Boolean(pendingAction);
  $('#analysis-continue').disabled = locked() || !report || report.blockers.length > 0;
  $('#retry-analysis').disabled = locked() || !authenticated();
  $('#analysis-title').textContent = report?.blockers.length ? 'First pass found blockers' : 'Your first-pass analysis';
  $('#analysis-symbol').textContent = report?.blockers.length ? '!' : '\u2713';
  if (running) renderProgress();
  if (!report) return;
  metrics($('#analysis-metrics'), [
    ['Source objects', number(report.sourceObjects)],
    ['Source stored size', size(report.sourceBytes)],
    ['Destination objects', number(report.targetObjects)],
  ]);
  findings($('#analysis-findings'), report);
  renderState(currentJob, report);
  renderConfigs(currentJob.configs ?? {});
}

function renderProgress() {
  if (!currentJob) return;
  const progress = currentJob.progress ?? {};
  $('#progress-phase').textContent = currentJob.phase;
  for (const bar of document.querySelectorAll('[data-progress-bar]')) {
    if (progress.total > 0 && progress.completed !== undefined) {
      bar.max = progress.total;
      bar.value = progress.completed;
    } else {
      bar.removeAttribute('value');
    }
  }
  const counts = [];
  if (progress.completed !== undefined) counts.push(`${number(progress.completed)}${progress.total === undefined ? ' processed' : ` / ${number(progress.total)}`}`);
  if (progress.bytes !== undefined) counts.push(size(progress.bytes));
  if (progress.shardsTotal !== undefined) counts.push(`${number(progress.shardsCompleted)} / ${number(progress.shardsTotal)} listing shards`);
  if (progress.pages !== undefined) counts.push(`${number(progress.pages)} pages`);
  for (const node of document.querySelectorAll('[data-progress-count]')) {
    node.textContent = counts.join(' \u00b7 ') || 'Working - no measurable total for this operation';
  }
  const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(currentJob.startedAt)) / 1000));
  for (const node of document.querySelectorAll('[data-progress-elapsed]')) {
    node.textContent = Number.isFinite(elapsed) ? `Elapsed ${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : 'Elapsed time unavailable';
  }
  const updated = Math.max(0, Math.floor((Date.now() - Date.parse(currentJob.updatedAt)) / 1000));
  for (const node of document.querySelectorAll('[data-progress-updated]')) {
    node.textContent = connectionError ? 'Disconnected. Reconnect to refresh progress.'
      : updated >= 15 ? `Connected \u00b7 last operation update ${updated}s ago. Some operations do not emit counts.`
        : 'Connected \u00b7 progress refreshes every second';
  }
}

function inventoryTable(report) {
  const table = element('table');
  const head = element('thead');
  const heading = element('tr');
  for (const text of ['Inventory', 'DA source', 'HLX6 destination']) heading.append(element('th', text));
  head.append(heading);
  const body = element('tbody');
  function row(label, source, target) {
    const tr = element('tr');
    tr.append(element('th', label), element('td', source), element('td', target));
    body.append(tr);
  }
  row('Stored objects', number(report.sourceObjects), number(report.targetObjects));
  row('Stored size', size(report.sourceBytes), size(report.targetBytes));
  row('Content bus ID', report.sourceContentBusId ?? 'Not resolved', report.targetContentBusId ?? 'Not resolved');
  for (const [key, label] of Object.entries({
    content: 'Content', versionHistory: 'Version history', trash: 'Trash', internal: 'Internal / sidecars',
  })) {
    const describe = (summary) => summary?.[key]
      ? `${number(summary[key].objects)} objects / ${size(summary[key].bytes)}` : 'Not checked';
    row(label, describe(report.sourceSummary), describe(report.targetSummary));
  }
  table.append(head, body);
  return table;
}

function renderReport() {
  const report = currentJob?.fullValidation ? currentJob.report : undefined;
  const signature = JSON.stringify([currentJob?.startedAt, currentJob?.finishedAt, currentJob?.status]);
  if (signature === displayedReport) return;
  displayedReport = signature;
  const area = $('#report');
  area.replaceChildren();
  if (!report) {
    const panel = element('article', undefined, 'panel report-outcome blocked');
    panel.append(element('span', 'Incomplete validation', 'pill'), element('h2', 'The dry run did not finish'),
      element('p', 'No complete migration plan is available. Review the error above, reconnect accounts if needed, and run a new dry run. No remote writes were performed.'));
    area.append(panel);
    return;
  }
  const blocked = report.blockers.length > 0;
  const panel = element('article', undefined, `panel report-outcome${blocked ? ' blocked' : ''}`);
  panel.append(element('span', blocked ? 'Action required' : 'Full validation finished', 'pill'),
    element('h2', blocked ? 'Resolve blockers before migrating' : 'Dry run complete. Nothing changed remotely.'),
    element('p', blocked ? 'The plan is incomplete or blocked. Address the findings below, then run full validation again.'
      : 'These are planned actions, not completed writes. Review warnings and configuration requirements before scheduling a real migration.'));
  const cards = element('div', undefined, 'metrics');
  metrics(cards, [
    ['Objects in migration plan', number(report.objects ?? report.plannedObjects?.length)],
    ['Image upload candidates', number(report.imageUrls?.length)],
    ['Blockers / warnings', `${report.blockers.length} / ${report.warnings.length}`],
  ]);
  panel.append(cards);
  const issues = element('div');
  findings(issues, report);
  panel.append(issues);
  area.append(panel);

  const actions = element('article', undefined, 'panel');
  actions.append(element('h2', 'What a real migration would do'));
  if (blocked) actions.append(element('p', 'Only actions checked before the blocker are known. Any counts below may describe a partial plan.', 'notice'));
  const list = element('ul', undefined, 'check-list');
  if (report.statuses) {
    for (const [status, description] of [
      ['planned', 'new content / history objects would be written'],
      ['exists', 'identical migration objects would be reused'],
      ['overwrite', 'existing objects would be overwritten with explicit permission'],
    ]) {
      list.append(element('li', `${number(report.statuses.filter((item) => item.status === status).length)} ${description}`));
    }
  } else {
    list.append(element('li', 'Destination write plan not completed; object actions are not confirmed.'));
  }
  list.append(element('li', report.imageUrls
    ? `${number(report.imageUrls.length)} image URLs would be considered for upload and rewriting; actual upload success is not tested by a dry run.`
    : 'Image upload candidates were not fully checked.'));
  list.append(element('li', {
    planned: 'Copy the DA project configuration into the target editor.da configuration.',
    exists: 'Keep the target project configuration, which already matches.',
    absent: 'No source project configuration is available to copy.',
  }[report.projectConfig?.status] ?? 'Project configuration changes have not been confirmed.'));
  list.append(element('li', 'Leave source content untouched. Switching the site to HLX6 is a separate, future step.'));
  actions.append(list);
  if (report.targetObjects > 0) actions.append(element('p', 'Destination is not empty. Execution requires explicit overwrite and still refuses unplanned objects or configuration conflicts.', 'notice'));
  area.append(actions);

  const details = element('details', undefined, 'panel');
  details.append(element('summary', 'Inventory & technical details'), inventoryTable(report));
  if (report.preflight) details.append(jsonDetails('Preflight checks', report.preflight));
  details.append(element('p', `Excluded objects: ${number(report.excluded?.length)}`, 'hint'));
  if (report.sourceDump) details.append(element('p', `${report.sourceSnapshotComplete === false ? 'Partial' : 'Retained'} private source snapshot: ${report.sourceDump}. Remove it manually when no longer needed.`, 'hint'));
  details.append(jsonDetails('Full JSON report', report));
  area.append(details);
}

function renderWorkflow() {
  const busy = locked();
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = Number(panel.dataset.panel) !== step;
  $('#step-label').textContent = `Step 0${step} / 05`;
  $('#page-title').textContent = headings[step - 1][0];
  $('#page-description').textContent = headings[step - 1][1];
  const completed = [
    authenticated(), Boolean(currentJob), Boolean(analysisReport()) && !analysisReport().blockers.length,
    currentJob?.fullValidation && ['complete', 'blocked'].includes(currentJob.status), false,
  ];
  for (const button of document.querySelectorAll('[data-step]')) {
    const value = Number(button.dataset.step);
    button.disabled = busy || value > unlocked;
    button.dataset.complete = String(Boolean(completed[value - 1]));
    button.querySelector('.step-number').textContent = completed[value - 1] ? '\u2713' : value;
    button.querySelector('.step-status').textContent = completed[value - 1] ? 'Complete' : value === step ? 'Current step' : '';
    if (value === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  for (const button of document.querySelectorAll('[data-go]')) button.disabled = busy || Number(button.dataset.go) > unlocked;
  $('#sign-in').disabled = busy;
  $('#aws-sign-in').disabled = busy;
  $('#auth-continue').disabled = busy || !authenticated();
  $('#auth-hint').textContent = authenticated() ? 'Both accounts connected. You are ready to choose a site.' : 'Connect both accounts to continue.';
  $('#inputs').disabled = busy;
  $('#prepare-button').disabled = busy || !authenticated();
  $('#run-dry-run').disabled = busy || !authenticated() || !analysisReport() || analysisReport().blockers.length > 0;
  $('#rerun-dry-run').disabled = busy;
  $('#reconnect').disabled = Boolean(pendingAction);
  form.setAttribute('aria-busy', String(active()));
  $('#site-context').hidden = step < 3 || !currentJob;
  $('#context-source').textContent = currentJob?.source ?? '';
  $('#context-target').textContent = currentJob?.target ?? '';
  renderAuth(currentAuth);
  renderAuth(currentAwsAuth, true);
  renderSessions();
  renderActivity();
  if (step === 3) renderAnalysis();
  const runningDryRun = currentJob?.fullValidation && currentJob.status === 'running';
  $('#dry-run-intro').hidden = Boolean(runningDryRun);
  $('#dry-run-progress').hidden = !runningDryRun;
  $('#dry-run-footer').hidden = Boolean(runningDryRun) || pendingAction === 'dry-run';
  if (step === 4 && runningDryRun) renderProgress();
  if (step === 5) renderReport();
}

async function request(endpoint, body) {
  const response = await fetch(endpoint, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function selection() {
  const source = `${form.elements.org.value}/${form.elements.site.value}`;
  return {
    source,
    target: differentTarget.checked ? `${form.elements.targetOrg.value}/${form.elements.targetSite.value}` : source,
    ignoredFolders: form.elements.ignoredFolders.value.split(/\r?\n/).map((folder) => folder.trim()).filter(Boolean),
  };
}

function matchesSelection(job) {
  const selected = selection();
  const folders = (values) => JSON.stringify([...new Set(values.map((value) => value.replace(/\/+$/, '')))].sort());
  return job.source === selected.source && job.target === selected.target
    && folders(job.ignoredFolders ?? []) === folders(selected.ignoredFolders);
}

function updateTargetFields() {
  targetFields.hidden = !differentTarget.checked;
  $('#same-target-hint').hidden = differentTarget.checked;
  for (const input of targetFields.querySelectorAll('input')) input.disabled = !differentTarget.checked;
  if (differentTarget.checked) {
    form.elements.targetOrg.value ||= form.elements.org.value;
    form.elements.targetSite.value ||= form.elements.site.value;
  }
}

function saveSelection() {
  hasSelection = true;
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({
      org: form.elements.org.value, site: form.elements.site.value,
      targetOrg: form.elements.targetOrg.value, targetSite: form.elements.targetSite.value,
      differentTarget: differentTarget.checked, ignoredFolders: form.elements.ignoredFolders.value,
    }));
    $('#selection-notice').hidden = true;
  } catch {
    $('#selection-notice').textContent = 'Your site selection could not be saved in browser storage. It will not be remembered after reload.';
    $('#selection-notice').hidden = false;
  }
}

function restoreSelection() {
  try {
    const stored = localStorage.getItem(SELECTION_KEY);
    if (stored === null) return;
    const selected = JSON.parse(stored);
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)
      || !['org', 'site', 'targetOrg', 'targetSite'].every((key) => typeof selected[key] === 'string')
      || typeof selected.differentTarget !== 'boolean'
      || (selected.ignoredFolders !== undefined && typeof selected.ignoredFolders !== 'string')) {
      throw new Error('Invalid saved site selection');
    }
    for (const key of ['org', 'site', 'targetOrg', 'targetSite']) form.elements[key].value = selected[key];
    form.elements.ignoredFolders.value = selected.ignoredFolders ?? '';
    differentTarget.checked = selected.differentTarget;
    updateTargetFields();
    hasSelection = true;
  } catch {
    $('#selection-notice').textContent = 'Your saved site selection could not be restored. Please enter it again.';
    $('#selection-notice').hidden = false;
  }
}

function adoptSelection(job) {
  [form.elements.org.value, form.elements.site.value] = job.source.split('/');
  [form.elements.targetOrg.value, form.elements.targetSite.value] = job.target.split('/');
  differentTarget.checked = job.source !== job.target;
  form.elements.ignoredFolders.value = (job.ignoredFolders ?? []).join('\n');
  updateTargetFields();
  saveSelection();
}

async function refreshSnapshot(initial = false) {
  const [job, auth, awsAuth] = await Promise.all([
    request('/api/prepare'), request('/api/auth'), request('/api/aws-auth'),
  ]);
  currentAuth = auth;
  currentAwsAuth = awsAuth;
  pendingAction = null;
  connectionError = false;
  if (authenticated()) unlocked = Math.max(unlocked, 2);
  if (job?.status === 'running' || (job && (!hasSelection || matchesSelection(job)))) {
    const changed = !currentJob || currentJob.startedAt !== job.startedAt || currentJob.status !== job.status;
    if (job.status === 'running' || !hasSelection) adoptSelection(job);
    currentJob = job;
    const jobStep = job.fullValidation ? job.status === 'running' ? 4 : 5 : 3;
    unlocked = Math.max(unlocked, jobStep);
    if (initial || changed) setStep(jobStep, !initial);
  } else {
    currentJob = undefined;
    if (initial && authenticated()) step = 2;
  }
  renderWorkflow();
}

function showError(error) {
  pendingAction = null;
  actionError = error.message;
  // A lost response can hide a successfully started operation. Reconnect before retrying.
  connectionError = error.status !== 400;
  renderWorkflow();
}

async function follow() {
  if (following) return;
  following = true;
  try {
    while (active()) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      await refreshSnapshot();
    }
  } catch (error) {
    showError(error);
  } finally {
    following = false;
  }
}

async function perform(endpoint, body, action) {
  pendingAction = action;
  actionError = '';
  renderWorkflow();
  try {
    await request(endpoint, body);
    await refreshSnapshot();
    await follow();
  } catch (error) {
    showError(error);
  }
}

async function reconnect(initial = false) {
  pendingAction = 'status';
  actionError = '';
  renderWorkflow();
  try {
    await refreshSnapshot(initial);
    await follow();
  } catch (error) {
    showError(error);
  }
}

for (const button of document.querySelectorAll('[data-step], [data-go]')) {
  button.addEventListener('click', () => {
    const next = Number(button.dataset.step ?? button.dataset.go);
    if (!locked() && next <= unlocked) setStep(next);
  });
}
$('#auth-continue').addEventListener('click', () => setStep(2));
$('#analysis-continue').addEventListener('click', () => {
  unlocked = Math.max(unlocked, 4);
  setStep(4);
});
$('#rerun-dry-run').addEventListener('click', () => setStep(4));
$('#sign-in').addEventListener('click', () => perform('/api/auth', {}, 'auth'));
$('#aws-sign-in').addEventListener('click', () => perform('/api/aws-auth', {}, 'aws-auth'));
$('#reconnect').addEventListener('click', () => reconnect());

function selectionChanged() {
  if (currentJob && !matchesSelection(currentJob)) {
    currentJob = undefined;
    unlocked = 2;
    actionError = '';
  }
  saveSelection();
  renderWorkflow();
}
differentTarget.addEventListener('change', () => {
  updateTargetFields();
  selectionChanged();
});
form.addEventListener('input', selectionChanged);

async function startPreparation(fullValidation) {
  if (locked() || !authenticated() || !form.reportValidity()) return;
  if (fullValidation && (!analysisReport() || analysisReport().blockers.length)) return;
  saveSelection();
  unlocked = fullValidation ? 4 : 3;
  step = fullValidation ? 4 : 3;
  await perform('/api/prepare', { ...selection(), fullValidation }, fullValidation ? 'dry-run' : 'analysis');
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  startPreparation(false);
});
$('#retry-analysis').addEventListener('click', () => startPreparation(false));
$('#run-dry-run').addEventListener('click', () => startPreparation(true));

restoreSelection();
await reconnect(true);
window.setInterval(async () => {
  if (active() || pendingAction || following || connectionError || refreshingAuth) return;
  refreshingAuth = true;
  renderWorkflow();
  try {
    [currentAuth, currentAwsAuth] = await Promise.all([request('/api/auth'), request('/api/aws-auth')]);
    if (authenticated()) unlocked = Math.max(unlocked, 2);
    renderWorkflow();
  } catch (error) {
    showError(error);
  } finally {
    refreshingAuth = false;
    renderWorkflow();
  }
}, 30_000);
