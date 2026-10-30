import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { parseHTML } from 'linkedom';

globalThis.singleImageSaves = [];
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'file-saver') return {
    url: 'data:text/javascript,export const saveAs = (blob, name) => globalThis.singleImageSaves.push({blob, name});', shortCircuit: true,
  };
  return nextResolve(specifier, context);
} });
const { window, document } = parseHTML('<html><body></body></html>');
window.location = new URL('https://example.test/gallery');
window.screen = { width: 1920, height: 1080, availHeight: 1080 };
class MouseEvent extends window.Event {
  constructor(type, options = {}) { super(type, options); Object.assign(this, { clientX: 50, clientY: 50, ...options }); }
}
Object.assign(globalThis, {
  window, document, MouseEvent, HTMLElement: window.HTMLElement, customElements: window.customElements,
  GM: { xmlHttpRequest() {} }, GM_getValue: () => undefined, GM_setValue() {},
});
const { FetchState } = await import('../src/img-fetcher.ts');
const { SubData } = await import('../src/platform/platform.ts');
const { downloadSingleImage } = await import('../src/download/single-image.ts');
const { ContextMenu } = await import('../src/ui/context-menu.ts');
const { default: EBUS } = await import('../src/event-bus.ts');

function image(index = 0, type = 'image/png') {
  return { index, stage: FetchState.DONE, lock: false, contentType: type,
    node: { title: `page-${index + 1}.png` }, data: new Uint8Array([index + 1, 0, 255]),
    async start() { throw new Error('Cached image should not fetch'); },
  };
}
const saved = () => globalThis.singleImageSaves;
const reset = () => { saved().length = 0; EBUS.reset(); };

test('cached images save exact bytes as a single image file without fetching', async () => {
  reset();
  const imf = image(1);
  await downloadSingleImage(imf);
  assert.equal(saved().length, 1);
  assert.equal(saved()[0].name, 'page-2.png');
  assert.equal(saved()[0].blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await saved()[0].blob.arrayBuffer()), imf.data);
});

test('unloaded images fetch only the captured image and use its final name and format', async () => {
  reset();
  const imf = image();
  imf.stage = FetchState.URL;
  imf.data = undefined;
  let starts = 0;
  imf.start = async () => {
    starts++;
    Object.assign(imf, { stage: FetchState.DONE, data: new Uint8Array([9]), contentType: 'image/jpeg' });
    imf.node.title = 'original.jpg';
  };
  await downloadSingleImage(imf);
  assert.equal(starts, 1);
  assert.equal(saved()[0].name, 'original.jpg');
  assert.equal(saved()[0].blob.type, 'image/jpeg');
});

test('an existing request is reused and repeated clicks do not save duplicates', async () => {
  reset();
  const imf = image();
  imf.lock = true;
  imf.stage = FetchState.DATA;
  const requests = [downloadSingleImage(imf), downloadSingleImage(imf)];
  setTimeout(() => { imf.stage = FetchState.DONE; imf.lock = false; }, 5);
  await Promise.all(requests);
  assert.equal(saved().length, 1);
});

test('GIF and WebP keep the original animated file bytes, and unsafe names are cleaned', async () => {
  reset();
  for (const [mime, extension] of [['image/gif', 'gif'], ['image/webp', 'webp']]) {
    const imf = image(0, mime);
    imf.node.title = '../folder\\bad:name.jpg';
    await downloadSingleImage(imf);
    const file = saved().at(-1);
    assert.ok(file.name.endsWith('.' + extension));
    assert.doesNotMatch(file.name, /[\\/:*?"<>|]/);
    assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), imf.data);
  }
});

test('failed images and multi-frame archives never produce a download', async () => {
  reset();
  const failed = image();
  failed.stage = FetchState.FAILED;
  failed.failedReason = 'request failed';
  failed.start = async () => {};
  await assert.rejects(downloadSingleImage(failed), /request failed/);
  const animated = image(0, 'ugoira/ugoira');
  animated.data = new SubData('animation', [{ name: '0.jpg', data: new Uint8Array([0]), contentType: 'image/jpeg' }]);
  await assert.rejects(downloadSingleImage(animated));
  await assert.rejects(downloadSingleImage(image(0, 'video/mp4')));
  assert.equal(saved().length, 0);
});

function menuFixture(bigMode = false) {
  document.body.innerHTML = '<div id="root"><div id="grid"><div class="img-node" data-index="0"><img></div><div class="img-node" data-index="1"><img></div></div><div id="big" class="big-img-frame-collapse"><div class="bifm-container"><div d-index="0"><img></div><div d-index="1"><img></div></div></div></div>';
  const root = document.querySelector('#root');
  const big = document.querySelector('#big');
  if (bigMode) big.classList.remove('big-img-frame-collapse');
  const images = [image(0), image(1)];
  const grid = { queue: images.map((node, index) => ({ node, element: document.querySelector(`[data-index="${index}"]`) })), mouseOn: () => document.querySelector('[data-index="0"]') };
  const events = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ icon: '', cb() {} }) }) });
  const bifm = { container: big.firstElementChild, chapterIndex: 3, getChapter: index => { assert.equal(index, 3); return { filteredQueue: images }; } };
  const menu = new ContextMenu({ root, bigImageFrame: big }, grid, events, () => undefined, bifm);
  return { root, menu, grid, images };
}

test('thumbnail menu captures the right-clicked image even if the grid changes before clicking', async () => {
  reset();
  const { grid, images } = menuFixture();
  const second = document.querySelector('[data-index="1"] img');
  second.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  const button = document.querySelector('[data-action="download-image"]');
  assert.ok(button);
  grid.queue.reverse();
  button.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved()[0].name, images[1].node.title);
  assert.equal(document.querySelector('.ehvp-context-menu'), null);
});

test('big-image menu uses the clicked page rather than the current or first page', async () => {
  reset();
  menuFixture(true);
  document.querySelector('[d-index="1"] img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  document.querySelector('[data-action="download-image"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(saved()[0].name, 'page-2.png');
});

test('right-clicking the background does not offer an image download', () => {
  reset();
  const { root } = menuFixture();
  root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  assert.equal(document.querySelector('[data-action="download-image"]'), null);
});

test('download errors are reported without saving a file or changing the target', async () => {
  reset();
  const { images } = menuFixture();
  images[1].stage = FetchState.FAILED;
  images[1].failedReason = 'network unavailable';
  images[1].start = async () => {};
  let message;
  EBUS.subscribe('notify-message', (_level, text) => { message = text; });
  document.querySelector('[data-index="1"] img').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  document.querySelector('[data-action="download-image"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(message, /network unavailable/);
  assert.equal(saved().length, 0);
});
