import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, templateById, publicTemplates } from '../src/templates.js';

test('every template has an id, label and focus; unknown ids fall back to general', () => {
  for (const t of TEMPLATES) assert.ok(t.id && t.label && t.focus);
  assert.equal(templateById('nope').id, 'general');
  assert.equal(templateById('sales').id, 'sales');
});
test('the public list does not expose the prompts', () => {
  assert.deepEqual(Object.keys(publicTemplates()[0]), ['id', 'label']);
});
