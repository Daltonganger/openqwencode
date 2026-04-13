import { test as _nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const modulePath = new URL('./index.js', import.meta.url).href;
const pluginModulePath = new URL('./plugin.js', import.meta.url).href;
const linkModulePath = new URL('./link.js', import.meta.url).href;
const eventsModulePath = new URL('./events.js', import.meta.url).href;
const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const userAgentPrefix = `QwenCode/${packageJson.version} `;

// Serialize all tests to prevent concurrent global stubbing of setTimeout /
// Math.random / fetch from leaking between tests.  Node's built-in runner
// executes test() callbacks concurrently by default and does not expose
// describe.serial, so we chain each test on the previous one's completion.
// A short macrotask settling delay is added between tests so fire-and-forget
// telemetry calls from the previous test can finish before the next test
// replaces globalThis.setTimeout.
let _serialChain = Promise.resolve();

function test(name, fn) {
  const prev = _serialChain;
  let done;
  _serialChain = new Promise(r => { done = r; });

  _nodeTest(name, async () => {
    await prev;
    try {
      return await fn();
    } finally {
      // Let pending fire-and-forget work (telemetry, etc.) settle before the
      // next test potentially stubs globals.  Using the real setTimeout here
      // is safe because the test's own finally block has already restored it.
      await new Promise(resolve => setTimeout(resolve, 50));
      done();
    }
  });
}

test('plugin registers provider and disables legacy providers', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  const pluginModule = await import(`${modulePath}?case=config-${Date.now()}`);
  assert.deepEqual(Object.keys(pluginModule), ['default']);

  const plugin = await pluginModule.default();

  const config = {
    disabled_providers: ['github-copilot'],
    provider: {
      qwen: { name: 'legacy qwen' },
      'qwen-code': { name: 'legacy qwen-code' },
    },
  };

  await plugin.config(config);

  assert.deepEqual(
    new Set(config.disabled_providers),
    new Set(['github-copilot', 'qwen', 'qwen-code']),
  );
  assert.ok(config.provider.openqwencode);
  assert.equal(config.provider.qwen, undefined);
  assert.equal(config.provider['qwen-code'], undefined);
  assert.equal(config.provider.openqwencode.models['coder-model'].attachment, true);
  assert.equal(config.provider.openqwencode.models['coder-model'].tool_call, true);
});

test('base URL env override takes precedence over the default and credential resource URL', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));
  process.env.OPENQWENCODE_BASE_URL = 'https://qwen.2631.eu';

  try {
    const pluginModule = await import(`${pluginModulePath}?case=base-url-override-${Date.now()}`);
    const plugin = await pluginModule.default();

    const config = { provider: {} };
    await plugin.config(config);
    assert.equal(config.provider.openqwencode.options.baseURL, 'https://qwen.2631.eu/v1');

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    assert.equal(loader.baseURL, 'https://qwen.2631.eu/v1');
  } finally {
    delete process.env.OPENQWENCODE_BASE_URL;
  }
});

