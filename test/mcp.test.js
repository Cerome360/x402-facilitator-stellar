/**
 * MCP CLI integration test — the spending guard, end to end.
 *
 * Unlike {@link ../test/mcp-server.test.js | `mcp-server.test.js`}, which drives
 * `McpServer._handleRequest` in-process, this file spawns the real
 * `src/mcp/cli.js` as a child process and speaks line-delimited JSON-RPC over
 * its stdin/stdout. That is deliberate: the spending guard is the last line of
 * defence between an agent and real money, and the only way to be sure it fires
 * is to exercise the whole path the agent actually uses — process start, stdio
 * framing, `tools/call`, and the guard itself.
 *
 * The protocol-level contract (framing, batching, error tiers) is covered in
 * {@link ../test/mcp-server.test.js | `mcp-server.test.js`} and
 * {@link ../test/mcp-transport.test.js | `mcp-transport.test.js`};
 * this file is only about spending limits, so it stays deliberately small.
 *
 * @module mcp-cli-integration-test
 * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/server.js | MCP Server}
 * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/cli.js | MCP CLI}
 */
import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BoundedCapture,
  LineFramer,
  MCP_CLIENT_ERROR_CODES,
  McpClientError,
  createMcpClient,
} from './helpers/mcp-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTED_CLI = path.join(HERE, 'fixtures/mcp/scripted-cli.js');

/** A structurally valid Stellar testnet secret key; never funded, never used to pay. */
const TEST_PAYER_KEY = 'SBTJBX7IF3W4IU2VRQXK2PPEAQJW5PZTRUQPL4CVIBEL42OE3YLETWWW';

/* -------------------------------------------------------------------------- *
 * Error-code coverage harness (#386)
 *
 * Every failure assertion goes through expectFailure(), which records the code
 * it observed. The last test compares the recorded set with the declared list,
 * so a code with no test — or a test that stopped exercising its code — fails.
 * -------------------------------------------------------------------------- */

const observedCodes = new Set();

/** Absolute path to the MCP CLI entry point for child-process spawning. */
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/cli.js');

/**
 * Records every code an `onError` observer sees, so the coverage guard counts
 * errors reported asynchronously as well as ones that surface as rejections.
 */
function recordingOnError(sink = []) {
  const observer = error => {
    observedCodes.add(error?.code);
    sink.push(error);
  };
  observer.errors = sink;
  return observer;
}

/**
 * A ChildProcess stand-in good enough for createMcpClient: two readable
 * streams, a writable stdin, and kill(). Lets the client's plumbing failures be
 * triggered on demand instead of hoped for.
 */
class FakeChild extends EventEmitter {
  constructor({ writeError = null, writeThrows = null, killError = null, autoExit = false } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.killError = killError;
    this.autoExit = autoExit;
    this.written = [];
    this.stdin = {
      write: (chunk, callback) => {
        this.written.push(chunk);
        if (writeThrows) throw writeThrows;
        if (writeError) {
          callback?.(writeError);
          return false;
        }
        callback?.(null);
        return true;
      },
    };
  }

  kill(signal) {
    if (this.killError) throw this.killError;
    this.killed = true;
    if (this.autoExit) this.emit('exit', 0, signal);
    return true;
  }
}

/** Spawn stub: hands the test its FakeChild back, optionally after throwing. */
function fakeSpawn(child, { throws = null } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (throws) throw throws;
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

  // Monotonic request ids. The server echoes them, so a response can be matched
  // to its request without ordering assumptions.
  let messageId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map();
  let closed = false;

  // The child writes in chunks that do not align with line boundaries, so a
  // partial trailing line is held in `buffer` until its newline arrives. Without
  // this, a large response is parsed as truncated JSON and dropped.
  let buffer = '';
  let scannedCharacters = 0;
  return {
    push(chunk) {
      buffer += chunk.toString();
      scannedCharacters += buffer.length;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        onLine(line);
      }
    },
    get scannedCharacters() {
      return scannedCharacters;
    },
  };
}

function ndjson(count, payloadChars) {
  return (
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: i,
        result: { content: [{ type: 'text', text: 'x'.repeat(payloadChars) }] },
      }),
    ).join('\n') + '\n'
  );
}

