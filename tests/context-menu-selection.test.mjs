import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { parseHTML } from 'linkedom';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'file-saver') return { url: 'data:text/javascript,export function saveAs() {}', shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { window, document } = parseHTML('<html><body></body></html>');
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
  get() { return Array.from(this.options).find(option => option.selected)?.value ?? ''; },
  set(value) { Array.from(this.options).forEach(option => { option.selected = option.value === value; }); },
});
class MouseEvent extends window.Event {
  constructor(type, options = {}) { super(type, options); Object.assign(this, { clientX: 50, clientY: 50, ...options }); }
}
window.location = new URL('https://example.test/gallery');
window.screen = { width: 1920, height: 1080, availHeight: 1080 };
Object.assign(globalThis, {
  window, document, MouseEvent, HTMLElement: window.HTMLElement, customElements: window.customElements,
  GM: { xmlHttpRequest() { throw new Error('Unexpected network request'); } }, GM_getValue: () => undefined, GM_setValue() {},
});
const { CherryPick } = await import('../src/download/cherry-pick.ts');
const { DownloaderPanel } = await import('../src/ui/downloader-panel.ts');
const { ContextMenu } = await import('../src/ui/context-menu.ts');
const { initEvents } = await import('../src/ui/event.ts');
const { default: EBUS } = await import('../src/event-bus.ts');
const { ADAPTER } = await import('../src/platform/adapt.ts');
ADAPTER.conf.debug = false;

function fixture(t) {
  EBUS.reset();
  document.body.innerHTML = '<div id="root"><div id="grid"></div><div id="big" class="big-img-frame-collapse"></div><a id="downloader-panel-btn"></a>' + DownloaderPanel.html() + '</div>';
  const root = document.querySelector('#root');
  const fullViewGrid = document.querySelector('#grid');
  const bigImageFrame = document.querySelector('#big');
  const picks = [new CherryPick(), new CherryPick()];
  const panel = new DownloaderPanel(root);
  panel.initCherryPick(index => picks[index], index => EBUS.emit('cherry-pick-changed', index, picks[index]), () => false);
  const grid = { chapterIndex: 0, queue: [], mouseOn: () => target };
  const html = { root, fullViewGrid, bigImageFrame };
  const { appEvents } = initEvents(html, {}, grid, [], {}, {});
  const menu = new ContextMenu(html, grid, appEvents, () => undefined);
  const nodes = Array.from({ length: 50 }, (_, index) => {
    const element = document.createElement('div');
    element.setAttribute('data-index', String(index));
    element.innerHTML = '<img>';
    fullViewGrid.append(element);
    grid.queue.push({ element, node: { node: {} } });
    return element;
  });
  let target;
  const click = (page, action, expectedRange) => {
    target = nodes[page - 1];
    target.firstElementChild.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const visible = menu.items.filter(item => item.visible === 'alway' || item.visible === 'onGrid');
    const button = menu.menu.querySelectorAll('.ehvp-context-menu-item:not([data-action])')[visible.findIndex(item => item.id === action)];
    assert.ok(button, action);
    button.dispatchEvent(new window.Event('mouseover'));
    if (expectedRange) assert.ok(menu.menu.querySelector('.ehvp-context-menu-tooltip-span').textContent.endsWith(` [${expectedRange}]`));
    button.click();
    assert.equal(menu.menu, undefined);
  };
  const switchChapter = index => {
    grid.chapterIndex = index;
    EBUS.emit('pf-change-chapter', index, { filteredQueue: nodes, done: true });
  };
  t.after(() => { menu.close(); EBUS.reset(); });
  return { picks, panel, click, switchChapter };
}

test('first and repeated range picks select from page 1, matching the menu tooltip', t => {
  const { picks, click } = fixture(t);
  for (const [page, end] of [[26, 26], [40, 40], [10, 40]]) {
    click(page, 'cherry-pick-select-range', `1-${page}`);
    assert.deepEqual(picks[0].preview(50, 50).pages, Array.from({ length: end }, (_, index) => index + 1));
    assert.equal(EBUS.emit('get-cherry-pick-last-index'), 0);
  }
});

test('first and repeated range exclusions exclude from page 1', t => {
  const { picks, click } = fixture(t);
  click(26, 'cherry-pick-exclude-range', '1-26');
  assert.deepEqual(picks[0].preview(50, 50).pages, Array.from({ length: 24 }, (_, index) => index + 27));
  click(40, 'cherry-pick-exclude-range', '1-40');
  assert.deepEqual(picks[0].preview(50, 50).pages, Array.from({ length: 10 }, (_, index) => index + 41));
});

test('single picks establish a stable anchor for forward and backward range picks', t => {
  const { picks, click } = fixture(t);
  click(26, 'cherry-pick-select');
  assert.deepEqual(picks[0].preview(50, 50).pages, [26]);
  click(30, 'cherry-pick-select-range', '26-30');
  assert.deepEqual(picks[0].preview(50, 50).pages, [26, 27, 28, 29, 30]);
  click(22, 'cherry-pick-select-range', '26-22');
  assert.deepEqual(picks[0].preview(50, 50).pages, Array.from({ length: 9 }, (_, index) => index + 22));
  assert.equal(EBUS.emit('get-cherry-pick-last-index'), 25);
});

test('single exclusions establish an anchor for range exclusions', t => {
  const { picks, click } = fixture(t);
  click(26, 'cherry-pick-exclude');
  assert.equal(picks[0].picked(25), false);
  assert.equal(picks[0].picked(24), true);
  click(30, 'cherry-pick-exclude-range', '26-30');
  click(22, 'cherry-pick-exclude-range', '26-22');
  for (let page = 1; page <= 50; page++) assert.equal(picks[0].picked(page - 1), page < 22 || page > 30);
});

test('range anchors default independently per chapter and restore on returning', t => {
  const { picks, click, switchChapter } = fixture(t);
  click(26, 'cherry-pick-select');
  switchChapter(1);
  click(10, 'cherry-pick-select-range', '1-10');
  assert.deepEqual(picks[1].preview(50, 50).pages, Array.from({ length: 10 }, (_, index) => index + 1));
  click(40, 'cherry-pick-select');
  switchChapter(0);
  click(30, 'cherry-pick-select-range', '26-30');
  assert.deepEqual(picks[0].preview(50, 50).pages, [26, 27, 28, 29, 30]);
  switchChapter(1);
  click(45, 'cherry-pick-select-range', '40-45');
  assert.deepEqual(picks[1].preview(50, 50).pages, [...Array.from({ length: 10 }, (_, index) => index + 1), 40, 41, 42, 43, 44, 45]);
});

test('range actions do not change selections or anchors while downloads are locked', t => {
  const { picks, panel, click } = fixture(t);
  panel.flushUI('downloading');
  click(26, 'cherry-pick-select');
  click(30, 'cherry-pick-select-range', '1-30');
  assert.deepEqual(picks[0].values, []);
  assert.equal(EBUS.emit('get-cherry-pick-last-index'), 0);
  panel.flushUI('downloadStart');
  click(26, 'cherry-pick-select-range', '1-26');
  assert.deepEqual(picks[0].preview(50, 50).pages, Array.from({ length: 26 }, (_, index) => index + 1));
});