test('loader bootstraps creds, persists them, and retries with refresh on 401', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = input instanceof Request ? input : new Request(input, init);
    const bodyText = request.body ? await request.text() : '';
    calls.push({
      url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      bodyText,
    });

    if (url === 'https://chat.qwen.ai/api/v1/oauth2/token') {
      return new Response(
        JSON.stringify({
          access_token: 'new-token',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          resource_url: 'https://portal.qwen.ai',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      const auth = request.headers.get('authorization');

      if (auth === 'Bearer initial-token') {
        return new Response('unauthorized', { status: 401 });
      }

      if (auth === 'Bearer new-token') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=loader-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    assert.ok(loader);
    assert.equal(loader.baseURL, 'https://portal.qwen.ai/v1');

    const credsPath = join(process.env.HOME, '.qwen', 'oauth_creds.json');
    const creds = JSON.parse(await readFile(credsPath, 'utf8'));
    assert.equal(creds.access_token, 'initial-token');
    assert.equal(creds.refresh_token, 'initial-refresh');

    const response = await loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    assert.equal(response.status, 200);

    const upstreamCalls = calls.filter(call => call.url === 'https://portal.qwen.ai/v1/chat/completions');
    assert.equal(upstreamCalls.length, 2);
    assert.equal(upstreamCalls[0].headers.authorization, 'Bearer initial-token');
    assert.equal(upstreamCalls[1].headers.authorization, 'Bearer new-token');
    assert.ok(upstreamCalls[1].headers['user-agent']?.startsWith(userAgentPrefix));
    assert.ok(upstreamCalls[1].headers['x-dashscope-useragent']?.startsWith(userAgentPrefix));

    const parsedBody = JSON.parse(upstreamCalls[1].bodyText);
    assert.equal(parsedBody.messages[0].role, 'system');
    assert.match(parsedBody.messages[0].content, /You are Qwen Code/);
    assert.equal(parsedBody.messages[1].role, 'user');
    assert.deepEqual(parsedBody.messages[1].content, [{ type: 'text', text: 'Hello' }]);
    assert.equal(parsedBody.metadata.channel, 'opencode');
    assert.equal(typeof parsedBody.metadata.promptId, 'string');
    assert.equal(typeof parsedBody.metadata.sessionId, 'string');
    assert.ok(parsedBody.metadata.promptId.length > 10);
    assert.ok(parsedBody.metadata.sessionId.length > 10);

    const refreshedCreds = JSON.parse(await readFile(credsPath, 'utf8'));
    assert.equal(refreshedCreds.access_token, 'new-token');
    assert.equal(refreshedCreds.refresh_token, 'new-refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent 401 retries share a single token refresh', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  const calls = [];
  let refreshCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = input instanceof Request ? input : new Request(input, init);
    const bodyText = request.body ? await request.text() : '';
    calls.push({
      url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      bodyText,
    });

    if (url === 'https://chat.qwen.ai/api/v1/oauth2/token') {
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 25));

      return new Response(
        JSON.stringify({
          access_token: 'shared-new-token',
          refresh_token: 'shared-new-refresh',
          token_type: 'Bearer',
          resource_url: 'https://portal.qwen.ai',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      const auth = request.headers.get('authorization');

      if (auth === 'Bearer initial-token') {
        return new Response('unauthorized', { status: 401 });
      }

      if (auth === 'Bearer shared-new-token') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=single-flight-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    const [firstResponse, secondResponse] = await Promise.all([
      loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello from first' }] }),
      }),
      loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello from second' }] }),
      }),
    ]);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(refreshCalls, 1);

    const upstreamCalls = calls.filter(call => call.url === 'https://portal.qwen.ai/v1/chat/completions');
    assert.equal(
      upstreamCalls.filter(call => call.headers.authorization === 'Bearer initial-token').length,
      2,
    );
    assert.equal(
      upstreamCalls.filter(call => call.headers.authorization === 'Bearer shared-new-token').length,
      2,
    );

    const credsPath = join(process.env.HOME, '.qwen', 'oauth_creds.json');
    const refreshedCreds = JSON.parse(await readFile(credsPath, 'utf8'));
    assert.equal(refreshedCreds.access_token, 'shared-new-token');
    assert.equal(refreshedCreds.refresh_token, 'shared-new-refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent authenticated requests are lightly throttled before reaching upstream', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  const requestTimestamps = [];
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;

  Math.random = () => 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      requestTimestamps.push(Date.now());
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=request-throttle-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    await Promise.all([
      loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'First request' }] }),
      }),
      loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Second request' }] }),
      }),
    ]);

    assert.equal(requestTimestamps.length, 2);
    assert.ok(requestTimestamps[1] - requestTimestamps[0] >= 290);
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test('failed refresh returns a readable 401 response body', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = input instanceof Request ? input : new Request(input, init);

    if (url === 'https://chat.qwen.ai/api/v1/oauth2/token') {
      return new Response(JSON.stringify({ error: 'invalid_request' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      if (request.headers.get('authorization') === 'Bearer initial-token') {
        return new Response('unauthorized', { status: 401 });
      }
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=refresh-failure-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    const response = await loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });

    assert.equal(response.status, 401);
    assert.equal(await response.text(), 'unauthorized');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rate-limited responses are converted into OpenAI-compatible JSON without debug noise by default', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));
  // The plugin reads this flag at import time, so clear it before loading the module.
  delete process.env.OPENQWENCODE_DEBUG;

  let requestCount = 0;
  let debugCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalDebug = console.debug;

  console.debug = () => {
    debugCalls += 1;
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = input instanceof Request ? input : new Request(input, init);

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      requestCount += 1;
      assert.equal(request.headers.get('authorization'), 'Bearer initial-token');

      return new Response('<html><body>Too Many Requests</body></html>', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'content-type': 'text/html',
          'retry-after': '7',
          'retry-after-ms': '1',
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=rate-limit-shape-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    const response = await loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });

    assert.equal(requestCount, 3);
    assert.equal(debugCalls, 0);
    assert.equal(response.status, 429);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/i);
    assert.equal(response.headers.get('retry-after'), '7');

    const payload = await response.json();
    assert.deepEqual(payload, {
      error: {
        message: 'Too Many Requests',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded',
      },
    });
  } finally {
    console.debug = originalDebug;
    globalThis.fetch = originalFetch;
  }
});