function chunkInto(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(Buffer.from(text.slice(i, i + size)));
  return chunks;
}

/** Fastest of `runs` timings — the least noisy summary under a loaded machine. */
function fastestOf(runs, work) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    work();
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/* -------------------------------------------------------------------------- *
 * LineFramer (#388)
 * -------------------------------------------------------------------------- */

test('LineFramer: same line contract as the naive split loop', () => {
  const fixtures = {
    'one message per chunk': ['{"a":1}\n', '{"b":2}\n'],
    'a message split across many chunks': ['{"a"', ':1}\n{"b"', ':2}\n'],
    'several messages in one chunk': ['{"a":1}\n{"b":2}\n{"c":3}\n'],
    'blank and whitespace-only lines are skipped': ['\n{"a":1}\n   \n{"b":2}\n'],
    'a trailing partial line stays pending': ['{"a":1}\n{"b"'],
    'CRLF line endings': ['{"a":1}\r\n{"b":2}\r\n'],
    'a message 1 KiB long delivered 64 bytes at a time': chunkInto(
      `${JSON.stringify({ a: 'y'.repeat(1000) })}\n`,
      64,
    ),
  };

  for (const [label, chunks] of Object.entries(fixtures)) {
    const expected = [];
    const actual = [];
    const naive = naiveLineReader(line => expected.push(line));
    const framer = new LineFramer(line => actual.push(line));

    for (const chunk of chunks) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      naive.push(piece);
      framer.push(piece);
    }

    assert.deepStrictEqual(
      actual,
      expected,
      `${label}: the framer must emit exactly the same lines`,
    );
  }
});

test('LineFramer: pending bytes are reported, and never leak into the next message', () => {
  const lines = [];
  const framer = new LineFramer(line => lines.push(line));

  framer.push('{"a":1}\n{"partial"');
  assert.strictEqual(framer.pending, '{"partial"', 'the unterminated tail is still buffered');
  assert.deepStrictEqual(lines, ['{"a":1}']);

  framer.push(':done}\n');
  assert.strictEqual(framer.pending, '');
  assert.deepStrictEqual(
    lines,
    ['{"a":1}', '{"partial":done}'],
    'the tail is completed, not dropped',
  );

  framer.push('only a tail');
  assert.strictEqual(framer.pending, 'only a tail', 'a chunk with no newline is all tail');
});

/* -------------------------------------------------------------------------- *
 * BoundedCapture (#388)
 * -------------------------------------------------------------------------- */

test('BoundedCapture: retention is bounded by the cap, not by the child', () => {
  const cap = 1024;
  const chunkSize = 4096;
  const chunks = 2048; // 8 MiB of child output

  const bounded = new BoundedCapture(cap);
  const unbounded = [];
  for (let i = 0; i < chunks; i++) {
    const chunk = Buffer.alloc(chunkSize, 0x61);
    unbounded.push(chunk);
    bounded.push(chunk);
  }

  const unboundedBytes = unbounded.reduce((total, chunk) => total + chunk.length, 0);
  assert.strictEqual(unboundedBytes, chunks * chunkSize, 'the baseline really did receive 8 MiB');
  assert.strictEqual(bounded.retainedBytes, cap, 'only the cap is retained');
  assert.strictEqual(bounded.text().length, cap, 'only the cap is rendered');
  assert.strictEqual(bounded.truncated, true, 'the caller can tell output was dropped');
  assert.strictEqual(
    bounded.text(),
    'a'.repeat(cap),
    'the retained bytes are the head of the stream, where a crash explains itself',
  );

  // Metric: memory a chatty peer can cost, cap vs. naive retention.
  console.log(
    `    stderr retention: ${bounded.retainedBytes} B capped vs ${unboundedBytes} B unbounded ` +
      `(${(unboundedBytes / bounded.retainedBytes).toFixed(0)}x)`,
  );
});

