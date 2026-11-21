import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const load = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const schemaDir = new URL('../schemas/', import.meta.url);
const exampleDir = new URL('../configs/examples/', import.meta.url);

// Checks the keyword subset used by these starter contracts.
function validate(value, schema) {
  if ('const' in schema) assert.deepEqual(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.type === 'string') assert.equal(typeof value, 'string');
  if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
  if (schema.minLength) assert.ok(value.length >= schema.minLength);
  if (schema.format === 'date-time') {
    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(new Date(value).toISOString(), value.replace('Z', '.000Z'));
  }
  if (schema.type === 'integer') assert.ok(Number.isInteger(value) && value >= schema.minimum);
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value) && value.length >= schema.minItems);
    if (schema.uniqueItems) assert.equal(new Set(value).size, value.length);
    for (const item of value) validate(item, schema.items);
  }
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort());
    for (const [key, rule] of Object.entries(schema.properties)) validate(value[key], rule);
  }
}

const names = ['authority-grant', 'experiment', 'node-capabilities', 'workflow'];
test('schema and fixture inventory matches the four versioned contracts', () => {
  assert.deepEqual(readdirSync(schemaDir).sort(), names.map((name) => name + '.v1.schema.json'));
  assert.deepEqual(readdirSync(exampleDir).sort(), names.map((name) => name + '.v1.json'));
});
for (const name of names) {
  test(name + ' fixture conforms and stays simulation-only', () => {
    const schema = load('../schemas/' + name + '.v1.schema.json');
    const fixture = load('../configs/examples/' + name + '.v1.json');
    validate(fixture, schema);
    assert.equal(fixture.mode, 'simulation');
    assert.throws(() => validate({ ...fixture, mode: 'production' }, schema), assert.AssertionError);
    assert.throws(() => validate({ ...fixture, secret: 'unexpected' }, schema), assert.AssertionError);
  });
}
