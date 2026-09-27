/**
 * @file Documentation-first tests for catalog search behaviour.
 *
 * Covers the contract of {@link MemoryCatalogStore#search}: response shape,
 * filter composition, extension indexing, source-based ranking, cursor
 * pagination, and the truthfulness of the `partialResults` flag when no
 * embedding provider is configured.
 *
 * Fixtures, store seeding and response assertions are extracted into
 * ./helpers/catalog-search.js so each subtest below reads as a behavioural
 * spec rather than setup boilerplate.
 *
 * Every public interface follows TSDoc-style block comments so the
 * business intent is legible without reading the implementation.
 */
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

/**
 * Catalog search suite.
 *
 * Seeds a shared store via seededSearchStore() with two baseline resources:
 *
 * 1. "Weather API" — ingested from the `payment` stream, carrying a `custom`
 *    extension whose description contains indexed free-text ("secret token").
 * 2. "Finance API" — ingested from the `manual` stream.
 *
 * The subtests are order-dependent by design: later ones (ranking,
 * pagination) rely on fixtures introduced by earlier ones, so they run
 * sequentially against the same store instance.
 *
 * @param t - Node test context used to register the nested subtests.
 */
test('Catalog search tests', async t => {
  // Shared store: subtests are intentionally ordered — later ones (ranking,
  // pagination) depend on the fixtures added by earlier ones.
  const store = await seededSearchStore();

  /**
   * Asserts the search response conforms to the discovery contract:
   * `resources` array + `pagination` object, and no legacy `total` field.
   *
   * `partialResults` must be `true` here because no embedding provider is
   * configured — the store falls back to keyword matching and says so.
   */
  await t.test('conforms to response shape', async () => {
    const res = await store.search({ query: 'api' });
    assertSearchShape(res);
    assert.strictEqual(res.resources.length, 2);
    assert.strictEqual(res.partialResults, true); // true because no embedding provider is configured
  });

  /**
   * Proves extension filters compose with (rather than replace) the
   * free-text query: only the resource advertising the `custom` extension
   * survives, even though both match the query text.
   */
  await t.test('filters compose with query', async () => {
    const res = await store.search({ query: 'api', extensions: ['custom'] });
    assertServiceNames(res, ['Weather API']);
  });

  /**
   * Proves extension values are part of the search index: querying free text
   * that appears only inside the `custom` extension description still
   * surfaces the owning resource.
   */
  await t.test('extensions are indexed', async () => {
    const res = await store.search({ query: 'secret token' });
    assertServiceNames(res, ['Weather API']);
  });

  /**
   * Proves source-based ranking: when two resources match equally well, the
   * one ingested from the `payment` stream outranks the `manual` one.
   *
   * Adds a third fixture inline so the tie-break is observable.
   */
  await t.test('ranking: payment outranks manual', async () => {
    await store.upsertResource(weatherTwoResource(), 'manual');
    const res = await store.search({ query: 'weather' });
    // Payment-sourced resource outranks the manual one on equal relevance.
    assertServiceNames(res, ['Weather API', 'Weather API 2']);
  });

  /**
   * Proves opaque cursor pagination: consecutive `limit: 1` pages must
   * return distinct resources, walked via `pagination.cursor`.
   */
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

  /**
   * Truth-in-advertising check on `partialResults`: with no embedding
   * provider available the store must flag the result set as partial rather
   * than silently implying exhaustive semantic recall.
   */
  await t.test('partialResults is truthful (true when provider is unavailable)', async () => {
    const res = await store.search({ query: 'api' });
    assert.strictEqual(res.partialResults, true);
  });
});

/**
 * Unit tests for the extracted helper components themselves, covering the
 * edge cases the refactor touched: override merging, fixture isolation,
 * assertion failure messages, and seed contents.
 */
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

/**
 * Typed failure for the catalog search path (#374).
 *
 * A bare `TypeError` escaping `store.search()` is the failure mode this class
 * exists to remove: the caller cannot tell "the store is broken" from "I called
 * it wrong", and there is nothing stable to log or to branch on. Every failure
 * below therefore carries a `code` from {@link SEARCH_ERROR_CODES}, the params
 * that produced it, and — where there was an underlying throw — its `cause`.
 */