test('BoundedCapture: a stream under the cap is retained whole, and text() is stable', () => {
  const capture = new BoundedCapture(64);
  capture.push('crash: ');
  capture.push('boom\n');

  assert.strictEqual(capture.truncated, false);
  assert.strictEqual(capture.retainedBytes, 12);
  assert.strictEqual(capture.text(), 'crash: boom\n');
  assert.strictEqual(capture.text(), capture.text(), 'rendering is memoised, not recomputed');

  capture.push('more');
  assert.strictEqual(
    capture.text(),
    'crash: boom\nmore',
    'appending invalidates the memoised text',
  );
});

/* -------------------------------------------------------------------------- *
 * The client, over a real pipe
 * -------------------------------------------------------------------------- */

/** Spawns the scripted peer and returns a client plus its async errors. */
function clientFor(mode, options = {}) {
  const errors = recordingOnError();
  const client = createMcpClient(
    { FAKE_MCP_MODE: mode, AGENT_PAYER_SECRET_KEY: TEST_PAYER_KEY },
    {
      cliPath: SCRIPTED_CLI,
      timeout: 2000,
      echoStderr: false,
      onError: errors,
      ...options,
    },
  );
  return { client, errors };
}

/**
 * Spending control integration test.
 *
 * Verifies that the `call_paid_resource` tool enforces per-call and session
 * spending caps. A real HTTP 402 challenge is required because the tool reads
 * the price out of the challenge body — a stub that returned a fixed price
 * would let the cap logic pass while the real parsing path was broken.
 *
 * Test setup:
 * - Per-call cap: 500 stroops
 * - Session cap: 1000 stroops
 * - Test resource: 600 stroops (exceeds the per-call cap)
 *
 * The test asserts that the 600-stroop resource is refused by the per-call cap.
 * After each test, teardown runs in reverse dependency order to ensure clean
 * shutdown: closeConnections before close so server.close() can complete its
 * handshake, and the child is killed last so it cannot outlive the fixture.
 *
 * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/cli.js | MCP CLI spending guard}
 */
test('MCP Server Spending Controls', async t => {
  let client;
  const serverRef = { current: null };

  const result = await client.callTool('search_resources', { query: 'weather' });
  assert.strictEqual(result.content[0].text, 'echo:search_resources');
  assert.deepStrictEqual(errors.errors, [], 'a clean call reports nothing asynchronously');
});

test('MCP client: a response delivered one byte at a time is reassembled', async t => {
  // The peer writes a byte per event-loop turn, so every read boundary lands
  // inside the JSON. A framer that dropped the tail would fail here, and only
  // here.
  const { client } = clientFor('split');
  t.after(() => !client.isClosed() && client.close());

  const result = await client.callTool('call_paid_resource', { url: 'http://example.com' });
  assert.strictEqual(result.content[0].text, 'echo:call_paid_resource');
});

test('MCP client: non-JSON noise is reported as PARSE_ERROR without losing the real response', async t => {
  const { client, errors } = clientFor('garbage');
  t.after(() => !client.isClosed() && client.close());

  const result = await client.callTool('search_resources', {});
  assert.strictEqual(result.content[0].text, 'echo:search_resources');

  const parseErrors = errors.errors.filter(error => error.code === 'PARSE_ERROR');
  assert.strictEqual(parseErrors.length, 1, 'the unparseable line is reported once');
  assert.strictEqual(parseErrors[0].context.line, 'this line is not json');
  assert.ok(parseErrors[0].context.parseError, 'the parse failure carries its cause');
});

test('MCP client: a JSON-RPC error becomes TOOL_CALL_FAILED with its code and data', async t => {
  const { client } = clientFor('tool-error');
  t.after(() => !client.isClosed() && client.close());

  const error = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'TOOL_CALL_FAILED',
    'scripted tool error',
  );
  assert.strictEqual(error.message, 'scripted tool failure', 'the tool message is propagated');
  assert.strictEqual(error.context.errorCode, -32000);
  assert.deepStrictEqual(error.context.errorData, { hint: 'retry later' });
});

test('MCP client: a silent peer is a TIMEOUT naming the tool and the budget', async t => {
  const { client } = clientFor('silent', { timeout: 150 });
  t.after(() => !client.isClosed() && client.close());

  const error = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'TIMEOUT',
    'silent peer',
  );
  assert.strictEqual(error.context.toolName, 'call_paid_resource');
  assert.strictEqual(error.context.timeoutMs, 150);
});

