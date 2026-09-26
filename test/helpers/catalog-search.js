/**
 * Modular helper components for catalog search tests.
 *
 * Extracts the resource fixtures, store seeding, and response assertions that
 * used to live inline in test/catalog.search.test.js so each piece can be
 * reused and tested independently.
 */
import assert from 'node:assert/strict';
import { MemoryCatalogStore } from '../../src/catalog/memory.js';

/**
 * Builds the "Weather API" resource fixture used across the search suite.
 *
 * The fixture carries a `custom` extension description so tests can prove that
 * extension text is indexed and searchable.
 *
 * @param {object} [overrides={}] - Properties that override the defaults.
 * @returns {object} A catalog resource descriptor ready for upsertResource().
 */
export function weatherResource(overrides = {}) {
  return {
    url: 'https://example.com/api',
    serviceName: 'Weather API',
    description: 'Get current weather',
    tags: ['weather', 'forecast'],
    type: 'http',
    payTo: 'G123',
    scheme: 'exact',
    network: 'stellar:pubnet',
    extensions: {
      bazaar: { info: 'bazaar config' },
      custom: { description: 'secret token parameter' },
    },
    ...overrides,
  };
}

/**
 * Builds the "Finance API" resource fixture used across the search suite.
 *
 * @param {object} [overrides={}] - Properties that override the defaults.
 * @returns {object} A catalog resource descriptor ready for upsertResource().
 */
export function financeResource(overrides = {}) {
  return {
    url: 'https://example.com/api2',
    serviceName: 'Finance API',
    description: 'Get stock prices',
    tags: ['finance', 'stock'],
    type: 'http',
    payTo: 'G123',
    scheme: 'exact',
    network: 'stellar:pubnet',
    ...overrides,
  };
}

/**
 * Builds the minimal "Weather API 2" fixture used by the ranking test.
 *
 * @param {object} [overrides={}] - Properties that override the defaults.
 * @returns {object} A catalog resource descriptor ready for upsertResource().
 */
export function weatherTwoResource(overrides = {}) {
  return {
    url: 'https://example.com/api3',
    serviceName: 'Weather API 2',
    type: 'http',
    ...overrides,
  };
}

/**
 * Waits long enough for two upserts to land in distinct first_seen_at
 * buckets, which keeps the recency-based ranking deterministic.
 *
 * @param {number} [ms=10] - Milliseconds to wait.
 * @returns {Promise<void>}
 */
export function settleClock(ms = 10) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a MemoryCatalogStore seeded with the two baseline resources
 * (Weather API via `payment`, Finance API via `manual`).
 *
 * @returns {Promise<import('../../src/catalog/memory.js').MemoryCatalogStore>}
 */
export async function seededSearchStore() {
  const store = new MemoryCatalogStore();
  await store.upsertResource(weatherResource(), 'payment');
  // Ensure different first_seen_at so ranking order is stable.
  await settleClock();
  await store.upsertResource(financeResource(), 'manual');
  return store;
}

/**
 * Asserts the canonical search response shape: a `resources` array and a
 * `pagination` object, but no legacy `total` field.
 *
 * @param {object} res - Response returned by store.search().
 */
export function assertSearchShape(res) {
  assert.ok(res.resources, 'Has resources array');
  assert.ok(res.pagination, 'Has pagination');
  assert.strictEqual(res.total, undefined, 'Does not have total');
}

/**
 * Asserts that a search response returned exactly the expected services, in
 * order. Useful for ranking and filtering assertions.
 *
 * @param {object} res - Response returned by store.search().
 * @param {string[]} expectedServiceNames - Service names in expected order.
 * @param {string} [message] - Optional context for the failure message.
 */
export function assertServiceNames(res, expectedServiceNames, message = '') {
  const actual = res.resources.map(resource => resource.serviceName);
  assert.deepStrictEqual(
    actual,
    expectedServiceNames,
    `${message ? `${message}: ` : ''}expected ${JSON.stringify(expectedServiceNames)}, got ${JSON.stringify(actual)}`,
  );
}