export class CatalogSearchError extends Error {
  constructor(message, { code, params, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CatalogSearchError';
    this.code = code;
    this.params = params;
    this.details = details;
  }
}

/** Every failure mode `safeSearch()` can report. Stable enough to branch on. */
export const SEARCH_ERROR_CODES = Object.freeze({
  INVALID_PARAMS: 'invalid_search_params',
  INVALID_QUERY: 'invalid_search_query',
  INVALID_LIMIT: 'invalid_search_limit',
  STORE_FAILED: 'search_store_failed',
  MALFORMED_RESPONSE: 'malformed_search_response',
});

/**
 * Describes why a search response is unusable, or null when it is fine.
 *
 * The store contract is `{ resources: [], pagination: {} }`; anything else is
 * a caller-visible crash waiting to happen (a `.resources.map` on undefined),
 * so it is refused here with a message that names the missing piece.
 */
function describeResponseProblem(response) {
  if (response === null || typeof response !== 'object') {
    return `expected an object, received ${response === null ? 'null' : typeof response}`;
  }
  if (!Array.isArray(response.resources)) return 'missing a resources array';
  if (!response.pagination || typeof response.pagination !== 'object') {
    return 'missing a pagination object';
  }
  return null;
}

/**
 * Runs a catalog search with the error handling the store deliberately does not
 * do: argument validation, a typed error per failure mode, and one structured
 * diagnostic carrying the code and the params.
 *
 * The store itself assumes an already-validated API boundary, which is why
 * `store.search()` with no arguments throws a bare TypeError today — that is
 * exactly the unhandled edge case this wrapper closes.
 *
 * @param {object} store - Store exposing `search(params)`.
 * @param {object} [params={}] - Search parameters.
 * @param {object} [options] - `logger` (error(msg, meta)) defaults to console.
 * @returns {Promise<object>} The store's response, unchanged.
 * @throws {CatalogSearchError} For every failure mode listed in
 *   {@link SEARCH_ERROR_CODES}; never a bare TypeError.
 */
export async function safeSearch(store, params = {}, { logger = console } = {}) {
  const fail = (code, message, details = {}) => {
    const error = new CatalogSearchError(message, { code, params, details });
    logger.error(`[CatalogSearch] ${message}`, { code, params, ...details });
    throw error;
  };

  if (!store || typeof store.search !== 'function') {
    return fail(SEARCH_ERROR_CODES.INVALID_PARAMS, 'search() requires a store exposing search()');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return fail(SEARCH_ERROR_CODES.INVALID_PARAMS, 'search() requires a params object');
  }
  // Only a string is safe to hand to the scorer: anything truthy without
  // .trim() (a number, an object) throws inside scoreResource().
  if (params.query !== undefined && params.query !== null && typeof params.query !== 'string') {
    return fail(
      SEARCH_ERROR_CODES.INVALID_QUERY,
      `search() requires a string query, received ${typeof params.query}`,
      { received: typeof params.query },
    );
  }
  // The store slices with the limit verbatim (`slice(0, -1)` silently drops
  // the last result), so a non-positive or fractional limit is refused rather
  // than turned into a quietly wrong page.
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    return fail(
      SEARCH_ERROR_CODES.INVALID_LIMIT,
      `search() requires a positive integer limit, received ${JSON.stringify(params.limit)}`,
      { received: params.limit === undefined ? null : params.limit },
    );
  }

  let response;
  try {
    response = await store.search(params);
  } catch (cause) {
    const message = `catalog search failed: ${cause?.message ?? String(cause)}`;
    logger.error(`[CatalogSearch] ${message}`, {
      code: SEARCH_ERROR_CODES.STORE_FAILED,
      params,
      cause,
    });
    throw new CatalogSearchError(message, {
      code: SEARCH_ERROR_CODES.STORE_FAILED,
      params,
      cause,
    });
  }

  const problem = describeResponseProblem(response);
  if (problem) {
    return fail(
      SEARCH_ERROR_CODES.MALFORMED_RESPONSE,
      `catalog search returned a malformed response: ${problem}`,
    );
  }

  return response;
}

/**
 * The fallback page: an honest empty result rather than a failed request.
 *
 * `degraded` is the tell — a caller that would rather serve "no results right
 * now" than a 500 can check it (and `reason`) without inferring anything from
 * an empty array, which a healthy search can also produce.
 */
export function degradedSearchPage(params = {}, reason = 'search_unavailable') {
  return {
    resources: [],
    partialResults: true,
    degraded: true,
    reason,
    pagination: { limit: Number.isInteger(params.limit) ? params.limit : 20, cursor: null },
  };
}

/**
 * `safeSearch()` for callers that must answer: on any failure the request gets
 * a degraded empty page, and the failure is logged once, at error level.
 *
 * An error that is not a {@link CatalogSearchError} is re-thrown rather than
 * converted — that would be a bug in the wrapper itself, and swallowing it in
 * the name of resilience is how unhandled states stay invisible.
 */
export async function searchWithFallback(store, params = {}, { logger = console } = {}) {
  try {
    return await safeSearch(store, params, { logger });
  } catch (error) {
    if (!(error instanceof CatalogSearchError)) throw error;
    logger.error(
      `[CatalogSearch] serving a degraded empty page instead of failing the request: ${error.message}`,
      { code: error.code, params },
    );
    return degradedSearchPage(params, error.code);
  }
}

