import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { registerHooks } from 'node:module';

// The browser bundle uses file-saver's UMD global; these tests never write files.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'file-saver') return { url: 'data:text/javascript,export function saveAs() {}', shortCircuit: true };
  return nextResolve(specifier, context);
} });

const { window, document } = parseHTML('<html><body></body></html>');
// linkedom implements select.value as read-only; browsers provide this setter.
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
  get() { return Array.from(this.options).find(option => option.selected)?.value ?? ''; },
  set(value) { Array.from(this.options).forEach(option => { option.selected = option.value === value; }); },
});
window.location = new URL('https://www.pixiv.net/artworks/151236463');
window.screen = { width: 1920, height: 1080, availHeight: 1080 };
Object.assign(globalThis, {
  window, document, HTMLElement: window.HTMLElement, customElements: window.customElements,
  GM: { xmlHttpRequest() {} }, GM_getValue: () => undefined, GM_setValue() {},
});
const { Downloader, CherryPick } = await import('../src/download/downloader.ts');
const { IdleLoader } = await import('../src/idle-loader.ts');
const { IMGFetcherQueue } = await import('../src/fetcher-queue.ts');
const { FetchState } = await import('../src/img-fetcher.ts');
const { ADAPTER } = await import('../src/platform/adapt.ts');
const { DownloaderPanel } = await import('../src/ui/downloader-panel.ts');
const { default: EBUS } = await import('../src/event-bus.ts');
const { PageFetcher, Chapter } = await import('../src/page-fetcher.ts');

function items(count, started = []) {
  return Array.from({ length: count }, (_, index) => ({
    index, stage: FetchState.URL, lock: false,
    async start() { started.push(index + 1); this.stage = FetchState.DONE; },
  }));
}

test('idle loading filters the initial workers and keeps all available worker slots', () => {
  const started = [];
  const pick = new CherryPick();
  pick.applyRule('2n+1');
  const loader = Object.create(IdleLoader.prototype);
  Object.assign(loader, { queue: items(6, started), autoLoad: true, processingIndexList: [0, 1], cherryPick: () => pick });
  loader.start();
  assert.deepEqual(started, [1, 3]);
  loader.checkProcessingIndex();
  assert.deepEqual(loader.processingIndexList, [4]);
});

test('queue completion honors rules even without explicit ranges', () => {
  const pick = new CherryPick();
  pick.applyRule('2n+1');
  const queue = new IMGFetcherQueue();
  queue.restore(0, items(6));
  queue.cherryPick = () => pick;
  [0, 2, 4].forEach(i => queue.finishedIndex.add(i));
  assert.equal(queue.isFinished(), true);
  queue.push(...items(2));
  assert.equal(queue.isFinished(), false);
});

test('batch download skips unmatched pages and continues through batches with no matches', async () => {
  const started = [];
  const pick = new CherryPick();
  pick.applyRule('n+5');
  const queue = items(2, started);
  const chapter = { filteredQueue: queue, done: false };
  let appends = 0;
  const downloader = Object.create(Downloader.prototype);
  Object.assign(downloader, {
    queue, cherryPicks: [pick],
    idleLoader: { wait: async () => {} },
    pageFetcher: { chapters: [chapter], async appendNextPage() {
      appends++;
      if (appends <= 2) {
        const next = items(6, started).slice(queue.length, queue.length + 2);
        queue.push(...next);
        return true;
      }
      chapter.done = true;
      return false;
    } },
  });
  await downloader.loadChapter(0, () => true);
  assert.deepEqual(started.sort((a, b) => a - b), [5, 6]);
  assert.equal(appends, 3);
});

test('a failed selected image rejects the download and cancellation stops new requests', async () => {
  const pick = new CherryPick();
  pick.applyRule('2n+1');
  const queue = items(6);
  const downloader = Object.create(Downloader.prototype);
  Object.assign(downloader, { queue, cherryPicks: [pick], idleLoader: { wait: async () => {} }, pageFetcher: { chapters: [{ done: true }] } });
  queue[0].start = async function () { this.stage = FetchState.FAILED; };
  await assert.rejects(downloader.loadChapter(0, () => true));
  let calls = 0;
  queue.forEach(item => { item.stage = FetchState.URL; item.start = async () => { calls++; }; });
  await downloader.loadChapter(0, () => false);
  assert.equal(calls, 0);
});