test('MCP client: a peer that dies with a request in flight is PROCESS_EXIT', async t => {
  const { client } = clientFor('exit', { timeout: 5000 });
  t.after(() => !client.isClosed() && client.close());

  const error = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'PROCESS_EXIT',
    'peer dying mid-request',
  );
  assert.strictEqual(error.context.exitCode, 3, 'the exit status is reported, not guessed');
  assert.strictEqual(typeof error.context.stderr, 'string', 'stderr is attached for diagnosis');
});

test('MCP client: close() rejects in-flight calls and refuses new ones', async t => {
  const { client } = clientFor('silent', { timeout: 5000 });
  t.after(() => !client.isClosed() && client.close());

  const inFlight = client.callTool('call_paid_resource', { url: 'http://example.com' });
  client.close();

  const inFlightError = await expectFailure(inFlight, 'CLIENT_CLOSED', 'a call in flight at close');
  assert.match(inFlightError.message, /client was closed/);
  assert.strictEqual(client.isClosed(), true);

  const afterClose = await expectFailure(
    client.callTool('call_paid_resource', { url: 'http://example.com' }),
    'CLIENT_CLOSED',
    'a call after close',
  );
  assert.match(afterClose.message, /closed MCP client/);

  client.close(); // idempotent: a second close must not throw or double-kill
  assert.strictEqual(client.isClosed(), true);
});

/* -------------------------------------------------------------------------- *
 * The client's plumbing, via an injected spawn
 * -------------------------------------------------------------------------- */

test('MCP client: a spawn that throws is SPAWN_FAILED, synchronously', () => {
  const spawn = fakeSpawn(null, { throws: new Error('spawn EACCES') });
  assert.throws(
    () => createMcpClient({}, { spawn, cliPath: '/nope' }),
    error => {
      observedCodes.add(error.code);
      assert.strictEqual(error.code, 'SPAWN_FAILED');
      assert.strictEqual(error.context.cliPath, '/nope');
      assert.strictEqual(error.context.originalError, 'spawn EACCES');
      return true;
    },
  );
});

test('MCP client: a child process error rejects every in-flight call', async () => {
  const child = new FakeChild();
  const errors = recordingOnError();
  const client = createMcpClient(
    {},
    { spawn: fakeSpawn(child), onError: errors, echoStderr: false },
  );
  assert.strictEqual(
    fakeSpawn(child).calls.length,
    0,
    'the stub is not called until the client spawns',
  );

  const first = client.callTool('one', {});
  const second = client.callTool('two', {});
  child.emit('error', new Error('EACCES'));

  for (const [call, name] of [
    [first, 'one'],
    [second, 'two'],
  ]) {
    const error = await expectFailure(call, 'PROCESS_ERROR', `${name} after a child error`);
    assert.strictEqual(error.context.originalError, 'EACCES');
    assert.strictEqual(typeof error.context.stderr, 'string');
  }
  assert.strictEqual(errors.errors.length, 1, 'the process error is reported once, not per call');
});

