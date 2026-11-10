import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyExtensionReleaseArchive, verifyWebReleaseArchive } from './generate-release-checksums.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyVersion = '4.3.1';

export function releasePromotionMode(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Release version must be <major>.<minor>.<patch>.');
  }
  const parts = version.split('.').map(BigInt);
  const minimum = legacyVersion.split('.').map(BigInt);
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] > minimum[index]) return 'userscript';
    if (parts[index] < minimum[index]) throw new Error(`Release version must be ${legacyVersion} or newer.`);
  }
  return 'legacy';
}

function expectedArtifactNames(version) {
  return [
    `Insta-Toolbox-${version}-universal.dmg`,
    `Insta-Toolbox-${version}-universal.zip`,
    `Insta-Toolbox-Extension-${version}.zip`,
    `Insta-Toolbox-Setup-${version}.exe`,
    `insta-toolbox-web-${version}.zip`,
    'insta-toolbox.user.js',
  ];
}

function inside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Promotion directories must stay inside the repository.');
  }
}

async function incomingFiles(directory) {
  const files = new Map();
  let count = 0;
  const visit = async (current, depth) => {
    if (depth > 8) throw new Error('Incoming artifacts exceed the directory depth limit.');
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (++count > 128) throw new Error('Incoming artifacts exceed the file count limit.');
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else {
        if (!entry.isFile()) throw new Error('Incoming artifacts must be regular files.');
        if (files.has(entry.name)) throw new Error(`Expected one ${entry.name}, found duplicates.`);
        files.set(entry.name, target);
      }
    }
  };
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Incoming artifact root must be a directory.');
  await visit(directory, 0);
  return files;
}

async function boundedFile(target, maxBytes) {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maxBytes) {
    throw new Error(`Release artifact has an invalid size or type: ${path.basename(target)}`);
  }
}

async function sha256(target) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareReleasePromotion({
  repositoryRoot = defaultRepositoryRoot,
  incomingDirectory = path.join(repositoryRoot, 'incoming'),
  outputDirectory = path.join(repositoryRoot, 'release'),
  tag,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const incoming = path.resolve(incomingDirectory);
  const output = path.resolve(outputDirectory);
  inside(root, incoming);
  inside(root, output);
  if (incoming === output || !path.relative(incoming, output).startsWith('..')) {
    throw new Error('Promotion output must be separate from incoming artifacts.');
  }
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const mode = releasePromotionMode(version);
  if (tag !== `v${version}`) throw new Error('Release tag does not match package.json.');

  // CI still tests every package. Promotion verifies that complete artifact set,
  // then publishes only the active update channel for versions after 4.3.1.
  const expectedNames = expectedArtifactNames(version);
  const files = await incomingFiles(incoming);
  if (files.size !== expectedNames.length + 1 || !files.has('SHA256SUMS.txt')) {
    throw new Error('Incoming artifacts must contain the six tested files and SHA256SUMS.txt.');
  }
  for (const name of expectedNames) {
    if (!files.has(name)) throw new Error(`Required release artifact is missing: ${name}`);
    await boundedFile(files.get(name), name.endsWith('.exe') || name.includes('-universal.')
      ? 4 * 1024 * 1024 * 1024 : 64 * 1024 * 1024);
  }
  await boundedFile(files.get('SHA256SUMS.txt'), 8192);
  const manifest = await readFile(files.get('SHA256SUMS.txt'), 'utf8');
  const lines = manifest.trimEnd().split('\n');
  const checksums = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9.-]+)$/.exec(line);
    if (!match || !expectedNames.includes(match[2]) || checksums.has(match[2])) {
      throw new Error('Checksum manifest must name each tested artifact exactly once.');
    }
    checksums.set(match[2], match[1]);
  }
  if (checksums.size !== expectedNames.length) throw new Error('Checksum manifest is incomplete.');
  for (const name of expectedNames) {
    if (await sha256(files.get(name)) !== checksums.get(name)) throw new Error(`Checksum mismatch: ${name}`);
  }
  const userscript = await readFile(files.get('insta-toolbox.user.js'), 'utf8');
  const versions = [...userscript.matchAll(/^\/\/ @version[ \t]+([^\r\n]+?)[ \t]*\r?$/gm)];
  if (versions.length !== 1 || versions[0][1] !== version) throw new Error('Userscript version does not match package.json.');
  verifyExtensionReleaseArchive(await readFile(files.get(`Insta-Toolbox-Extension-${version}.zip`)), version);
  verifyWebReleaseArchive(await readFile(files.get(`insta-toolbox-web-${version}.zip`)), version);

  let notesFile;
  if (mode === 'userscript') {
    notesFile = `docs/releases/${version}.md`;
    const target = path.join(root, notesFile);
    await boundedFile(target, 64 * 1024);
    if (!(await readFile(target, 'utf8')).trim()) throw new Error('Versioned release notes must not be empty.');
  }
  try {
    const metadata = await lstat(output);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await readdir(output)).length) {
      throw new Error('Promotion output must be an empty regular directory.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(output);
  }
  const promotedNames = mode === 'legacy' ? expectedNames : ['insta-toolbox.user.js'];
  for (const name of promotedNames) await copyFile(files.get(name), path.join(output, name), constants.COPYFILE_EXCL);
  const contents = `${promotedNames.map(name => `${checksums.get(name)}  ${name}`).join('\n')}\n`;
  await writeFile(path.join(output, 'SHA256SUMS.txt'), contents, { flag: 'wx' });
  return { version, mode, artifactCount: promotedNames.length, notesFile, names: promotedNames, contents };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await prepareReleasePromotion({ tag: process.env.RELEASE_TAG });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nmode=${result.mode}\nartifact_count=${result.artifactCount}\nnotes_file=${result.notesFile || ''}\n`);
  }
  console.log(`Verified six CI artifacts; prepared ${result.artifactCount} ${result.mode} release files.`);
}