test('workers respect the concurrency limit and wait for existing reader requests', async () => {
  const previousThreads = ADAPTER.conf.downloadThreads;
  ADAPTER.conf.downloadThreads = 2;
  try {
    const pick = new CherryPick();
    pick.applyRule('2n+1');
    const started = [];
    const queue = items(12);
    let running = 0, peak = 0;
    queue.forEach((item, index) => {
      item.start = async function () {
        this.lock = true;
        running++;
        peak = Math.max(peak, running);
        started.push(index + 1);
        await new Promise(resolve => setTimeout(resolve, 2));
        this.stage = FetchState.DONE;
        this.lock = false;
        running--;
      };
    });
    queue[0].lock = true;
    const reader = setTimeout(() => { queue[0].stage = FetchState.DONE; queue[0].lock = false; }, 5);
    const downloader = Object.create(Downloader.prototype);
    Object.assign(downloader, { queue, cherryPicks: [pick], idleLoader: { wait: async () => {} }, pageFetcher: { chapters: [{ done: true }] } });
    await downloader.loadChapter(0, () => true);
    clearTimeout(reader);
    assert.ok(peak <= 2);
    assert.deepEqual(started.sort((a, b) => a - b), [3, 5, 7, 9, 11]);
    assert.equal(running, 0);
  } finally {
    ADAPTER.conf.downloadThreads = previousThreads;
  }
});

test('cancellation during a download stops scheduling further images', async () => {
  const previousThreads = ADAPTER.conf.downloadThreads;
  ADAPTER.conf.downloadThreads = 1;
  try {
    let active = true, calls = 0;
    const queue = items(8);
    queue.forEach(item => {
      item.start = async function () { calls++; this.stage = FetchState.DONE; active = false; };
    });
    const downloader = Object.create(Downloader.prototype);
    Object.assign(downloader, { queue, cherryPicks: [new CherryPick()], idleLoader: { wait: async () => {} }, pageFetcher: { chapters: [{ done: true }] } });
    await downloader.loadChapter(0, () => active);
    assert.equal(calls, 1);
  } finally {
    ADAPTER.conf.downloadThreads = previousThreads;
  }
});

test('start drains the real page iterator, including empty source batches, before packaging', async () => {
  EBUS.reset();
  const started = [];
  const queue = new IMGFetcherQueue();
  const chapter = new Chapter(10, 'Gallery', 'https://example.test/gallery');
  let batches = 0;
  chapter.sourceIter = (async function* () {
    for (const count of [0, 2, 2, 2]) {
      batches++;
      yield { value: Array.from({ length: count }, () => ({ href: 'https://example.test/image', actions: [] })) };
    }
  })();
  const pageFetcher = Object.create(PageFetcher.prototype);
  Object.assign(pageFetcher, {
    queue, chapterIndex: 0, chapters: [chapter], nodeActionDesc: [],
    matcher: {}, filter: { filterNodes: nodes => nodes },
    obtainImageNodeList: async nodes => nodes,
    appendToView(_total, nodes) {
      nodes.forEach(imf => { imf.start = async () => { started.push(imf.index + 1); imf.stage = FetchState.DONE; }; });
    },
  });
  const pick = new CherryPick();
  pick.applyRule('n+5');
  let packaged = false;
  const downloader = Object.create(Downloader.prototype);
  Object.assign(downloader, {
    downloadRun: 0, selectedChapters: [], cherryPicks: [pick], pageFetcher, queue,
    idleLoader: { abort() {}, wait: async () => {} },
    panel: { flushUI() {}, abort() {}, selectedChapters: () => new Set([10]) },
    async download(chapters) {
      assert.equal(chapters[0].done, true);
      packaged = true;
      this.abort('downloaded');
    },
  });
  queue.downloading = () => downloader.downloading;
  await downloader.start();
  assert.equal(batches, 4);
  assert.deepEqual(started.sort((a, b) => a - b), [5, 6]);
  assert.equal(packaged, true);
  assert.equal(downloader.downloading, false);
});

