const liveActivator = `function activateLiveControl(control) {
    control.click();
  }`;
const nativeStart = '  async function collectNativeFollowerComparison(';
const nativeEnd = '  // Enumerates messages';
const nativeActivations = [
  'assertContext();\n        controls[0].click();',
  'assertContext(modal);\n        closeControls[0].click();',
];
const hasClick = source => /\.click\s*\(/.test(source);

// Native list navigation is a separately reviewed read operation. Account and
// message mutations retain the sole token-bound live activator; every other
// direct click still fails the package gate.
export function validateInstagramControlPaths(source) {
  if (!source.includes(liveActivator)) {
    throw new Error('Instagram content script is missing the isolated live-control activator.');
  }
  let remaining = source.replace(liveActivator, '');
  const start = remaining.indexOf(nativeStart);
  let nativeReadCalls = 0;
  if (start !== -1) {
    const end = remaining.indexOf(nativeEnd, start);
    if (end === -1) throw new Error('Instagram native read scope is not bounded.');
    let native = remaining.slice(start, end);
    if (/activateLiveControl\s*\(/.test(native)) {
      throw new Error('Instagram native reads may not invoke the live-control activator.');
    }
    for (const activation of nativeActivations) {
      if (!native.includes(activation)) throw new Error('Instagram native navigation is missing its reviewed context check.');
      native = native.replace(activation, '');
      nativeReadCalls += 1;
    }
    if (hasClick(native)) throw new Error('Instagram native read contains an unreviewed click path.');
    remaining = remaining.slice(0, start) + remaining.slice(end);
  }
  if (hasClick(remaining)) throw new Error('Instagram content script contains an unreviewed click path.');
  return { liveCalls: 1, nativeReadCalls };
}
