import test from 'node:test';
import assert from 'node:assert/strict';
import { CherryPick, CherryPickRange } from '../src/download/cherry-pick.ts';

const pages = (pick, total) => Array.from({ length: total }, (_, i) => i + 1).filter(page => pick.picked(page - 1));

test('progressions use positive one-based pages and nonnegative n', () => {
  for (const [expression, expected] of [
    ['2n+1', [1, 3, 5, 7, 9]], ['2n', [2, 4, 6, 8, 10]],
    ['3n+1', [1, 4, 7, 10]], ['5n', [5, 10]], ['2n-1', [1, 3, 5, 7, 9]],
    ['n+10', [10]], [' 2 * N + 1 ', [1, 3, 5, 7, 9]],
  ]) {
    const pick = new CherryPick();
    assert.equal(pick.applyRule(expression), true, expression);
    assert.deepEqual(pages(pick, 10), expected, expression);
  }
});

test('invalid expressions leave the existing selection intact', () => {
  const pick = new CherryPick();
  pick.applyRule('2n+1');
  for (const invalid of ['0n', '-2n+1', 'n/2', 'n*n', '2.5n', 'n+1;alert(1)', '1000001n', '9007199254740993n']) {
    assert.equal(pick.applyRule(invalid), false, invalid);
    assert.deepEqual(pages(pick, 6), [1, 3, 5]);
  }
});

test('rules match appended pages and manual overrides use the last operation', () => {
  const pick = new CherryPick();
  pick.applyRule('2n+1');
  assert.deepEqual(pages(pick, 6), [1, 3, 5]);
  assert.deepEqual(pages(pick, 10), [1, 3, 5, 7, 9]);
  pick.add(CherryPickRange.from('2-4'));
  pick.add(CherryPickRange.from('!3'));
  assert.deepEqual(pages(pick, 7), [1, 2, 4, 5, 7]);
  pick.remove('!3');
  assert.deepEqual(pages(pick, 7), [1, 2, 3, 4, 5, 7]);
  pick.applyRule('2n');
  assert.deepEqual(pages(pick, 7), [2, 4, 6]);
  pick.reset();
  assert.deepEqual(pages(pick, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test('existing range selection and exclusion still work without a rule', () => {
  const pick = new CherryPick();
  pick.add(CherryPickRange.from('2-5'));
  pick.add(CherryPickRange.from('!3'));
  assert.deepEqual(pages(pick, 7), [2, 4, 5]);
  pick.reset();
  pick.add(CherryPickRange.from('!2-4'));
  assert.deepEqual(pages(pick, 7), [1, 5, 6, 7]);
  assert.equal(CherryPickRange.from('0'), null);
});

test('preview counts the whole list but limits displayed sample pages', () => {
  const pick = new CherryPick();
  pick.applyRule('2n+1');
  assert.deepEqual(pick.preview(200, 5), { count: 100, pages: [1, 3, 5, 7, 9] });
  assert.equal(pick.preview(100000, 5).count, 50000);
});