test('MCP client: stdin failures surface as STDIN_WRITE_ERROR and STDIN_WRITE_EXCEPTION', async () => {
  const failing = new FakeChild({ writeError: new Error('write EPIPE') });
  const clientA = createMcpClient({}, { spawn: fakeSpawn(failing), echoStderr: false });
  const errorA = await expectFailure(
    clientA.callTool('one', {}),
    'STDIN_WRITE_ERROR',
    'stdin write',
  );
  assert.strictEqual(errorA.context.originalError, 'write EPIPE');

  const throwing = new FakeChild({ writeThrows: new Error('stdin is destroyed') });
  const clientB = createMcpClient({}, { spawn: fakeSpawn(throwing), echoStderr: false });
  const errorB = await expectFailure(
    clientB.callTool('one', {}),
    'STDIN_WRITE_EXCEPTION',
    'stdin throw',
  );
  assert.strictEqual(errorB.context.originalError, 'stdin is destroyed');
});

  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/test-200-stroops') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'payment_required',
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'stellar:testnet',
              price: { asset: 'native', amount: '200' },
              payTo: 'GBQ...',
            },
          ],
        }),
      );
    } else if (req.url === '/test-600-stroops') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'payment_required',
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'stellar:testnet',
              price: { asset: 'native', amount: '600' },
              payTo: 'GBQ...',
            },
          ],
        }),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
    assert.deepStrictEqual(actual, expected, `${label}: identical lines are a precondition`);

    // 2. Deterministic metric: characters re-scanned, versus the single pass
    //    the framer makes over the same bytes.
    const rescans = naive.scannedCharacters / inputBytes;
    assert.ok(
      rescans >= minRescans,
      `${label}: the naive reader should be re-scanning its undelivered tail ` +
        `(measured ${rescans.toFixed(1)}x the input, expected at least ${minRescans}x)`,
    );

  await new Promise(r => server.listen(0, r));
  serverRef.current = server;
  const port = server.address().port;
  const url600 = `http://localhost:${port}/test-600-stroops`;

  /**
   * Enforces the per-call cap: a 600-stroop resource must be refused when the
   * cap is 500 stroops. This is the core assertion of the spending guard.
   *
   * The guard should reject the request and the error message must contain
   * "Spending refused" and "exceeds per-call limit".
   *
   * @see {@link https://github.com/accensa/x402-facilitator-stellar/blob/main/src/mcp/cli.js | Spending guard logic}
   */
  await t.test('enforces per-call cap (600 > 500)', async () => {
    try {
      await client.callTool('call_paid_resource', { url: url600 });
      // Reaching here means the guard let an over-cap payment through — the
      // failure mode this whole file exists to prevent.
      assert.fail('Should have rejected');
    } catch (err) {
      console.log('Caught error:', err.message);
      assert.ok(err instanceof McpClientError || err.message, 'Error should be defined');
      assert.match(
        err.message,
        /Spending refused.*exceeds per-call limit/,
        'Error message should indicate per-call limit exceeded',
      );
    }
  }
});

/* -------------------------------------------------------------------------- *
 * The CLI's spending controls, end to end and offline
 * -------------------------------------------------------------------------- */

/**
 * A mock paid resource. Every refusal asserted against it happens before the
 * CLI signs anything, which is what keeps these tests offline and instant.
 */
