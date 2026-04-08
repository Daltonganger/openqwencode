import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const modulePath = new URL('./index.js', import.meta.url).href;
const pluginModulePath = new URL('./plugin.js', import.meta.url).href;
const eventsModulePath = new URL('./events.js', import.meta.url).href;

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
    assert.match(upstreamCalls[1].headers['x-dashscope-useragent'], /^OpenQwenCode\/0\.1\.3 /);

    const parsedBody = JSON.parse(upstreamCalls[1].bodyText);
    assert.equal(parsedBody.messages[0].role, 'system');
    assert.match(parsedBody.messages[0].content, /You are Qwen Code/);
    assert.equal(parsedBody.messages[1].role, 'user');

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

test('plugin internals remain available through subpath exports', async () => {
  process.env.HOME = await mkdtemp(join(tmpdir(), 'openqwencode-home-'));

  const pluginModule = await import(`${pluginModulePath}?case=direct-plugin-${Date.now()}`);
  assert.equal(typeof pluginModule.default, 'function');
  assert.equal(typeof pluginModule.QwenAuthPlugin, 'function');

  const eventsModule = await import(`${eventsModulePath}?case=events-${Date.now()}`);
  assert.equal(typeof eventsModule.cancelActiveQwenAuth, 'function');
  assert.equal(typeof eventsModule.qwenAuthEvents.emit, 'function');
});