test('string chat content is normalized into text parts', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  let capturedRequestBody = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = input instanceof Request ? input : new Request(input, init);

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      capturedRequestBody = JSON.parse(request.body ? await request.text() : '{}');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=content-normalization-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    await loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Plain user text' },
          { role: 'assistant', content: 'Plain assistant text' },
          { role: 'tool', content: 'Tool output text' },
        ],
      }),
    });

    assert.ok(capturedRequestBody);
    assert.deepEqual(capturedRequestBody.messages[1].content, [{ type: 'text', text: 'Plain user text' }]);
    assert.deepEqual(capturedRequestBody.messages[2].content, [{ type: 'text', text: 'Plain assistant text' }]);
    assert.equal(capturedRequestBody.messages[3].content, 'Tool output text');
    assert.equal(typeof capturedRequestBody.metadata.sessionId, 'string');
    assert.ok(capturedRequestBody.metadata.sessionId.length > 10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('optional telemetry posts minimal request metadata to the configured endpoint', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));
  process.env.OPENQWENCODE_TELEMETRY_ENDPOINT = 'https://qwen.2631.eu/telemetry';

  const telemetryCalls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = input instanceof Request ? input : new Request(input, init);

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url === 'https://qwen.2631.eu/telemetry') {
      telemetryCalls.push({
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: JSON.parse(request.body ? await request.text() : '{}'),
      });
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=telemetry-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    const response = await loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello telemetry' }] }),
    });

    assert.equal(response.status, 200);

    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(telemetryCalls.length, 1);
    assert.equal(telemetryCalls[0].method, 'POST');
    assert.match(telemetryCalls[0].headers['content-type'] ?? '', /^application\/json/i);
    assert.equal(telemetryCalls[0].body.requestCount, 1);
    assert.equal(telemetryCalls[0].body.attempts, 1);
    assert.equal(telemetryCalls[0].body.status, 200);
    assert.equal(telemetryCalls[0].body.path, '/v1/chat/completions');
    assert.equal(typeof telemetryCalls[0].body.ts, 'string');
    assert.ok(!Number.isNaN(Date.parse(telemetryCalls[0].body.ts)));
    assert.equal(typeof telemetryCalls[0].body.durationMs, 'number');
    assert.ok(telemetryCalls[0].body.durationMs >= 0);
    assert.match(telemetryCalls[0].body.deviceCode, /^[a-f0-9]{12}$/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENQWENCODE_TELEMETRY_ENDPOINT;
  }
});

