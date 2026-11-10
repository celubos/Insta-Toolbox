import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateInstagramControlPaths } from '../scripts/validate-instagram-control-paths.mjs';

const source = await readFile(new URL('../extension/content-instagram.js', import.meta.url), 'utf8');

test('package gate accepts only the reviewed native navigation and isolated live activator', () => {
  assert.deepEqual(validateInstagramControlPaths(source), { liveCalls: 1, nativeReadCalls: 2 });
});

for (const [label, altered] of [
  ['extra action click', `${source}\notherControl.click();`],
  ['extra native click', source.replace('        controls[0].click();', '        controls[0].click();\n        otherControl.click();')],
  ['missing pre-open context', source.replace('        assertContext();\n        controls[0].click();', '        controls[0].click();')],
  ['missing pre-close context', source.replace('        assertContext(modal);\n        closeControls[0].click();', '        closeControls[0].click();')],
  ['native live activation', source.replace('        controls[0].click();', '        controls[0].click();\n        activateLiveControl(otherControl);')],
  ['changed live activator', source.replace('    control.click();', '    control.click();\n    otherControl.click();')],
]) {
  test(`package gate rejects ${label}`, () => assert.throws(() => validateInstagramControlPaths(altered)));
}
