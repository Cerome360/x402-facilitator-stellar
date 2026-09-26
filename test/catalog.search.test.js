import test from 'node:test';
import assert from 'node:assert';
import {
  assertSearchShape,
  assertServiceNames,
  financeResource,
  seededSearchStore,
  settleClock,
  weatherResource,
  weatherTwoResource,
} from './helpers/catalog-search.js';

test('Catalog search tests', async t => {
  // Shared store: subtests are intentionally ordered — later ones (ranking,
  // pagination) depend on the fixtures added by earlier ones.
  const store = await seededSearchStore();

  await t.test('conforms to response shape', async () => {
    const res = await store.search({ query: 'api' });
    assertSearchShape(res);
    assert.strictEqual(res.resources.length, 2);
    assert.strictEqual(res.partialResults, true); // true because no embedding provider is configured
  });

  await t.test('filters compose with query', async () => {
    const res = await store.search({ query: 'api', extensions: ['custom'] });
    assertServiceNames(res, ['Weather API']);
  });

  await t.test('extensions are indexed', async () => {
    const res = await store.search({ query: 'secret token' });
    assertServiceNames(res, ['Weather API']);
  });

  await t.test('ranking: payment outranks manual', async () => {
    await store.upsertResource(weatherTwoResource(), 'manual');
    const res = await store.search({ query: 'weather' });
    // Payment-sourced resource outranks the manual one on equal relevance.
    assertServiceNames(res, ['Weather API', 'Weather API 2']);
  });

  await t.test('cursor pagination works', async () => {
    // Should get first page
    const page1 = await store.search({ query: 'api', limit: 1 });
    assert.strictEqual(page1.resources.length, 1);
    assert.ok(page1.pagination.cursor, 'First page returns cursor');

    // Should get second page using cursor
    const page2 = await store.search({ query: 'api', limit: 1, cursor: page1.pagination.cursor });
    assert.strictEqual(page2.resources.length, 1);
    assert.notStrictEqual(page1.resources[0].url, page2.resources[0].url);
  });

  await t.test('partialResults is truthful (true when provider is unavailable)', async () => {
    const res = await store.search({ query: 'api' });
    assert.strictEqual(res.partialResults, true);
  });
});

test('catalog search helper components', async t => {
  await t.test('seededSearchStore seeds both baseline fixtures', async () => {
    const store = await seededSearchStore();
    const res = await store.search({ query: 'api' });
    assertServiceNames(res, ['Weather API', 'Finance API']);
  });

  await t.test('fixture builders apply overrides without mutating defaults', () => {
    const custom = weatherResource({ serviceName: 'Custom Weather', tags: ['custom'] });
    assert.strictEqual(custom.serviceName, 'Custom Weather');
    assert.deepStrictEqual(custom.tags, ['custom']);
    // Defaults not overridden are preserved.
    assert.strictEqual(custom.url, 'https://example.com/api');

    // The pristine fixture is untouched by the override above.
    const pristine = weatherResource();
    assert.strictEqual(pristine.serviceName, 'Weather API');
    assert.deepStrictEqual(pristine.tags, ['weather', 'forecast']);
  });

  await t.test('assertSearchShape rejects a response missing pagination', () => {
    assert.throws(
      () => assertSearchShape({ resources: [] }),
      /pagination/,
      'assertSearchShape should fail when pagination is absent',
    );
  });

  await t.test('assertServiceNames reports the actual ordering on mismatch', () => {
    const res = { resources: [{ serviceName: 'Finance API' }, { serviceName: 'Weather API' }] };
    assert.throws(
      () => assertServiceNames(res, ['Weather API', 'Finance API'], 'ranking'),
      /ranking/,
      'assertServiceNames should include the context message',
    );
  });

  await t.test('settleClock waits for the requested duration', async () => {
    const started = Date.now();
    await settleClock(15);
    assert.ok(Date.now() - started >= 14, 'settleClock should honour its delay');
  });

  await t.test('financeResource overrides merge onto the base fixture', () => {
    const resource = financeResource({ url: 'https://example.com/other', payTo: 'G999' });
    assert.strictEqual(resource.url, 'https://example.com/other');
    assert.strictEqual(resource.payTo, 'G999');
    assert.strictEqual(resource.serviceName, 'Finance API');
    assert.strictEqual(financeResource().payTo, 'G123');
  });

  await t.test('weatherTwoResource keeps its minimal footprint by default', () => {
    const resource = weatherTwoResource();
    assert.deepStrictEqual(Object.keys(resource).sort(), ['serviceName', 'type', 'url']);
    assert.strictEqual(resource.type, 'http');
  });
});
