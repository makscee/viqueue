import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileProjectSelection } from '../web/ui-core.js';

test('semantic All projects includes projects discovered by refresh', () => {
  const selected = new Set(['LIFE', 'VIQ']);
  assert.deepEqual([...reconcileProjectSelection(['LIFE', 'VIQ'], ['LIFE', 'NEW', 'VIQ'], selected)], ['LIFE', 'NEW', 'VIQ']);
  assert.deepEqual([...reconcileProjectSelection(['LIFE', 'VIQ'], ['LIFE', 'NEW', 'VIQ'], new Set(['VIQ']))], ['VIQ']);
});