/**
 * Collects `logger.error(msg, meta)` calls so a test can assert on diagnostics
 * without writing to the console.
 */
function taggedLogger() {
  const entries = [];
  return { entries, error: (message, meta) => entries.push({ level: 'error', message, meta }) };
}

/**
 * A store stand-in that records the params it was called with and returns — or
 * throws — whatever the test tells it to. Lets each failure mode below be
 * produced on demand and keeps "the store was never reached" assertable.
 */
function probeStore(behaviour) {
  const calls = [];
  return {
    calls,
    async search(params) {
      calls.push(params);
      return typeof behaviour === 'function' ? behaviour(params) : behaviour;
    },
  };
}

/**
 * #374 — every error state on the search path is explicit.
 *
 * The contract these tests pin, in the order a real request meets it:
 *
 * 1. Callers get a typed {@link CatalogSearchError} with a stable code, the
 *    params that caused it and a message that names the offending value —
 *    never the bare TypeError the store throws for an unvalidated boundary.
 * 2. A rejected call never reaches the store, so a bad request cannot be
 *    turned into store work or into half-written state.
 * 3. Exactly one diagnostic is logged per failure, carrying the code and the
 *    params; a successful call logs nothing.
 * 4. A response that cannot be served is refused here, where the message can
 *    say which part of the contract is missing.
 * 5. Callers that must answer can take the degraded empty page, which is
 *    visibly degraded rather than an empty array that looks like "no matches".
 */
test('Catalog search error handling and logging (#374)', async t => {
  await t.test(
    'a bare store.search() is the unhandled case; the wrapper returns a page',
    async () => {
      const store = await seededSearchStore();

      // The edge case this issue is about: the store assumes an API-validated
      // boundary and throws an untyped TypeError when called with nothing.
      await assert.rejects(
        () => store.search(),
        TypeError,
        'the raw store call is the unhandled exception the wrapper must absorb',
      );

      const page = await safeSearch(store, undefined, { logger: taggedLogger() });
      assert.deepStrictEqual(page.resources, [], 'a defaulted call is a well-formed empty page');
      assert.strictEqual(page.partialResults, true);
      assert.ok(page.pagination, 'the response shape is complete, not a crash');
    },
  );

  await t.test('rejects a missing or malformed store with a typed error', async () => {
    const logger = taggedLogger();
    for (const store of [null, undefined, {}, { search: 'not a function' }]) {
      await assert.rejects(
        () => safeSearch(store, { query: 'api' }, { logger }),
        err => {
          assert.strictEqual(err.name, 'CatalogSearchError');
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_PARAMS);
          assert.match(err.message, /requires a store exposing search/);
          return true;
        },
      );
    }
    assert.strictEqual(
      logger.entries.length,
      4,
      'each rejected call logs once, and nothing else does',
    );
  });

  await t.test('rejects non-object params before the store is touched', async () => {
    for (const params of ['api', 42, true, []]) {
      const store = probeStore({ resources: [], pagination: {} });
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(store, params, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_PARAMS);
          assert.match(err.message, /requires a params object/);
          return true;
        },
      );
      assert.deepStrictEqual(store.calls, [], 'a rejected call must not reach the store');
      assert.strictEqual(logger.entries.length, 1, 'one failure, one diagnostic');
    }
  });

  await t.test('rejects a non-string query with the received type in the message', async () => {
    for (const query of [42, true, { term: 'api' }, ['api']]) {
      const store = probeStore({ resources: [], pagination: {} });
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(store, { query }, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_QUERY);
          assert.match(err.message, /requires a string query, received/);
          assert.strictEqual(err.details.received, typeof query);
          return true;
        },
      );
      assert.deepStrictEqual(store.calls, [], 'the scorer must never see a non-string query');
    }
  });

  await t.test('rejects a limit the store would silently mis-slice', async () => {
    // memory.js slices with the limit verbatim, so these are not "clamped by
    // the boundary" — they are a wrong page nobody would notice.
    for (const limit of [0, -1, 1.5, NaN, '10']) {
      const store = probeStore({ resources: [], pagination: {} });
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(store, { query: 'api', limit }, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.INVALID_LIMIT);
          assert.match(err.message, /requires a positive integer limit/);
          return true;
        },
      );
      assert.deepStrictEqual(store.calls, []);
    }
  });

  await t.test(
    'wraps a store throw, preserving the cause and naming it in the message',
    async () => {
      const underlying = new Error('catalog table unavailable');
      const store = probeStore(() => {
        throw underlying;
      });
      const logger = taggedLogger();

      await assert.rejects(
        () => safeSearch(store, { query: 'api' }, { logger }),
        err => {
          assert.strictEqual(err.name, 'CatalogSearchError');
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.STORE_FAILED);
          assert.match(err.message, /catalog search failed: catalog table unavailable/);
          assert.strictEqual(err.cause, underlying, 'the original error must stay reachable');
          assert.deepStrictEqual(err.params, { query: 'api' });
          return true;
        },
      );
      assert.strictEqual(logger.entries.length, 1);
      assert.match(logger.entries[0].message, /catalog search failed/);
      assert.strictEqual(logger.entries[0].meta.code, SEARCH_ERROR_CODES.STORE_FAILED);
      assert.strictEqual(logger.entries[0].meta.cause, underlying);
    },
  );

  await t.test('refuses a malformed response and says which part is missing', async () => {
    const cases = [
      [null, /expected an object, received null/],
      ['a string', /expected an object, received string/],
      [{}, /missing a resources array/],
      [{ resources: {} }, /missing a resources array/],
      [{ resources: [] }, /missing a pagination object/],
    ];

    for (const [response, expected] of cases) {
      const logger = taggedLogger();
      await assert.rejects(
        () => safeSearch(probeStore(response), { query: 'api' }, { logger }),
        err => {
          assert.strictEqual(err.code, SEARCH_ERROR_CODES.MALFORMED_RESPONSE);
          assert.match(err.message, expected);
          return true;
        },
      );
      assert.strictEqual(logger.entries.length, 1);
    }
  });

  await t.test('a successful search is returned unchanged and logs nothing', async () => {
    const response = { resources: [{ serviceName: 'Weather API' }], pagination: { cursor: null } };
    const store = probeStore(response);
    const logger = taggedLogger();
    const res = await safeSearch(store, { query: 'weather', limit: 1 }, { logger });

    assert.strictEqual(res, response, 'the wrapper must not reshape a healthy response');
    assert.deepStrictEqual(store.calls, [{ query: 'weather', limit: 1 }]);
    assert.deepStrictEqual(logger.entries, [], 'success is not a diagnostic');
  });
});

