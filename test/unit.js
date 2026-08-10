const assert = require('assert');
const { ContextBudgetManager } = require('../out/core/context/budget');
const b = new ContextBudgetManager(100, 20);
const res = b.fit([
  { id: 'low', text: 'x'.repeat(10000), priority: 1, kind: 'file' },
  { id: 'high', text: 'important', priority: 10, kind: 'selection' }
]);
assert(res.items.some(i => i.id === 'high'));
assert(res.omitted >= 1);
console.log('unit tests passed');
