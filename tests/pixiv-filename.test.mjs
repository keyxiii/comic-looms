import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

process.env.TZ = 'Asia/Hong_Kong';
const { window, document } = parseHTML('<html><body></body></html>');
window.location = new URL('https://www.pixiv.net/artworks/151236463');
window.screen = { width: 1920, height: 1080, availHeight: 1080 };
Object.assign(globalThis, {
  window, document,
  HTMLElement: window.HTMLElement,
  customElements: window.customElements,
  GM: { xmlHttpRequest() {} },
  GM_getValue: () => undefined,
  GM_setValue() {},
});

const { ADAPTER } = await import('../src/platform/adapt.ts');
await import('../src/platform/matchers/pixiv.ts');
const createMatcher = () => ADAPTER.matchers.find(setup => setup.name === 'Pixiv').constructor();
const chapter = (...pids) => ({
  filteredQueue: pids.map(pid => ({ node: { href: `https://www.pixiv.net/artworks/${pid}` } })),
});

test('a single Pixiv work uses the local download date and artwork ID', t => {
  // Hong Kong has already crossed midnight while UTC is still October 24.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-24T16:05:00Z') });
  const matcher = createMatcher();
  assert.equal(matcher.title([chapter('151236463')]), '261025_151236463');
  assert.equal(matcher.title([chapter('151236463', '151236463')]), '261025_151236463');

  // A page left open overnight must use the date of the later download.
  t.mock.timers.setTime(new Date('2026-10-25T16:05:00Z').getTime());
  assert.equal(matcher.title([chapter('151236463')]), '261026_151236463');
  t.mock.timers.setTime(new Date('2027-01-02T00:05:00+08:00').getTime());
  assert.equal(matcher.title([chapter('151236463')]), '270102_151236463');
});

test('the selected work determines the ID even when the page shows a different work', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-25T12:00:00+08:00') });
  assert.equal(createMatcher().title([chapter('151236464')]), '261025_151236464');
});

test('multiple works and empty downloads retain the Pixiv collection name', () => {
  const matcher = createMatcher();
  const collectionName = matcher.galleryMeta().title;
  assert.equal(matcher.title([chapter('151236463', '151236464')]), collectionName);
  assert.equal(matcher.title([chapter('151236463'), chapter('151236464')]), collectionName);
  assert.equal(matcher.title([chapter()]), collectionName);
  assert.equal(matcher.title([]), collectionName);
});