/**
 * #374 — the fallback path.
 *
 * Two guarantees: a caller that must answer gets a page it can distinguish from
 * "no matches", and a failure that is not a {@link CatalogSearchError} is not
 * swallowed — that would be a bug in this wrapper, and hiding it behind an
 * empty page is how such a bug survives.
 */
test('Catalog search fallback (#374)', async t => {
  await t.test('serves a visibly degraded empty page and logs the reason once', async () => {
    const store = probeStore(() => {
      throw new Error('catalog table unavailable');
    });
    const logger = taggedLogger();
    const page = await searchWithFallback(store, { query: 'api', limit: 5 }, { logger });

    assert.deepStrictEqual(page.resources, []);
    assert.strictEqual(page.degraded, true, 'an empty page from a failure must be marked degraded');
    assert.strictEqual(page.reason, SEARCH_ERROR_CODES.STORE_FAILED);
    assert.strictEqual(page.partialResults, true);
    assert.strictEqual(
      page.pagination.cursor,
      null,
      'a degraded page must not invite a cursor walk',
    );
    assert.strictEqual(
      page.pagination.limit,
      5,
      'the requested limit is echoed so the shape is unchanged',
    );

    assert.strictEqual(
      logger.entries.length,
      2,
      'the failure and the fallback are each reported once',
    );
    assert.match(logger.entries[1].message, /degraded empty page/);
    assert.strictEqual(logger.entries[1].meta.code, SEARCH_ERROR_CODES.STORE_FAILED);
  });

  await t.test('a degraded page is distinguishable from a healthy empty result', async () => {
    const healthy = await safeSearch(probeStore({ resources: [], pagination: { cursor: null } }));
    const degraded = degradedSearchPage({ query: 'api' }, SEARCH_ERROR_CODES.INVALID_QUERY);

    assert.strictEqual(
      healthy.degraded,
      undefined,
      'a healthy empty page carries no degraded flag',
    );
    assert.strictEqual(degraded.degraded, true);
    assert.strictEqual(
      degraded.pagination.limit,
      20,
      'the default page size applies when none was asked for',
    );
  });

  await t.test('re-throws a failure that is not a CatalogSearchError', async () => {
    const exploding = {
      error() {
        throw new Error('logger exploded');
      },
    };
    // The store has to fail for the wrapper to reach its diagnostics at all:
    // the throw below happens while reporting that failure, so it is a failure
    // the wrapper never classified.
    const store = probeStore(() => {
      throw new Error('catalog table unavailable');
    });

    await assert.rejects(
      () => searchWithFallback(store, { query: 'api' }, { logger: exploding }),
      err => {
        assert.strictEqual(err.message, 'logger exploded');
        assert.strictEqual(err instanceof CatalogSearchError, false);
        return true;
      },
      'a failure this wrapper did not classify is a bug and must not be hidden behind an empty page',
    );
  });
});