test('plugin internals remain available through subpath exports', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  const pluginModule = await import(`${pluginModulePath}?case=direct-plugin-${Date.now()}`);
  assert.equal(typeof pluginModule.default, 'function');
  assert.equal(typeof pluginModule.QwenAuthPlugin, 'function');

  const eventsModule = await import(`${eventsModulePath}?case=events-${Date.now()}`);
  assert.equal(typeof eventsModule.cancelActiveQwenAuth, 'function');
  assert.equal(typeof eventsModule.qwenAuthEvents.emit, 'function');
});

async function runRateLimitClassificationTest({
  caseName,
  responseFactory,
  expectedStatus,
  expectedCode,
  expectedType,
  expectedCategory,
  expectedBackoffDelays,
  expectedMessagePattern,
}) {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));
  process.env.OPENQWENCODE_DEBUG = '1';

  let requestCount = 0;
  const scheduledSleeps = [];
  const debugMessages = [];
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalRandom = Math.random;
  const originalDebug = console.debug;

  Math.random = () => 0;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    scheduledSleeps.push(delay);
    queueMicrotask(() => callback(...args));
    // Return a timer-like object so AbortSignal.timeout().unref() does not
    // throw when the real setTimeout has been replaced by this stub.
    return { unref() {}, ref() { return this; } };
  };
  globalThis.clearTimeout = () => {};
  console.debug = msg => {
    if (typeof msg === 'string') debugMessages.push(msg);
  };

  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url;

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      requestCount += 1;
      return responseFactory();
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=${caseName}-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    const response = await loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });

    assert.equal(requestCount, 3);
    assert.equal(response.status, expectedStatus);

    const payload = await response.json();
    assert.equal(payload.error.code, expectedCode);
    assert.equal(payload.error.type, expectedType);
    if (expectedMessagePattern) {
      assert.match(
        payload.error.message,
        expectedMessagePattern,
        `Expected ${String(expectedMessagePattern)}, got: ${payload.error.message}`,
      );
    }

    const minimumExpectedBackoffDelay = Math.min(...expectedBackoffDelays);
    const backoffDelays = scheduledSleeps.filter(delay => delay >= minimumExpectedBackoffDelay);
    assert.deepEqual(backoffDelays, expectedBackoffDelays);
    assert.ok(debugMessages.some(message => message.includes(`[${expectedCategory}]`)));
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    console.debug = originalDebug;
    delete process.env.OPENQWENCODE_DEBUG;
  }
}

test('burst rate limit (429 with no x-error-code) uses short backoff and returns rate_limit_exceeded', async () => {
  await runRateLimitClassificationTest({
    caseName: 'burst-429',
    responseFactory: () =>
      new Response(JSON.stringify({ message: 'Too Many Requests' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'application/json' },
      }),
    expectedStatus: 429,
    expectedCode: 'rate_limit_exceeded',
    expectedType: 'rate_limit_error',
    expectedCategory: 'burst',
    expectedBackoffDelays: [2000, 4000],
  });
});

test('quota exhaustion (429 with x-error-code containing "quota") uses longer backoff and returns quota_exceeded', async () => {
  await runRateLimitClassificationTest({
    caseName: 'quota-429',
    responseFactory: () =>
      new Response(JSON.stringify({ message: 'Quota limit exceeded' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'content-type': 'application/json',
          'x-error-code': 'QuotaExhausted',
        },
      }),
    expectedStatus: 429,
    expectedCode: 'quota_exceeded',
    expectedType: 'rate_limit_error',
    expectedCategory: 'quota',
    expectedBackoffDelays: [10000, 20000],
    expectedMessagePattern: /quota/i,
  });
});

