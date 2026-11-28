import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { prepareReleasePromotion, releasePromotionMode } from '../scripts/prepare-release-promotion.mjs';
import { expectedExtensionArchiveEntries } from '../scripts/extension-package-files.mjs';
import { webRuntimeFiles } from '../scripts/web-package-files.mjs';
import { createZip } from './support/zip-fixture.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function archive(version, kind) {
  const legal = new Map([
    ['LICENSE', 'MIT License\nPermission is hereby granted.\n'],
    ['THIRD_PARTY_NOTICES.md', '# Third-party notices\n'],
    ['manifest.json', JSON.stringify({ version })],
    ['manifest.webmanifest', JSON.stringify({ name: 'Insta Toolbox', display: 'standalone' })],
    ['START_HERE.txt', 'Do not double-click index.html. Serve on HTTPS or localhost.\n'],
    ['VERSION.txt', `${version}\n`],
  ]);
  const entries = kind === 'extension' ? expectedExtensionArchiveEntries : [...webRuntimeFiles, 'START_HERE.txt', 'VERSION.txt'];
  return createZip(entries.map(name => ({
    path: kind === 'extension' ? name : `insta-toolbox-web/${name}`,
    content: legal.get(name) || `fixture:${name}\n`,
  })), { compression: 'store' });
}

