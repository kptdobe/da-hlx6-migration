import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMigrationPlan, collectExternalImageUrls, firstEmail, parseAudit, rewriteImageUrls,
} from '../src/migration.js';
import { classifyDa } from '../src/classify.js';

const entry = (path, body, metadata = {}) => {
  const rel = path;
  return {
    key: `kptdobe/sample-content-da${rel}`,
    rel,
    ...classifyDa(rel),
    body: Buffer.from(body),
    metadata,
  };
};
const scope = { org: 'kptdobe', daSite: 'sample-content-da', hlx6Site: 'sample-content-hlx6-migrated' };

describe('parseAudit', () => {
  it('extracts version timestamp, author and id from DA audit TSV', () => {
    const result = parseAudit(Buffer.from('1790864951605\t[{"email":"a@example.com"}]\t/index.html\tPublished\t123e4567-e89b-12d3-a456-426614174000\n'));
    assert.deepEqual(result, [{
      timestamp: 1790864951605,
      user: 'a@example.com',
      path: '/index.html',
      label: 'Published',
      versionId: '123e4567-e89b-12d3-a456-426614174000',
    }]);
  });
  it('returns anonymous for malformed user JSON', () => {
    assert.equal(firstEmail('invalid'), 'anonymous');
  });
});

describe('buildMigrationPlan', () => {
  it('maps trashed folder markers to child JSON markers while preserving original paths and identity', () => {
    const metadata = { id: 'folder-id', path: 'sample-content-da/en_us/index', timestamp: '1790864889099' };
    const plan = buildMigrationPlan([
      entry('/en_us/index.props', '{}', metadata),
      entry('/.trash/en_us/index-2026-10-08t13-42-58-539z.props', '{}', metadata),
      entry('/.trash/.drafts-2026-10-08t13-42-58-539z.props', '{}', {
        id: 'hidden-folder-id', path: 'sample-content-da/.drafts',
      }),
    ], scope);
    const objects = Object.fromEntries(plan.objects.map((object) => [object.key, object]));
    const folder = objects['kptdobe/sample-content-hlx6-migrated/en_us/index/.props'];
    const trash = objects['kptdobe/sample-content-hlx6-migrated/.trash/en_us/index-2026-10-08t13-42-58-539z/.props'];
    assert.equal(trash.kind, 'trash');
    assert.equal(trash.contentType, 'application/json');
    assert.equal(trash.contentEncoding, 'gzip');
    assert.equal(trash.body.toString(), '{}');
    assert.equal(trash.metadata['doc-path'], '/en_us/index');
    assert.equal(trash.metadata['doc-id'], folder.metadata['doc-id']);
    assert.equal(trash.metadata['da-id'], 'folder-id');
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.trash/.drafts-2026-10-08t13-42-58-539z/.props'].metadata['doc-path'], '/.drafts');
    assert.deepEqual(plan.excluded, []);
  });
  it('preserves hidden folder markers and file names in target keys', () => {
    const plan = buildMigrationPlan([
      entry('/.drafts.props', '{}'),
      entry('/.drafts/.page.html', '<main>hidden</main>'),
      entry('/.config/.settings.json', '{}'),
      entry('/.drafts/.page.html.props', '{}'),
    ], scope);
    const objects = Object.fromEntries(plan.objects.map((object) => [object.key, object]));
    assert.equal(plan.objects.length, 3);
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.drafts/.props'].kind, 'folder');
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.drafts/.page.html'].contentType, 'text/html');
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.config/.settings.json'].contentType, 'application/json');
    assert.deepEqual(plan.excluded, [{
      key: 'kptdobe/sample-content-da/.drafts/.page.html.props', kind: 'props-sidecar',
    }]);
    assert.equal(plan.warnings.some((warning) => warning.id === 'renamed-paths'), false);
    assert.deepEqual(plan.warnings.find((warning) => warning.id === 'unmapped-objects').items,
      ['/.drafts/.page.html.props']);
  });
  it('maps document, sheet, binary, folder marker, trash and version objects', () => {
    const audit = entry('/.da-versions/doc-id/audit.txt', '1790864951605\t[{"email":"author@example.com"}]\t/index.html\tPublished\tversion-id\n');
    const rows = [
      entry('/index.html', '<html><main>Hi</main></html>', { id: 'doc-id', timestamp: '1790864889099', users: '[{"email":"author@example.com"}]' }),
      entry('/sample.json', '{"data":[]}', { id: 'sheet-id', timestamp: '1790864889099' }),
      entry('/.da/config.json', '{"contentBusId":"fixed-id"}', { id: 'da-config-id' }),
      entry('/images/a.jpg', 'imagebytes', { id: 'media-id' }),
      entry('/folder.props', '{}'),
      entry('/.trash/old.html', '<main>old</main>', { id: 'trash-id', path: 'sample-content-da/original.html', timestamp: '1790864889099' }),
      entry('/.da-versions/doc-id/version-id.html', '<main>Hi</main>', { label: 'Published', path: 'sample-content-da/index.html', timestamp: '1790864889099', users: '[{"email":"author@example.com"}]' }),
      audit,
    ];
    const plan = buildMigrationPlan(rows, scope);
    const bySource = Object.fromEntries(plan.objects.map((object) => [object.sourceKey, object]));
    const doc = bySource['kptdobe/sample-content-da/index.html'];
    assert.equal(doc.key, 'kptdobe/sample-content-hlx6-migrated/index.html');
    assert.equal(doc.contentEncoding, 'gzip');
    assert.equal(doc.metadata['last-modified-by'], 'author@example.com');
    assert.ok(doc.metadata['doc-id']);
    const daConfig = bySource['kptdobe/sample-content-da/.da/config.json'];
    assert.equal(daConfig.key, 'kptdobe/sample-content-hlx6-migrated/.da/config.json');
    assert.equal(daConfig.contentType, 'application/json');
    assert.equal(daConfig.contentEncoding, 'gzip');
    assert.equal(plan.excluded.some((item) => item.key.endsWith('/.da/config.json')), false);
    const image = bySource['kptdobe/sample-content-da/images/a.jpg'];
    assert.equal(image.contentEncoding, undefined);
    assert.equal(image.contentType, 'image/jpeg');
    assert.equal(bySource['kptdobe/sample-content-da/folder.props'].key, 'kptdobe/sample-content-hlx6-migrated/folder/.props');
    assert.equal(bySource['kptdobe/sample-content-da/.trash/old.html'].metadata['doc-path'], '/original.html');
    const version = bySource['kptdobe/sample-content-da/.da-versions/doc-id/version-id.html'];
    assert.equal(version.key, `kptdobe/sample-content-hlx6-migrated/.versions/${doc.metadata['doc-id']}/${version.versionUlid}`);
    assert.equal(version.metadata['version-by'], 'author@example.com');
    assert.equal(version.metadata['version-comment'], 'Published');
    assert.equal(plan.excluded.some((item) => item.kind === 'audit'), true);
  });

  it('migrates .da content and comment files through the ordinary content path', () => {
    const rows = [
      entry('/.da/anotherfile.json', '{"data":[]}'),
      entry('/.da/comments/doc/comment.json', '{"text":"comment"}'),
      entry('/.da/page.html', '<main>page</main>'),
      entry('/.da/folder.props', '{}'),
    ];
    const plan = buildMigrationPlan(rows, scope);
    const objects = Object.fromEntries(plan.objects.map((object) => [object.key, object]));
    assert.equal(plan.objects.length, 4);
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.da/anotherfile.json'].body.toString(), '{"data":[]}');
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.da/comments/doc/comment.json'].contentType, 'application/json');
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.da/page.html'].contentType, 'text/html');
    assert.equal(objects['kptdobe/sample-content-hlx6-migrated/.da/folder/.props'].kind, 'folder');
    assert.deepEqual(plan.excluded, []);
    assert.deepEqual(plan.warnings, []);
  });

  it('rejects source names that collide after hlx6 sanitization', () => {
    const rows = [entry('/my page.html', '<main/>'), entry('/my-page.html', '<main/>')];
    assert.throws(() => buildMigrationPlan(rows, scope), /preflight failed: path-collisions/);
  });

  it('preserves underscores in target content and folder keys without false collisions', () => {
    const plan = buildMigrationPlan([
      entry('/.drafts_folder.props', '{}'),
      entry('/.drafts_folder/.page_one.html', '<main/>'),
      entry('/my_page.html', '<main/>'),
      entry('/my-page.html', '<main/>'),
    ], scope);
    assert.deepEqual(plan.objects.map(({ key }) => key).sort(), [
      'kptdobe/sample-content-hlx6-migrated/.drafts_folder/.props',
      'kptdobe/sample-content-hlx6-migrated/.drafts_folder/.page_one.html',
      'kptdobe/sample-content-hlx6-migrated/my_page.html',
      'kptdobe/sample-content-hlx6-migrated/my-page.html',
    ].sort());
    assert.deepEqual(plan.warnings, []);
  });
});