test('transient server error (500) uses moderate backoff and returns server_error', async () => {
  await runRateLimitClassificationTest({
    caseName: 'transient-500',
    responseFactory: () =>
      new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    expectedStatus: 500,
    expectedCode: 'upstream_500',
    expectedType: 'server_error',
    expectedCategory: 'transient',
    expectedBackoffDelays: [3000, 6000],
  });
});

test('429 with x-error-code containing "gateway" is classified as transient', async () => {
  await runRateLimitClassificationTest({
    caseName: 'gateway-429',
    responseFactory: () =>
      new Response(JSON.stringify({ message: 'Gateway timeout' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'content-type': 'application/json',
          'x-error-code': 'GatewayTimeout',
        },
      }),
    expectedStatus: 429,
    expectedCode: 'rate_limit_exceeded',
    expectedType: 'rate_limit_error',
    expectedCategory: 'transient',
    expectedBackoffDelays: [3000, 6000],
  });
});

test('linkDevice requests a short code, polls until approved, and persists telemetry credentials', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));
  process.env.OPENQWENCODE_TELEMETRY_ENDPOINT = 'https://qwen.2631.eu/telemetry';

  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSpawn = child_process.spawn;

  child_process.spawn = function stubbedSpawn() {
    return { unref() {} };
  };

  const scheduledDelays = [];
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    scheduledDelays.push(delay);
    queueMicrotask(() => callback(...args));
    return { unref() {}, ref() { return this; } };
  };
  globalThis.clearTimeout = () => {};

  let pollCount = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url === 'https://qwen.2631.eu/device-link/request') {
      return new Response(
        JSON.stringify({
          pollToken: 'poll-token-123',
          linkCode: 'AX7K2M',
          expiresIn: 900,
          pollIntervalMs: 5000,
          verificationUrl: 'https://qwen.2631.eu/link',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url === 'https://qwen.2631.eu/device-link/poll') {
      pollCount += 1;
      if (pollCount === 1) {
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ status: 'approved', linkToken: 'telemetry-link-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const linkModule = await import(`${linkModulePath}?case=link-device-${Date.now()}`);
    const logs = [];
    const result = await linkModule.linkDevice({ log: message => logs.push(message) });

    assert.equal(result.status, 'approved');
    assert.equal(result.linkCode, 'AX7K2M');
    assert.equal(result.linkToken, 'telemetry-link-token');
    assert.equal(pollCount, 2);
    assert.ok(logs.some(message => message.includes('AX7K2M')));
    assert.ok(logs.some(message => message.includes('Device linked successfully')));

    const telemetryCredsPath = join(process.env.HOME, '.qwen', 'telemetry_creds.json');
    const telemetryCreds = JSON.parse(await readFile(telemetryCredsPath, 'utf8'));
    assert.equal(telemetryCreds.link_token, 'telemetry-link-token');
    assert.equal(typeof telemetryCreds.device_code, 'string');
    assert.equal(telemetryCreds.verification_url, 'https://qwen.2631.eu/link');
    assert.deepEqual(scheduledDelays, [5000]);
  } finally {
    delete process.env.OPENQWENCODE_TELEMETRY_ENDPOINT;
    child_process.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('telemetry events include the stored bearer token when a device link exists', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));
  process.env.OPENQWENCODE_TELEMETRY_ENDPOINT = 'https://qwen.2631.eu/telemetry';

  const qwenDir = join(process.env.HOME, '.qwen');
  await mkdir(qwenDir, { recursive: true });
  await writeFile(
    join(qwenDir, 'telemetry_creds.json'),
    JSON.stringify({
      link_token: 'telemetry-link-token',
      linked_at: Date.now(),
      device_code: 'linked-device-123',
    }),
  );

  const originalFetch = globalThis.fetch;
  let telemetryAuthorization = null;
  let resolveTelemetryDelivery;
  const telemetryDelivered = new Promise(resolve => {
    resolveTelemetryDelivery = resolve;
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const request = input instanceof Request ? input : new Request(input, init);

    if (url === 'https://portal.qwen.ai/v1/chat/completions') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url === 'https://qwen.2631.eu/telemetry') {
      telemetryAuthorization = request.headers.get('authorization');
      resolveTelemetryDelivery();
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=telemetry-bearer-${Date.now()}`);
    const plugin = await pluginModule.default();

    const authState = {
      type: 'oauth',
      access: 'initial-token',
      refresh: 'initial-refresh',
      expires: Date.now() + 5 * 60_000,
      accountId: 'https://portal.qwen.ai',
    };

    const loader = await plugin.auth.loader(async () => authState, {
      models: { 'coder-model': { cost: { input: 1, output: 1 } } },
    });

    const response = await loader.fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });

    assert.equal(response.status, 200);
    await telemetryDelivered;
    assert.equal(telemetryAuthorization, 'Bearer telemetry-link-token');
  } finally {
    delete process.env.OPENQWENCODE_TELEMETRY_ENDPOINT;
    globalThis.fetch = originalFetch;
  }
});

test('device flow authorizes, polls through pending and slow_down, then succeeds and persists credentials', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));
  process.env.OPENQWENCODE_DEBUG = '1';

  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalRandom = Math.random;
  const originalDebug = console.debug;
  const originalSpawn = child_process.spawn;

  // Stub spawn to prevent a browser tab from opening during the test
  child_process.spawn = function stubbedSpawn() {
    return { unref() {} };
  };

  // Stub timers so the test runs without real delays while recording scheduled waits
  const scheduledDelays = [];
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    scheduledDelays.push(delay);
    queueMicrotask(() => callback(...args));
    return { unref() {}, ref() { return this; } };
  };
  globalThis.clearTimeout = () => {};

  // Deterministic jitter for any backoff calculations
  Math.random = () => 0;

  const debugMessages = [];
  console.debug = msg => {
    if (typeof msg === 'string') debugMessages.push(msg);
  };

  // Drive the token polling state machine through three distinct phases
  let tokenPollCount = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    // Device authorization request
    if (url === 'https://chat.qwen.ai/api/v1/oauth2/device/code') {
      return new Response(
        JSON.stringify({
          device_code: 'test-device-code-abc',
          user_code: 'WXYZ-5678',
          verification_uri: 'https://chat.qwen.ai/device',
          verification_uri_complete: 'https://chat.qwen.ai/device?code=WXYZ-5678',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Token polling endpoint
    if (url === 'https://chat.qwen.ai/api/v1/oauth2/token') {
      tokenPollCount += 1;

      // First poll: authorization_pending
      if (tokenPollCount === 1) {
        return new Response(
          JSON.stringify({ error: 'authorization_pending' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }

      // Second poll: slow_down
      if (tokenPollCount === 2) {
        return new Response(
          JSON.stringify({ error: 'slow_down' }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }

      // Third poll: success with tokens
      return new Response(
        JSON.stringify({
          access_token: 'device-flow-access-token',
          refresh_token: 'device-flow-refresh-token',
          token_type: 'Bearer',
          resource_url: 'https://portal.qwen.ai',
          expires_in: 3600,
          scope: 'openid profile email model.completion',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const pluginModule = await import(`${pluginModulePath}?case=device-flow-${Date.now()}`);
    const plugin = await pluginModule.default();

    // Capture auth events from the fresh module instance
    const events = pluginModule.qwenAuthEvents;
    const emittedEvents = [];
    const eventTypes = [
      'auth-browser-opened',
      'auth-started',
      'auth-pending',
      'auth-slow-down',
      'auth-succeeded',
    ];
    for (const type of eventTypes) {
      events.on(type, data => emittedEvents.push({ type, data }));
    }

    // Step 1: Start device authorization
    const authorizeResult = await plugin.auth.methods[0].authorize();

    // Verify authorize returned the expected structure
    assert.ok(authorizeResult.url);
    assert.ok(authorizeResult.instructions.includes('WXYZ-5678'));
    assert.equal(authorizeResult.method, 'auto');
    assert.equal(typeof authorizeResult.callback, 'function');

    // Verify auth-browser-opened was emitted with user code
    const browserEvent = emittedEvents.find(e => e.type === 'auth-browser-opened');
    assert.ok(browserEvent);
    assert.equal(browserEvent.data.userCode, 'WXYZ-5678');

    // Step 2: Drive the polling callback through pending → slow_down → success
    const callbackResult = await authorizeResult.callback();

    // Verify callback returned success
    assert.equal(callbackResult.type, 'success');
    assert.equal(callbackResult.access, 'device-flow-access-token');
    assert.equal(callbackResult.refresh, 'device-flow-refresh-token');
    assert.ok(callbackResult.expires > Date.now());
    assert.equal(callbackResult.accountId, 'https://portal.qwen.ai');

    // Verify three token polls occurred in sequence
    assert.equal(tokenPollCount, 3);

    // Step 3: Verify credentials persisted to disk
    const credsPath = join(process.env.HOME, '.qwen', 'oauth_creds.json');
    const creds = JSON.parse(await readFile(credsPath, 'utf8'));
    assert.equal(creds.access_token, 'device-flow-access-token');
    assert.equal(creds.refresh_token, 'device-flow-refresh-token');
    assert.equal(creds.resource_url, 'https://portal.qwen.ai');
    assert.ok(creds.expiry_date > Date.now());

    // Step 4: Verify event emission sequence
    const typeSequence = emittedEvents.map(e => e.type);
    assert.ok(typeSequence.includes('auth-browser-opened'));
    assert.ok(typeSequence.includes('auth-started'));

    // auth-pending fires before each poll attempt
    const pendingCount = typeSequence.filter(t => t === 'auth-pending').length;
    assert.equal(pendingCount, 3);

    // slow_down event fires once and reports an increased interval
    const slowDownEvents = emittedEvents.filter(e => e.type === 'auth-slow-down');
    assert.equal(slowDownEvents.length, 1);
    assert.ok(
      slowDownEvents[0].data.nextPollInMs >= 10_000,
      `slow_down should increase interval to at least 10s, got ${slowDownEvents[0].data.nextPollInMs}ms`,
    );

    // succeeded event fires once with resource info
    const succeededEvents = emittedEvents.filter(e => e.type === 'auth-succeeded');
    assert.equal(succeededEvents.length, 1);
    assert.equal(succeededEvents[0].data.resourceUrl, 'https://portal.qwen.ai');

    // Verify events occurred in the correct order
    const browserIdx = typeSequence.indexOf('auth-browser-opened');
    const startedIdx = typeSequence.indexOf('auth-started');
    const firstPendingIdx = typeSequence.indexOf('auth-pending');
    const slowDownIdx = typeSequence.indexOf('auth-slow-down');
    const succeededIdx = typeSequence.indexOf('auth-succeeded');
    assert.ok(browserIdx < startedIdx, 'browser-opened before started');
    assert.ok(startedIdx < firstPendingIdx, 'started before first pending');
    assert.ok(firstPendingIdx < slowDownIdx, 'first pending before slow_down');
    assert.ok(slowDownIdx < succeededIdx, 'slow_down before succeeded');

    // Verify that sleep delays reflect the expected polling intervals
    // First two sleeps: interval(5s) + margin(3s) = 8s each
    // Third sleep: increased interval(10s) + margin(3s) = 13s
    const pollSleeps = scheduledDelays.filter(d => d >= 8000);
    assert.equal(pollSleeps.length, 3);
    assert.equal(pollSleeps[0], 8000);
    assert.equal(pollSleeps[1], 8000);
    assert.equal(pollSleeps[2], 13000);
  } finally {
    child_process.spawn = originalSpawn;
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    console.debug = originalDebug;
    delete process.env.OPENQWENCODE_DEBUG;
  }
});

