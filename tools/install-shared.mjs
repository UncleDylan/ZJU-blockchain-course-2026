// VMware shared folders may not support the symlinks used by npm's bin links.
// Run on Ubuntu: node tools/install-shared.mjs [contracts|frontend]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  throw new Error('Run this shared-folder installer in Ubuntu.');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projects = process.argv.slice(2);
if (projects.length === 0) projects.push('contracts', 'frontend');
if (projects.some((name) => !['contracts', 'frontend'].includes(name))) {
  throw new Error('Expected contracts or frontend.');
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

for (const project of projects) {
  const cwd = join(root, project);
  const result = spawnSync('npm', ['ci', '--no-bin-links', '--no-audit', '--no-fund'], {
    cwd, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const binDir = join(cwd, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  // The project's direct CLI dependencies are Node programs. Replace their
  // usual symlinks with ordinary shell launchers, leaving package scripts intact.
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const packageDir = join(cwd, 'node_modules', name);
    const dependency = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const bins = typeof dependency.bin === 'string'
      ? { [name.split('/').at(-1)]: dependency.bin }
      : dependency.bin ?? {};
    for (const [command, target] of Object.entries(bins)) {
      const launcher = join(binDir, command);
      writeFileSync(launcher, `#!/bin/sh\nexec node ${quote(resolve(packageDir, target))} "$@"\n`);
      chmodSync(launcher, 0o755);
    }
  }
  console.log(`${project}: dependencies and shared-folder command launchers ready.`);
}
