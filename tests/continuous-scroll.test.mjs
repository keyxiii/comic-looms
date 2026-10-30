import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuousScroller } from '../src/utils/continuous-scroller.ts';

function reader(speed = 60) {
  let callback, frameId = 0;
  const state = { position: 0, end: 10000, readyEnd: 10000, complete: false, suspended: false };
  const statuses = [];
  const controller = new ContinuousScroller({
    speed: () => speed,
    snapshot: () => ({ ...state }),
    moveTo: position => { state.position = position; },
    onState: status => statuses.push(status),
    requestFrame: cb => { callback = cb; return ++frameId; },
    cancelFrame: () => { callback = undefined; },
  });
  return { controller, state, statuses, speed: value => { speed = value; },
    frame(time) { const cb = callback; callback = undefined; cb?.(time); },
    pending: () => !!callback };
}

test('automatic scrolling covers the same distance at 60, 120 and 144 Hz', () => {
  for (const hz of [60, 120, 144]) {
    const r = reader(); r.controller.start(); r.frame(0);
    for (let i = 1; i <= hz * 5; i++) r.frame(i * 1000 / hz);
    assert.ok(Math.abs(r.state.position - 300) < 0.001, `${hz} Hz: ${r.state.position}`);
    r.controller.stop();
  }
});

test('a missing page stops at the readable boundary and loading resumes without catching up', () => {
  const r = reader(100); r.state.readyEnd = 25;
  r.controller.start(); r.frame(0);
  for (let t = 100; t <= 3000; t += 100) r.frame(t);
  assert.equal(r.state.position, 25);
  assert.equal(r.statuses.at(-1), 'waiting');
  r.state.readyEnd = 10000; r.frame(3100);
  assert.equal(r.state.position, 35);
  assert.equal(r.statuses.at(-1), 'running');
});

test('manual stop while buffering prevents a later load from restarting scrolling', () => {
  const r = reader(); r.state.readyEnd = 0;
  r.controller.start(); r.frame(0); r.frame(100);
  r.controller.stop(); r.state.readyEnd = 10000; r.frame(1000);
  assert.equal(r.state.position, 0);
  assert.equal(r.pending(), false);
  assert.equal(r.statuses.at(-1), 'stopped');
});

test('speed changes apply immediately and fractional movement accumulates', () => {
  const r = reader(10); r.controller.start(); r.frame(0);
  for (let i = 1; i <= 60; i++) r.frame(i * 1000 / 60);
  assert.ok(Math.abs(r.state.position - 10) < 0.001);
  r.speed(200); r.frame(1100);
  assert.ok(Math.abs(r.state.position - 30) < 0.001);
});

test('hidden tabs and long stalls do not cause a jump on return', () => {
  const r = reader(100); r.controller.start(); r.frame(0); r.frame(100);
  r.state.suspended = true; r.frame(200);
  r.state.suspended = false; r.controller.resetClock(); r.frame(60000);
  assert.equal(r.state.position, 10);
  r.frame(60100); assert.equal(r.state.position, 20);
  r.frame(120000); assert.equal(r.state.position, 30);
});

test('a temporary list boundary waits for appended pages; a completed chapter stops', () => {
  const r = reader(100); Object.assign(r.state, { end: 20, readyEnd: 20 });
  r.controller.start(); r.frame(0); r.frame(100); r.frame(200);
  assert.equal(r.state.position, 20); assert.equal(r.statuses.at(-1), 'waiting');
  Object.assign(r.state, { end: 40, readyEnd: 40 }); r.frame(300);
  assert.equal(r.state.position, 30);
  r.state.complete = true; r.frame(400);
  assert.equal(r.state.position, 40); assert.equal(r.statuses.at(-1), 'stopped');
  assert.equal(r.pending(), false);
});

test('starting repeatedly never creates multiple animation loops', () => {
  const r = reader(); r.controller.start(); r.controller.start(); r.frame(0); r.frame(100);
  assert.equal(r.state.position, 6); r.controller.stop(); assert.equal(r.pending(), false);
});

test('subpixel progress survives browsers rounding scrollTop writes', () => {
  let callback, actual = 0;
  const controller = new ContinuousScroller({
    speed: () => 10,
    snapshot: () => ({ position: actual, end: 1000, readyEnd: 1000, complete: false, suspended: false }),
    moveTo: value => { actual = Math.round(value); }, onState() {},
    requestFrame: cb => { callback = cb; return 1; }, cancelFrame() {},
  });
  controller.start();
  for (let frame = 0; frame <= 1440; frame++) callback(frame * 1000 / 144);
  assert.ok(Math.abs(actual - 100) <= 1, `position: ${actual}`); controller.stop();
});