async function fixture(t, version = '4.3.1') {
  const root = await mkdtemp(path.join(tmpdir(), 'insta-toolbox-promotion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const incoming = path.join(root, 'incoming');
  const output = path.join(root, 'release');
  await mkdir(incoming);
  await mkdir(path.join(root, 'docs', 'releases'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
  await writeFile(path.join(root, 'docs', 'releases', `${version}.md`), `Version ${version} fixes reviewed userscript behavior.\n`);
  const artifacts = new Map([
    [`Insta-Toolbox-${version}-universal.dmg`, Buffer.from('tested macOS disk image')],
    [`Insta-Toolbox-${version}-universal.zip`, Buffer.from('tested macOS archive')],
    [`Insta-Toolbox-Extension-${version}.zip`, archive(version, 'extension')],
    [`Insta-Toolbox-Setup-${version}.exe`, Buffer.from('tested Windows installer')],
    [`insta-toolbox-web-${version}.zip`, archive(version, 'web')],
    ['insta-toolbox.user.js', Buffer.from(`// ==UserScript==\n// @version      ${version}\n// ==/UserScript==\nconst tested = true;\n`)],
  ]);
  const writeManifest = () => writeFile(path.join(incoming, 'SHA256SUMS.txt'),
    `${[...artifacts].map(([name, bytes]) => `${digest(bytes)}  ${name}`).join('\n')}\n`);
  for (const [name, bytes] of artifacts) await writeFile(path.join(incoming, name), bytes);
  await writeManifest();
  return {
    root, incoming, output, artifacts, writeManifest,
    promote: () => prepareReleasePromotion({ repositoryRoot: root, tag: `v${version}` }),
  };
}

test('promotion keeps 4.3.1 full distribution and selects userscript for newer semantic versions', () => {
  assert.equal(releasePromotionMode('4.3.1'), 'legacy');
  for (const version of ['4.3.2', '4.4.0', '5.0.0', '10.0.0']) assert.equal(releasePromotionMode(version), 'userscript');
  for (const version of ['4.3.0', '4.2.99', '3.99.99', '04.3.2', '4.3.2-beta', '4.3.2\n', undefined]) {
    assert.throws(() => releasePromotionMode(version), /Release version/);
  }
});

test('legacy promotion copies all six exact tested files and their original hashes', async t => {
  const f = await fixture(t);
  const result = await f.promote();
  assert.equal(result.mode, 'legacy');
  assert.equal(result.artifactCount, 6);
  assert.deepEqual((await readdir(f.output)).sort(), [...f.artifacts.keys(), 'SHA256SUMS.txt'].sort());
  for (const [name, bytes] of f.artifacts) assert.deepEqual(await readFile(path.join(f.output, name)), bytes);
  assert.equal(await readFile(path.join(f.output, 'SHA256SUMS.txt'), 'utf8'), await readFile(path.join(f.incoming, 'SHA256SUMS.txt'), 'utf8'));
});

test('future promotion publishes only the unchanged CI userscript and its matching checksum', async t => {
  const f = await fixture(t, '4.3.2');
  const result = await f.promote();
  assert.equal(result.mode, 'userscript');
  assert.equal(result.artifactCount, 1);
  assert.equal(result.notesFile, 'docs/releases/4.3.2.md');
  assert.deepEqual((await readdir(f.output)).sort(), ['SHA256SUMS.txt', 'insta-toolbox.user.js']);
  const source = f.artifacts.get('insta-toolbox.user.js');
  assert.deepEqual(await readFile(path.join(f.output, 'insta-toolbox.user.js')), source);
  assert.equal(await readFile(path.join(f.output, 'SHA256SUMS.txt'), 'utf8'), `${digest(source)}  insta-toolbox.user.js\n`);
  assert.equal((await readdir(f.incoming)).length, 7);
});

test('future promotion still rejects a corrupted held package before writing public files', async t => {
  const f = await fixture(t, '4.3.2');
  await writeFile(path.join(f.incoming, 'Insta-Toolbox-Setup-4.3.2.exe'), 'changed after CI');
  await assert.rejects(f.promote(), /Checksum mismatch: Insta-Toolbox-Setup-4.3.2.exe/);
  await assert.rejects(readdir(f.output), { code: 'ENOENT' });
});

test('promotion rejects missing and duplicate incoming files', async t => {
  const missing = await fixture(t);
  await rm(path.join(missing.incoming, 'Insta-Toolbox-Setup-4.3.1.exe'));
  await assert.rejects(missing.promote(), /six tested files/);
  const duplicate = await fixture(t);
  await mkdir(path.join(duplicate.incoming, 'duplicate'));
  await writeFile(path.join(duplicate.incoming, 'duplicate', 'insta-toolbox.user.js'), duplicate.artifacts.get('insta-toolbox.user.js'));
  await assert.rejects(duplicate.promote(), /found duplicates/);
});

test('promotion rejects duplicate, unsafe, and incomplete checksum entries', async t => {
  for (const mutate of [
    lines => [...lines, lines[0]],
    lines => lines.map(line => line.replace('  insta-toolbox.user.js', '  ../insta-toolbox.user.js')),
    lines => lines.slice(1),
  ]) {
    const f = await fixture(t);
    const lines = (await readFile(path.join(f.incoming, 'SHA256SUMS.txt'), 'utf8')).trimEnd().split('\n');
    await writeFile(path.join(f.incoming, 'SHA256SUMS.txt'), `${mutate(lines).join('\n')}\n`);
    await assert.rejects(f.promote(), /Checksum manifest/);
  }
});

test('promotion validates userscript and archive versions even when their hashes match', async t => {
  for (const [name, bytes, pattern] of [
    ['insta-toolbox.user.js', Buffer.from('// @version 4.3.0\n'), /Userscript version/],
    ['insta-toolbox.user.js', Buffer.from('// @version 4.3.1\n// @version 4.3.1\n'), /Userscript version/],
    ['Insta-Toolbox-Extension-4.3.1.zip', archive('4.3.0', 'extension'), /Extension archive version/],
    ['insta-toolbox-web-4.3.1.zip', archive('4.3.0', 'web'), /Web archive version/],
  ]) {
    const f = await fixture(t);
    f.artifacts.set(name, bytes);
    await writeFile(path.join(f.incoming, name), bytes);
    await f.writeManifest();
    await assert.rejects(f.promote(), pattern);
  }
});

test('future promotion requires versioned notes and never overwrites previous output', async t => {
  const notes = await fixture(t, '4.3.2');
  await rm(path.join(notes.root, 'docs', 'releases', '4.3.2.md'));
  await assert.rejects(notes.promote(), { code: 'ENOENT' });
  const previous = await fixture(t, '4.3.2');
  await mkdir(previous.output);
  await writeFile(path.join(previous.output, 'existing.user.js'), 'preserved');
  await assert.rejects(previous.promote(), /empty regular directory/);
  assert.equal(await readFile(path.join(previous.output, 'existing.user.js'), 'utf8'), 'preserved');
  await assert.rejects(prepareReleasePromotion({ repositoryRoot: previous.root, tag: 'v4.3.3' }), /tag does not match/);
});

test('release workflow retains main CI, protected environment, checksum and provenance gates', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const required of [
    'environment: release', 'test "$sha" = "$main_sha"', '.head_repository.full_name',
    'test overlay-windows package-windows package-macos release-checksums',
    'node scripts/prepare-release-promotion.mjs', 'sha256sum --check --strict SHA256SUMS.txt',
    'subject-checksums: release/SHA256SUMS.txt', '--target "${{ steps.ci.outputs.sha }}"',
    '--notes-file release-notes.md', 'Release $RELEASE_TAG already exists', 'Tag $RELEASE_TAG already exists',
  ]) assert.ok(workflow.includes(required), required);
  assert.equal((workflow.match(/uses: actions\/download-artifact@/g) || []).length, 5);
});
