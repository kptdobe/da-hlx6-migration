const form = document.querySelector('#prepare-form');
const inputs = document.querySelector('#inputs');
const differentTarget = document.querySelector('#different-target');
const targetFields = document.querySelector('#target-fields');
const status = document.querySelector('#status');
const activity = document.querySelector('#activity');
const activityTitle = document.querySelector('#activity-title');
const activitySpinner = document.querySelector('#activity-spinner');
const prepareButton = document.querySelector('#prepare-button');
const errorBox = document.querySelector('#error');
const stateArea = document.querySelector('#migration-state');
const authMessage = document.querySelector('#auth-message');
const authError = document.querySelector('#auth-error');
const signIn = document.querySelector('#sign-in');
const configArea = document.querySelector('#configs');
const reportArea = document.querySelector('#report');
const selectionNotice = document.querySelector('#selection-notice');
const SELECTION_KEY = 'da-hlx6-migration.site-selection.v1';
let displayedConfigs;
let displayedReport;
let preparing = false;
let currentJob;
let currentAuth;
let pendingAction = 'status';
let connectionError = false;
let hasSelection = false;

function renderActivity() {
  let title = 'Ready to prepare';
  let detail = 'No preparation is running.';
  let state = 'idle';
  if (connectionError) {
    title = 'Activity status unavailable';
    detail = 'The server may still be working. Reload to reconnect before trying again.';
    state = 'warning';
  } else if (pendingAction) {
    title = pendingAction === 'prepare' ? 'Starting preparation...'
      : pendingAction === 'auth' ? 'Starting DA sign-in...' : 'Checking activity...';
    detail = 'Waiting for the local server.';
    state = 'running';
  } else if (currentAuth?.status === 'signing-in') {
    title = 'DA sign-in in progress';
    detail = currentAuth.message;
    state = 'running';
  } else if (preparing) {
    const configsLoaded = currentJob.configs?.[currentJob.source]
      && currentJob.configs?.[currentJob.target];
    title = configsLoaded ? 'Dry-run running' : 'Loading site configuration';
    detail = currentJob.phase;
    state = 'running';
  } else if (currentAuth?.status === 'failed') {
    title = 'DA sign-in failed';
    detail = currentAuth.message;
    state = 'failed';
  } else if (currentJob?.status === 'blocked') {
    title = 'Dry-run blocked';
    detail = 'The dry-run has stopped. Review the blockers in the report below.';
    state = 'warning';
  } else if (currentJob?.status === 'failed') {
    title = 'Preparation failed';
    detail = 'Preparation has stopped. Review the error below.';
    state = 'failed';
  } else if (currentJob?.status === 'complete') {
    title = 'Preparation complete';
    detail = 'The dry-run has finished. No remote writes were performed.';
    state = 'complete';
  }
  activity.dataset.state = state;
  activityTitle.textContent = title;
  status.textContent = detail;
  activitySpinner.hidden = state !== 'running';
  form.setAttribute('aria-busy', String(state === 'running'));
  prepareButton.textContent = preparing || pendingAction === 'prepare' ? 'Preparing...' : 'Prepare Migration';
}

function renderAuth(auth) {
  currentAuth = auth;
  const signingIn = auth.status === 'signing-in';
  authMessage.textContent = auth.message;
  authError.hidden = !auth.error;
  authError.textContent = auth.error ?? '';
  signIn.disabled = signingIn || preparing;
  signIn.textContent = signingIn ? 'Signing in...' : auth.status === 'authenticated' ? 'Sign in again with DA' : 'Sign in with DA';
  inputs.disabled = signingIn || preparing;
  renderActivity();
}