test('strict page loading propagates metadata errors instead of packaging a partial list', async () => {
  const pageFetcher = Object.create(PageFetcher.prototype);
  Object.assign(pageFetcher, {
    queue: { downloading: () => true }, chapterIndex: 0,
    chapters: [{ sourceIter: (async function* () { yield { error: new Error('metadata failed') }; })() }],
    onFailed() {},
  });
  await assert.rejects(pageFetcher.appendNextPage(undefined, true), /metadata failed/);
  pageFetcher.changeToChapter(1);
  assert.equal(pageFetcher.chapterIndex, 0);
});

test('packaging a chapter subset uses that chapter original rule index', async () => {
  const chapters = [{ id: 10 }, { id: 20 }, { id: 30, title: 'Third chapter' }];
  const picks = [new CherryPick(), new CherryPick(), new CherryPick()];
  let actual;
  const downloader = Object.create(Downloader.prototype);
  Object.assign(downloader, {
    pageFetcher: { chapters }, cherryPicks: picks, title: () => 'test',
    panel: { flushUI() {} }, done: false, abort() {},
    mapToFileLikes(_chapter, picked) { actual = picked; return []; },
  });
  ADAPTER.conf.archiveVolumeSize = 1;
  await downloader.download([chapters[2]]);
  assert.equal(actual, picks[2]);
});

test('archive files include only selected image bytes while keeping gallery metadata', () => {
  const previousOrder = ADAPTER.conf.filenameOrder;
  ADAPTER.conf.filenameOrder = 'original';
  try {
    const pick = new CherryPick();
    pick.applyRule('2n+1');
    const queue = items(6);
    queue.forEach((item, index) => Object.assign(item, {
      stage: FetchState.DONE, data: new Uint8Array([index + 1]), node: { title: `${index + 1}.jpg` },
    }));
    const downloader = Object.create(Downloader.prototype);
    Object.assign(downloader, { filenames: new Set(), meta: () => ({ title: 'Test' }) });
    assert.deepEqual(downloader.mapToFileLikes({ filteredQueue: queue }, pick, '').map(file => file.name), ['1.jpg', '3.jpg', '5.jpg', 'meta.json']);
  } finally {
    ADAPTER.conf.filenameOrder = previousOrder;
  }
});

test('pattern panel previews drafts, preserves valid rules on errors, and restores chapters', () => {
  EBUS.reset();
  document.body.innerHTML = '<a id="downloader-panel-btn"></a>' + DownloaderPanel.html();
  const panel = new DownloaderPanel(document.body);
  const picks = [new CherryPick(), new CherryPick()];
  panel.initCherryPick(index => picks[index], index => EBUS.emit('cherry-pick-changed', index, picks[index]), () => false);
  EBUS.emit('pf-on-appended', 200, [], 0, true);
  const input = document.querySelector('#download-rule-input');
  const apply = document.querySelector('#download-rule-apply');
  const preview = document.querySelector('#download-rule-preview');
  input.value = '2n+1';
  input.dispatchEvent(new window.Event('input'));
  assert.match(preview.textContent, /100 \/ 200/);
  assert.equal(picks[0].rule, undefined);
  apply.click();
  assert.equal(picks[0].picked(1), false);
  input.value = 'n/2';
  input.dispatchEvent(new window.Event('input'));
  apply.click();
  assert.equal(picks[0].rule.toString(), '2n+1');
  assert.ok(document.querySelector('#download-rule-error').textContent);
  EBUS.emit('pf-change-chapter', 1, { filteredQueue: [], done: false });
  assert.equal(input.value, '');
  EBUS.emit('pf-change-chapter', 0, { filteredQueue: items(200), done: true });
  assert.equal(input.value, '2n+1');
  panel.flushUI('downloading');
  assert.equal(input.disabled, true);
  panel.flushUI('downloadStart');
  assert.equal(input.disabled, false);
  EBUS.reset();
});
