import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { parseHTML } from 'linkedom';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'file-saver') return { url: 'data:text/javascript,export function saveAs() {}', shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { window, document } = parseHTML('<html><body></body></html>');
Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
window.location = new URL('https://example.test/gallery');
window.screen = { width: 1920, height: 1080, availHeight: 1080 };
const storage = new Map();
Object.assign(globalThis, {
  window, document, location: window.location, HTMLElement: window.HTMLElement,
  HTMLImageElement: window.HTMLImageElement, HTMLVideoElement: class {},
  customElements: window.customElements, GM: { xmlHttpRequest() {} },
  GM_getValue: key => storage.get(key), GM_setValue: (key, value) => storage.set(key, value),
});
const { IMGFetcherQueue } = await import('../src/fetcher-queue.ts');
const { IdleLoader } = await import('../src/idle-loader.ts');
const { FetchState } = await import('../src/img-fetcher.ts');
const { defaultConf, getConf, saveConf, getSiteConfig } = await import('../src/config.ts');
const { ADAPTER } = await import('../src/platform/adapt.ts');
const { default: EBUS } = await import('../src/event-bus.ts');
const { BigImageFrameManager, AutoPage } = await import('../src/ui/big-image-frame-manager.ts');
const { initEvents } = await import('../src/ui/event.ts');
const { ConfigPanel } = await import('../src/ui/config-panel.ts');

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function queueFixture(count = 12) {
  EBUS.reset(); ADAPTER.conf = { ...defaultConf(), threads: 2, autoLoad: false, debug: false };
  const queue = IMGFetcherQueue.newQueue();
  const started = [], finish = new Map();
  for (let index = 0; index < count; index++) queue.push({
    index, chapterIndex: 0, stage: FetchState.URL, lock: false, unrender() {},
    async start() {
      assert.equal(this.lock, false, 'duplicate request'); this.lock = true; started.push(index);
      await new Promise(resolve => finish.set(index, resolve));
      this.stage = FetchState.DONE;
      EBUS.emit('imf-on-finished', index, true, this); this.lock = false;
    },
  });
  return { queue, started, async finish(index) { finish.get(index)?.(); await settle(); } };
}

test('reading preloads refill on completion without another scroll, with bounded concurrency', async () => {
  const r = queueFixture(); EBUS.emit('continuous-preload', 0, 0, 5, 0);
  assert.deepEqual(r.started, [0, 1]);
  await r.finish(0); assert.deepEqual(r.started, [0, 1, 2]);
  await r.finish(1); assert.deepEqual(r.started, [0, 1, 2, 3]);
  assert.equal([...r.queue].filter(item => item.lock).length, 2);
  EBUS.emit('continuous-preload-stop'); await r.finish(2); await r.finish(3);
  assert.equal(r.started.length, 4);
});

test('window changes reuse in-flight requests and respect page limits and selection rules', async () => {
  const r = queueFixture(); ADAPTER.conf.maxPreloadDistance = 2;
  r.queue.cherryPick = () => ({ picked: i => i % 2 === 0 });
  EBUS.emit('continuous-preload', 0, 0, 10, 0);
  assert.deepEqual(r.started, [0, 2]);
  EBUS.emit('continuous-preload', 0, 1, 10, 1);
  assert.deepEqual(r.started, [0, 2]);
  await r.finish(0); assert.deepEqual(r.started, [0, 2, 1], 'visible excluded page remains readable');
  await r.finish(2); assert.equal(r.started.length, 3, 'future pages beyond cap do not load');
  EBUS.emit('continuous-preload-stop'); await r.finish(1);
});

test('zero browsing threads loads visible images only; failures do not form a retry loop', async () => {
  const r = queueFixture(); ADAPTER.conf.threads = 0;
  r.queue[0].stage = FetchState.FAILED;
  EBUS.emit('continuous-preload', 0, 0, 8, 1);
  assert.deepEqual(r.started, [1]); await r.finish(1);
  assert.deepEqual(r.started, [1]); EBUS.emit('continuous-preload-stop');
});

test('idle loader yields to reading preload, and old completion cannot load a new chapter', async () => {
  const r = queueFixture(); const idle = new IdleLoader(r.queue);
  EBUS.emit('continuous-preload', 0, 0, 5, 0);
  idle.autoLoad = true; idle.processingIndexList = [5]; idle.start();
  assert.deepEqual(r.started, [0, 1]);
  r.queue.restore(1, [{ index: 0, chapterIndex: 1, stage: FetchState.URL, start() { throw new Error('stale request'); } }]);
  await r.finish(0); await r.finish(1); assert.equal(r.started.length, 2);
});

test('download ownership and pre-existing requests are honored by the reading scheduler', async () => {
  const r = queueFixture(); r.queue[8].lock = true;
  EBUS.emit('continuous-preload', 0, 0, 5, 0);
  assert.deepEqual(r.started, [0]);
  r.queue.downloading = () => true; await r.finish(0);
  assert.deepEqual(r.started, [0]); EBUS.emit('continuous-preload-stop');
});

test('background loading policy prevents new requests until the reader is visible', async () => {
  const r = queueFixture(); ADAPTER.conf.autoLoadInBackground = false;
  try {
    document.hidden = true; EBUS.emit('continuous-preload', 0, 0, 5, 0);
    assert.deepEqual(r.started, []);
    document.hidden = false; EBUS.emit('continuous-preload', 0, 0, 5, 0);
    assert.deepEqual(r.started, [0, 1]);
  } finally {
    document.hidden = false; EBUS.emit('continuous-preload-stop');
    await r.finish(0); await r.finish(1);
  }
});

test('new settings migrate safely and are saved per site', () => {
  const old = defaultConf(); delete old.autoScrollSpeed; delete old.autoScrollPreloadScreens;
  storage.set('ehvh_cfg_', JSON.stringify(old));
  assert.equal(getConf().autoScrollSpeed, 60); assert.equal(getConf().autoScrollPreloadScreens, 4);
  saveConf({ autoScrollSpeed: Infinity, autoScrollPreloadScreens: -5 });
  assert.equal(getConf().autoScrollSpeed, 60); assert.equal(getConf().autoScrollPreloadScreens, 1);
  saveConf({ autoScrollSpeed: 125, autoScrollPreloadScreens: 7 }, 'Example');
  assert.deepEqual(getSiteConfig('Example'), { autoScrollSpeed: 125, autoScrollPreloadScreens: 7 });
});

function viewportFixture() {
  EBUS.reset(); ADAPTER.conf = { ...defaultConf(), readMode: 'continuous', debug: false };
  const root = document.createElement('div'), container = document.createElement('div'); root.append(container);
  Object.defineProperty(root, 'clientHeight', { value: 100 }); root.scrollTop = 100;
  const queue = Array.from({ length: 8 }, (_, index) => ({ index, chapterIndex: 0, stage: FetchState.DONE,
    node: { blobSrc: 'data:image/png;base64,AA==' } }));
  for (let index = -1; index <= queue.length; index++) {
    const element = document.createElement('div'); container.append(element);
    element.setAttribute('d-index', index >= queue.length ? '-1' : String(index));
    Object.defineProperties(element, { offsetTop: { value: (index + 1) * 100, configurable: true }, offsetHeight: { value: 100 } });
    if (index >= 0 && index < queue.length) {
      const img = document.createElement('img'); img.src = queue[index].node.blobSrc;
      Object.defineProperties(img, { complete: { value: true, configurable: true }, naturalWidth: { value: 100 } });
      element.append(img);
    }
  }
  const chapter = { filteredQueue: queue, done: true };
  const bifm = Object.create(BigImageFrameManager.prototype);
  Object.assign(bifm, { root, container, currentIndex: 0, chapterIndex: 0, visible: true,
    getChapter: () => chapter, renderingElements: [], oriented: 'next', lastViewportSyncAt: 0,
    syncCurrentFromViewportThrottled() {}, scrollStop() {} });
  return { bifm, queue, chapter, root, container };
}

test('forward window follows viewport size, stops at the first missing or undecoded image', () => {
  const r = viewportFixture(); const windows = [];
  EBUS.subscribe('continuous-preload', (...args) => windows.push(args));
  r.queue[2].stage = FetchState.DATA;
  let state = r.bifm.prepareContinuousScroll();
  assert.equal(state.readyEnd, 200); assert.deepEqual(windows.at(-1), [0, 0, 4, 0]);
  ADAPTER.conf.autoScrollPreloadScreens = 2;
  r.queue[2].stage = FetchState.DONE;
  Object.defineProperty(r.container.children[3].firstElementChild, 'complete', { value: false, configurable: true });
  state = r.bifm.prepareContinuousScroll(); assert.equal(state.readyEnd, 200);
  assert.deepEqual(windows.at(-1), [0, 0, 2, 0]);
  Object.defineProperty(r.container.children[3].firstElementChild, 'complete', { value: true });
  assert.ok(r.bifm.prepareContinuousScroll().readyEnd > 200);
});

test('missing images already in view hold position; disabling the wait allows scrolling', () => {
  const r = viewportFixture(); r.queue[0].stage = FetchState.DATA;
  assert.equal(r.bifm.prepareContinuousScroll().readyEnd, 100);
  ADAPTER.conf.autoScrollWaitForImages = false;
  assert.equal(r.bifm.prepareContinuousScroll().readyEnd, r.bifm.prepareContinuousScroll().end);
});

test('an unloaded page at the viewport edge is demanded even with no lookahead threads', () => {
  const r = viewportFixture(); ADAPTER.conf.threads = 0; r.queue[1].stage = FetchState.URL;
  let required;
  EBUS.subscribe('continuous-preload', (_chapter, _start, _end, visibleEnd) => { required = visibleEnd; });
  assert.equal(r.bifm.prepareContinuousScroll().readyEnd, r.root.scrollTop);
  assert.equal(required, 1, 'blocking page must load without entering the empty page');
});

test('the final missing image keeps a completed source waiting until display-ready', () => {
  const r = viewportFixture(); r.root.scrollTop = 800; r.queue[7].stage = FetchState.DATA;
  assert.equal(r.bifm.prepareContinuousScroll().complete, false);
  r.queue[7].stage = FetchState.DONE;
  assert.equal(r.bifm.prepareContinuousScroll().complete, true);
});

test('image size corrections preserve the current reading anchor', () => {
  const r = viewportFixture();
  const current = r.container.children[2], resized = r.container.children[1];
  r.bifm.currentIndex = 1; r.root.scrollTop = 175;
  let currentTop = 200;
  Object.defineProperty(current, 'offsetTop', { get: () => currentTop });
  r.queue[0].ratio = () => { currentTop = 250; return 1.2; };
  r.bifm.onResize(r.queue[0]);
  assert.equal(resized.style.aspectRatio, '1.2'); assert.equal(r.root.scrollTop, 225);
});

test('unresolved list end requests extension and only a completed chapter is terminal', () => {
  const r = viewportFixture(); r.root.scrollTop = 700; r.chapter.done = false;
  let extended = 0; EBUS.subscribe('pf-try-extend', () => extended++);
  assert.equal(r.bifm.prepareContinuousScroll().complete, false); assert.equal(extended, 1);
  r.chapter.done = true; assert.equal(r.bifm.prepareContinuousScroll().complete, true);
});

test('configuration controls clamp values and switching modes preserves both speed settings', () => {
  ADAPTER.conf = { ...defaultConf(), autoPageSpeed: 9, autoScrollSpeed: 125 };
  ADAPTER.globalConf = ADAPTER.conf; ADAPTER.matcher = { name: 'Example' };
  const root = document.createElement('div'); root.innerHTML = ConfigPanel.html();
  const cp = new ConfigPanel(root);
  const html = { root, config: cp, readModeSelect: document.createElement('div') };
  let layouts = 0;
  const events = initEvents(html, { changeLayout() { layouts++; } }, {}, {}, {}, {});
  cp.flushConfigItems(events);
  const input = cp.panel.querySelector('#autoScrollSpeedInput');
  assert.equal(input.disabled, false);
  input.value = '999'; input.dispatchEvent(new window.Event('change')); assert.equal(ADAPTER.conf.autoScrollSpeed, 300);
  input.value = ''; input.dispatchEvent(new window.Event('change')); assert.equal(ADAPTER.conf.autoScrollSpeed, 300);
  events.changeReadModeEvent('continuous'); events.changeReadModeEvent('pagination');
  assert.equal(layouts, 2); assert.equal(ADAPTER.conf.autoScrollSpeed, 300); assert.equal(ADAPTER.conf.autoPageSpeed, 9);
});

test('auto reader stops on manual input, layout and chapter changes; waiting remains cancellable', () => {
  const r = viewportFixture();
  let frame;
  window.requestAnimationFrame = cb => { frame = cb; return 1; };
  window.cancelAnimationFrame = () => { frame = undefined; };
  const button = document.createElement('a'); button.setAttribute('data-display-texts', 'Play,Pause');
  button.innerHTML = '<span></span><div id="auto-page-progress"></div>';
  const auto = new AutoPage(r.bifm, button); auto.start(auto.lockVer);
  assert.equal(auto.status, 'running'); r.bifm.callbackOnWheel(); assert.equal(auto.status, 'stop');
  auto.start(auto.lockVer); EBUS.emit('bifm-layout-change'); assert.equal(auto.status, 'stop');
  auto.start(auto.lockVer); EBUS.emit('pf-change-chapter', 1, r.chapter); assert.equal(auto.status, 'stop');
  r.queue[0].stage = FetchState.DATA; auto.start(auto.lockVer); frame(0);
  assert.equal(button.getAttribute('data-status'), 'waiting'); button.click();
  assert.equal(auto.status, 'stop'); assert.equal(frame, undefined);
  auto.destroy();
});

test('the production auto reader resumes a loaded gap and resets the clock across visibility changes', () => {
  const r = viewportFixture(); r.queue[0].stage = FetchState.DATA;
  let callback;
  window.requestAnimationFrame = cb => { callback = cb; return 1; };
  window.cancelAnimationFrame = () => { callback = undefined; };
  const button = document.createElement('a'); button.setAttribute('data-display-texts', 'Play,Pause');
  button.innerHTML = '<span></span><div id="auto-page-progress"></div>';
  const auto = new AutoPage(r.bifm, button);
  try {
    auto.start(auto.lockVer); callback(0); callback(100);
    assert.equal(r.root.scrollTop, 100); assert.equal(button.dataset.status, 'waiting');
    r.queue[0].stage = FetchState.DONE; EBUS.emit('imf-on-finished', 0, true, r.queue[0]); callback(200);
    assert.equal(r.root.scrollTop, 106); assert.equal(button.dataset.status, 'playing');
    document.hidden = true; document.dispatchEvent(new window.Event('visibilitychange')); callback(5000);
    assert.equal(r.root.scrollTop, 106); assert.equal(button.dataset.status, 'suspended');
    document.hidden = false; document.dispatchEvent(new window.Event('visibilitychange')); callback(20000);
    assert.equal(r.root.scrollTop, 106); callback(20100); assert.equal(r.root.scrollTop, 112);
  } finally { document.hidden = false; auto.destroy(); }
  assert.equal(callback, undefined);
});