async function refreshAuth() {
  const auth = await request(undefined, '/api/auth');
  renderAuth(auth);
  return auth;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function jsonDetails(title, value, open = false) {
  const details = element('details');
  details.open = open;
  details.append(element('summary', title), element('pre', JSON.stringify(value, null, 2)));
  return details;
}

function renderConfigs(configs) {
  const serialized = JSON.stringify(configs);
  if (serialized === displayedConfigs) return;
  displayedConfigs = serialized;
  configArea.replaceChildren();
  configArea.hidden = !Object.keys(configs).length;
  for (const [site, config] of Object.entries(configs)) {
    const panel = element('article', undefined, 'panel');
    panel.append(element('h2', `Configuration: ${site}`));
    panel.append(element('p', 'Aggregated configuration from api.aem.live', 'hint'));
    for (const property of ['content', 'access', 'editor']) {
      if (Object.hasOwn(config, property)) {
        panel.append(jsonDetails(property, config[property], true));
      } else {
        panel.append(element('p', `${property}: not configured`, 'hint'));
      }
    }
    panel.append(jsonDetails('Whole config', config));
    configArea.append(panel);
  }
}

function size(bytes) {
  return bytes === undefined ? 'Unknown' : `${bytes.toLocaleString()} bytes`;
}

function renderState(job) {
  stateArea.replaceChildren();
  stateArea.hidden = !job;
  if (!job) return;
  stateArea.append(element('h2', 'Migration state'));
  const cards = element('div', undefined, 'state-cards');
  const source = element('article', undefined, 'state-card');
  source.append(element('h3', `Source: ${job.source}`));
  const config = job.configs?.[job.source];
  const fixed = config?.content?.fixedContentBusId;
  if (!config) {
    source.classList.add('state-unknown');
    source.append(element('p', 'fixedContentBusId: Unknown'));
    source.append(element('p', job.status === 'failed' ? 'Source config could not be loaded.' : 'Waiting for source config.'));
  } else if (fixed === true) {
    source.classList.add('state-ok');
    source.append(element('p', 'fixedContentBusId: Enabled (true)'));
    source.append(element('p', 'The existing content bus ID is preserved when the content source URL changes, keeping content and media on the same bus.'));
  } else if (typeof fixed === 'string' && /^[0-9a-f]{32,64}$/.test(fixed)) {
    source.classList.add('state-ok');
    source.append(element('p', 'fixedContentBusId: Set (legacy bus ID)'));
    source.append(element('p', 'An explicit content bus ID is pinned. The recommended setting before cutover is content.fixedContentBusId: true.'));
  } else {
    source.classList.add('state-warning');
    const unset = fixed === undefined || fixed === null || fixed === false || fixed === '';
    source.append(element('p', unset ? 'fixedContentBusId: Not set / disabled' : 'fixedContentBusId: Invalid setting'));
    source.append(element('p', 'Set content.fixedContentBusId to true on the source config before changing content.source.url. This preserves the existing contentBusId for content and media. Without it, switching sources can select a different bus and make existing content or media unavailable.'));
    source.append(element('p', 'This UI only inspects the setting; it does not change it.', 'hint'));
  }
  const target = element('article', undefined, 'state-card');
  target.append(
    element('h3', `Target: ${job.target}`),
    element('p', `helix-source-bus/${job.target}/`, 'hint'),
  );
  const count = job.report?.targetObjects;
  const files = job.report?.targetFiles;
  if (count === undefined) {
    target.classList.add('state-unknown');
    target.append(element('p', 'Exists in source bus: Unknown'));
    target.append(element('p', 'Contains files: Unknown'));
    target.append(element('p', job.status === 'running'
      ? 'Waiting for target inventory.'
      : 'Target inventory was not completed; absence has not been established.'));
  } else if (count === 0) {
    target.classList.add('state-ok');
    target.append(element('p', 'Exists in source bus: No'), element('p', 'Contains files: No'));
    target.append(element('p', 'No objects exist under the target prefix. Site config existence is separate from source-bus existence.'));
  } else {
    target.classList.add('state-warning');
    target.append(element('p', `Exists in source bus: Yes (${count.toLocaleString()} objects)`));
    target.append(element('p', files === undefined ? 'Contains files: Unknown'
      : files === 0 ? 'Contains files: No (folder markers only)'
        : `Contains files: Yes (${files.toLocaleString()} files)`));
    target.append(element('p', 'The target is not empty. Migration execution requires explicit overwrite even if it contains only folder markers. No overwrite is performed by this UI.'));
  }
  cards.append(source, target);
  stateArea.append(cards);
}

function renderReport(report) {
  if (report === displayedReport) return;
  displayedReport = report;
  reportArea.replaceChildren();
  reportArea.hidden = !report;
  if (!report) return;
  const blocked = report.blockers.length > 0;
  reportArea.append(
    element('h2', blocked ? 'Dry-run: blocked' : 'Dry-run summary'),
    element('p', `${report.source} -> ${report.target}`),
    element('p', `Validation: ${report.validation}. No remote writes performed.`, 'hint'),
  );
  if (report.validation === 'inventory') {
    reportArea.append(element('p', 'Inventory only: this does not establish migration readiness. Body-dependent checks are skipped.', 'notice'));
  }
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
  row('Objects', report.sourceObjects?.toLocaleString() ?? 'Unknown', report.targetObjects?.toLocaleString() ?? 'Unknown');
  row('Stored size', size(report.sourceBytes), size(report.targetBytes));
  row('Content bus ID', report.sourceContentBusId ?? 'Unknown', report.targetContentBusId ?? 'Unknown');
  for (const [key, label] of Object.entries({
    content: 'Content', versionHistory: 'Version history', trash: 'Trash', internal: 'Internal / sidecars',
  })) {
    const describe = (summary) => summary?.[key]
      ? `${summary[key].objects.toLocaleString()} objects / ${size(summary[key].bytes)}` : 'Unknown';
    row(label, describe(report.sourceSummary), describe(report.targetSummary));
  }
  table.append(head, body);
  reportArea.append(table);
  if (report.sourceConfigWarning) reportArea.append(element('p', report.sourceConfigWarning, 'notice'));
  for (const [title, items] of [
    ['Blockers', report.blockers],
    ['Warnings', report.warnings],
    ['Skipped checks', report.skippedChecks ?? []],
  ]) {
    reportArea.append(element('h3', `${title} (${items.length})`));
    const list = element('ul');
    for (const item of items) {
      list.append(element('li', typeof item === 'string' ? item
        : `${item.id}: ${item.description ?? item.reason}${item.count === undefined ? '' : ` (${item.count})`}`));
    }
    reportArea.append(list);
  }
  if (report.preflight) reportArea.append(jsonDetails('Preflight checks', report.preflight));
  if (report.projectConfig) reportArea.append(element('p', `Project config: ${report.projectConfig.status}`));
  if (report.plannedObjects) reportArea.append(element('p', `Planned objects: ${report.plannedObjects.length}; excluded: ${report.excluded?.length ?? 0}; image candidates: ${report.imageUrls?.length ?? 0}`));
  if (report.sourceDump) reportArea.append(element('p', `Retained source snapshot: ${report.sourceDump}`));
  reportArea.append(jsonDetails('Whole dry-run report', report));
}

function render(job) {
  currentJob = job;
  pendingAction = null;
  connectionError = false;
  preparing = job?.status === 'running';
  inputs.disabled = preparing;
  signIn.disabled = preparing;
  renderActivity();
  errorBox.hidden = !job?.error;
  errorBox.textContent = job?.error ?? '';
  renderState(job);
  renderConfigs(job?.configs ?? {});
  renderReport(job?.report);
}

async function request(options, endpoint = '/api/prepare') {
  const response = await fetch(endpoint, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

async function follow(job) {
  render(job);
  let auth = await refreshAuth();
  while (job?.status === 'running' || auth.status === 'signing-in') {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    job = await request();
    render(job);
    auth = await refreshAuth();
  }
}

function showError(error) {
  pendingAction = null;
  connectionError = true;
  inputs.disabled = false;
  errorBox.textContent = error.message;
  errorBox.hidden = false;
  renderActivity();
}

signIn.addEventListener('click', async () => {
  signIn.disabled = true;
  inputs.disabled = true;
  pendingAction = 'auth';
  connectionError = false;
  renderActivity();
  try {
    let auth = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, '/api/auth');
    pendingAction = null;
    renderAuth(auth);
    while (auth.status === 'signing-in') {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      auth = await refreshAuth();
    }
  } catch (error) {
    pendingAction = null;
    connectionError = true;
    authError.textContent = error.message;
    authError.hidden = false;
    authMessage.textContent = 'Unable to retrieve sign-in status. Reload to reconnect before trying again.';
    signIn.disabled = false;
    inputs.disabled = false;
    renderActivity();
  }
});

function updateTargetFields() {
  targetFields.hidden = !differentTarget.checked;
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
      org: form.elements.org.value,
      site: form.elements.site.value,
      targetOrg: form.elements.targetOrg.value,
      targetSite: form.elements.targetSite.value,
      differentTarget: differentTarget.checked,
    }));
    selectionNotice.hidden = true;
  } catch {
    selectionNotice.textContent = 'Your site selection could not be saved in browser storage. It will not be remembered after reload.';
    selectionNotice.hidden = false;
  }
}