describe('image URL handling', () => {
  const html = '<main><img src="https://images.example/a.jpg"><picture><source srcset="https://images.example/a.jpg 1x, https://images.example/b.jpg 2x"></picture><img src="./media_existing.png"></main>';
  it('collects unique external src and srcset URLs, preserving allowed relative media URLs', () => {
    assert.deepEqual(collectExternalImageUrls(html, 'kptdobe', 'sample'), [
      'https://images.example/a.jpg',
      'https://images.example/b.jpg',
    ]);
  });
  it('rewrites src and srcset URLs to relative media references', () => {
    const result = rewriteImageUrls(html, new Map([
      ['https://images.example/a.jpg', './media_a.jpg'],
      ['https://images.example/b.jpg', './media_b.jpg'],
    ]));
    assert.match(result, /src="\.\/media_a\.jpg"/);
    assert.match(result, /srcset="\.\/media_a\.jpg 1x, \.\/media_b\.jpg 2x"/);
    assert.match(result, /src="\.\/media_existing\.png"/);
  });

  it('rewrites same-site media delivery URLs to relative paths', () => {
    const source = '<main><img src="https://main--sample--kptdobe.aem.page/media_image.jpg#width=320"><source srcset="https://main--sample--kptdobe.aem.live/media_other.png 2x"></main>';
    const result = rewriteImageUrls(source, new Map(), 'kptdobe', 'sample');

    assert.match(result, /src="\.\/media_image\.jpg#width=320"/);
    assert.match(result, /srcset="\.\/media_other\.png 2x"/);
  });

  it('keeps absolute media URLs for other sites and non-media paths', () => {
    const source = '<main><img src="https://main--other--kptdobe.aem.page/media_image.jpg"><img src="https://main--sample--other.aem.live/media_image.jpg"><img src="https://main--sample--kptdobe.aem.page/images/image.jpg"></main>';
    const result = rewriteImageUrls(source, new Map(), 'kptdobe', 'sample');

    assert.match(result, /https:\/\/main--other--kptdobe\.aem\.page\/media_image\.jpg/);
    assert.match(result, /https:\/\/main--sample--other\.aem\.live\/media_image\.jpg/);
    assert.match(result, /https:\/\/main--sample--kptdobe\.aem\.page\/images\/image\.jpg/);
  });
});