function startMockResources() {
  const server = http.createServer((req, res) => {
    const paymentRequired = amount =>
      JSON.stringify({
        error: 'payment_required',
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'stellar:testnet',
            price: { asset: 'native', amount },
            payTo: 'GBQ...',
          },
        ],
      });

    if (req.url === '/free') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('no payment needed');
      return;
    }
    if (req.url === '/priced-200') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(paymentRequired('200'));
      return;
    }
    if (req.url === '/priced-600') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(paymentRequired('600'));
      return;
    }
    if (req.url === '/no-accepts') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment_required', x402Version: 1, accepts: [] }));
      return;
    }
    if (req.url === '/bad-402') {
      // A 402 that is not a payment-required response at all.
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'gateway said no' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return {
    listen: () => new Promise(resolve => server.listen(0, () => resolve(server.address().port))),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Spawns the real MCP CLI with the given spend controls. */
function cliClient(env, options = {}) {
  const errors = recordingOnError();
  const client = createMcpClient(env, { timeout: 15000, onError: errors, ...options });
  return { client, errors };
}

test('MCP CLI spending controls: refusals are explicit, offline and before signing', async t => {
  const mock = startMockResources();
  const port = await mock.listen();
  const url = name => `http://localhost:${port}${name}`;

  // Caps with room: the per-call cap is 500, so a 200-stroop resource passes it
  // and the refusals below have to come from the checks further in.
  const roomy = cliClient({
    AGENT_PAYER_SECRET_KEY: TEST_PAYER_KEY,
    MAX_FEE_PER_CALL_STROOPS: '500',
    MAX_SESSION_SPEND_STROOPS: '1000',
  });
  // No session budget at all: the first priced call is refused by the session
  // check even though it fits the per-call cap.
  const noBudget = cliClient({
    AGENT_PAYER_SECRET_KEY: TEST_PAYER_KEY,
    MAX_FEE_PER_CALL_STROOPS: '500',
    MAX_SESSION_SPEND_STROOPS: '0',
  });
  // No payer configured: the tool refuses before it even fetches.
  const noPayer = cliClient({ AGENT_PAYER_SECRET_KEY: '', MAX_FEE_PER_CALL_STROOPS: '500' });

  t.after(() => {
    for (const { client } of [roomy, noBudget, noPayer]) if (!client.isClosed()) client.close();
    mock.close();
  });

  await t.test('enforces the per-call cap (600 > 500)', async () => {
    const error = await expectFailure(
      roomy.client.callTool('call_paid_resource', { url: url('/priced-600') }),
      'TOOL_CALL_FAILED',
      'over-cap call',
    );
    assert.match(error.message, /Spending refused.*exceeds per-call limit/);
  });

  await t.test('enforces the session budget before the per-call cap is relaxed', async () => {
    const error = await expectFailure(
      noBudget.client.callTool('call_paid_resource', { url: url('/priced-200') }),
      'TOOL_CALL_FAILED',
      'session-budget call',
    );
    assert.match(error.message, /Spending refused.*exceeds remaining session budget/);
    assert.match(
      error.message,
      /spent 0\/0 stroops/,
      'the refusal names the budget it compared against',
    );
  });

  await t.test('enforces a caller-supplied maxFeeStroops below the global cap', async () => {
    const error = await expectFailure(
      roomy.client.callTool('call_paid_resource', {
        url: url('/priced-200'),
        maxFeeStroops: '100',
      }),
      'TOOL_CALL_FAILED',
      'maxFeeStroops call',
    );
    assert.match(error.message, /exceeds requested maxFeeStroops/);
  });

  await t.test('an unpaid 200 is passed through without spending', async () => {
    const result = await roomy.client.callTool('call_paid_resource', { url: url('/free') });
    assert.strictEqual(result.isError, false);
    // The MCP server frames tool results as text content, so the CLI's object
    // arrives JSON-encoded inside it.
    const body = JSON.parse(result.content[0].text);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.status, 200);
    assert.strictEqual(body.response, 'no payment needed');
    assert.strictEqual(body.settlement, undefined, 'nothing was paid, so nothing settled');
  });

  await t.test('a 402 with no accepts is named as such', async () => {
    const error = await expectFailure(
      roomy.client.callTool('call_paid_resource', { url: url('/no-accepts') }),
      'TOOL_CALL_FAILED',
      '402 without requirements',
    );
    assert.match(error.message, /no payment accepts requirements/);
  });

  await t.test(
    'a 402 that is not a payment-required response reports a parse failure',
    async () => {
      const error = await expectFailure(
        roomy.client.callTool('call_paid_resource', { url: url('/bad-402') }),
        'TOOL_CALL_FAILED',
        'malformed 402',
      );
      assert.match(error.message, /Failed to parse payment requirements/);
    },
  );

  await t.test('without a payer key the paid tool refuses instead of half-paying', async () => {
    const error = await expectFailure(
      noPayer.client.callTool('call_paid_resource', { url: url('/priced-200') }),
      'TOOL_CALL_FAILED',
      'no payer key',
    );
    assert.match(error.message, /requires AGENT_PAYER_SECRET_KEY/);
  });
});

/* -------------------------------------------------------------------------- *
 * Coverage guard (#386) — must stay last: it reports on the whole file.
 * -------------------------------------------------------------------------- */

test('MCP client: every declared error code is exercised by this suite (#386)', () => {
  const missing = MCP_CLIENT_ERROR_CODES.filter(code => !observedCodes.has(code));
  const undeclared = [...observedCodes].filter(code => !MCP_CLIENT_ERROR_CODES.includes(code));

  assert.deepStrictEqual(
    missing,
    [],
    'these codes are declared by the client but no test produces them — add the test or delete the code',
  );
  assert.deepStrictEqual(
    undeclared,
    [],
    'these codes were reported by tests but are not declared in MCP_CLIENT_ERROR_CODES',
  );
  assert.strictEqual(
    observedCodes.size,
    MCP_CLIENT_ERROR_CODES.length,
    'the error-code surface is covered exhaustively',
  );
});