function restoreSelection() {
  try {
    const stored = localStorage.getItem(SELECTION_KEY);
    if (stored === null) return;
    const selection = JSON.parse(stored);
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || !['org', 'site', 'targetOrg', 'targetSite'].every((key) => typeof selection[key] === 'string')
      || typeof selection.differentTarget !== 'boolean') {
      throw new Error('Invalid saved site selection');
    }
    for (const key of ['org', 'site', 'targetOrg', 'targetSite']) form.elements[key].value = selection[key];
    differentTarget.checked = selection.differentTarget;
    updateTargetFields();
    hasSelection = true;
  } catch {
    selectionNotice.textContent = 'Your saved site selection could not be restored from browser storage. Please enter it again.';
    selectionNotice.hidden = false;
  }
}

differentTarget.addEventListener('change', () => {
  updateTargetFields();
  saveSelection();
});
form.addEventListener('input', saveSelection);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveSelection();
  const data = new FormData(form);
  const source = `${data.get('org')}/${data.get('site')}`;
  const target = differentTarget.checked ? `${data.get('targetOrg')}/${data.get('targetSite')}` : source;
  inputs.disabled = true;
  errorBox.hidden = true;
  pendingAction = 'prepare';
  connectionError = false;
  renderActivity();
  try {
    await follow(await request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, target, fullValidation: data.has('fullValidation') }),
    }));
  } catch (error) {
    showError(error);
  }
});

restoreSelection();
renderActivity();
try {
  const job = await request();
  if (job && (job.status === 'running' || !hasSelection)) {
    const [org, site] = job.source.split('/');
    const [targetOrg, targetSite] = job.target.split('/');
    form.elements.org.value = org;
    form.elements.site.value = site;
    differentTarget.checked = job.source !== job.target;
    form.elements.targetOrg.value = targetOrg;
    form.elements.targetSite.value = targetSite;
    updateTargetFields();
    form.elements.fullValidation.checked = job.fullValidation;
    if (!hasSelection) saveSelection();
  }
  await follow(job);
} catch (error) {
  showError(error);
}