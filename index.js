/**
 * OpenQwenCode plugin
 *
 * - uses the qwen.ai OAuth device flow
 * - persists and refreshes tokens in qwen-code compatible format
 * - keeps local credentials as the single source of truth
 * - syncs safely across processes with a lockfile + atomic writes
 * - exposes only the single upstream-supported free model: coder-model
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROVIDER_ID = 'openqwencode';
const PROVIDER_NAME = 'OpenQwenCode';
const MODEL_ID = 'coder-model';
const CREDS_DIR = join(homedir(), '.qwen');
const CREDS_PATH = join(CREDS_DIR, 'oauth_creds.json');
const LOCK_PATH = join(CREDS_DIR, 'oauth_creds.lock');
const DEFAULT_BASE_URL = 'https://portal.qwen.ai/v1';
const LEGACY_PROVIDER_IDS = ['qwen', 'qwen-code'];
const CREDS_DIR_MODE = 0o700;
const CREDS_FILE_MODE = 0o600;
const REFRESH_BUFFER_MS = 60_000;
const CACHE_RELOAD_INTERVAL_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_INTERVAL_MS = 100;
const LOCK_MAX_RETRY_INTERVAL_MS = 1_000;
const DEVICE_POLL_MARGIN_MS = 3_000;
const DEVICE_POLL_MAX_INTERVAL_MS = 15_000;
const REFRESH_MAX_ATTEMPTS = 3;
const REQUEST_MAX_ATTEMPTS = 3;
const SYSTEM_MESSAGE =
  'You are Qwen Code, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks. Your primary goal is to help users safely and efficiently, adhering strictly to the following instructions and utilizing your available tools.';

const QWEN_OAUTH_CONFIG = {
  baseUrl: 'https://chat.qwen.ai',
  deviceCodeEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
  tokenEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/token',
  clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
  scope: 'openid profile email model.completion',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
};

const QWEN_MODELS = {
  [MODEL_ID]: {
    id: MODEL_ID,
    name: 'Qwen Coder',
    contextWindow: 1048576,
    maxOutput: 65536,
    description:
      'Official free Qwen Code OAuth model. Supports coding and image input through the same coder-model alias.',
    reasoning: false,
    cost: { input: 0, output: 0 },
  },
};

let credentialCache = null;
let credentialCacheMtimeMs = 0;
let credentialCacheCheckedAt = 0;
let authBootstrapConsumed = false;
let activeAuthSession = null;

export const qwenAuthEvents = new EventEmitter();

class SlowDownError extends Error {
  constructor(retryAfterMs = null) {
    super('slow_down');
    this.name = 'SlowDownError';
    this.retryAfterMs = retryAfterMs;
  }
}

class RetryableHttpError extends Error {
  constructor(message, status, retryAfterMs = null) {
    super(message);
    this.name = 'RetryableHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function debugLog(message, error) {
  const detail = error instanceof Error ? error.message : error ? String(error) : '';
  console.debug(`[openqwencode] ${message}${detail ? `: ${detail}` : ''}`);
}

function createAbortError(message = 'Operation aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : createAbortError(typeof signal.reason === 'string' ? signal.reason : 'Operation aborted');
}

async function sleep(ms, signal) {
  if (!ms || ms <= 0) return;
  throwIfAborted(signal);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : createAbortError(typeof signal.reason === 'string' ? signal.reason : 'Operation aborted'),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    debugLog('Failed to parse JSON payload', error);
    return {};
  }
}

function parseRetryAfterMs(headers) {
  const retryAfterMsHeader = headers?.get?.('retry-after-ms');
  const retryAfterMs = Number(retryAfterMsHeader);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;

  const retryAfterHeader = headers?.get?.('retry-after');
  if (!retryAfterHeader) return null;

  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAfterDate)) return null;

  return Math.max(retryAfterDate - Date.now(), 0);
}

function getBackoffMs({ attempt = 0, retryAfterMs = null, baseMs = 1000, maxMs = 30_000 } = {}) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

function base64urlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function resolveBaseURL(resourceUrl) {
  if (!resourceUrl || typeof resourceUrl !== 'string') return DEFAULT_BASE_URL;

  const normalized = resourceUrl.startsWith('http') ? resourceUrl : `https://${resourceUrl}`;
  return normalized.endsWith('/v1') ? normalized : `${normalized.replace(/\/+$/, '')}/v1`;
}

function normalizeVerificationUrl(candidate) {
  if (typeof candidate === 'string' && candidate.trim()) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {
      // fall through
    }
  }

  return QWEN_OAUTH_CONFIG.baseUrl;
}

function openBrowser(url) {
  try {
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'rundll32'
          : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref?.();
  } catch {
    // ignore browser open failures
  }
}

function toFormBody(payload) {
  const entries = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)]);

  return new URLSearchParams(entries).toString();
}

function normalizeCredentials(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const accessToken = raw.access_token ?? raw.accessToken;
  const refreshToken = raw.refresh_token ?? raw.refreshToken;
  const resourceUrl = raw.resource_url ?? raw.resourceUrl;
  const tokenType = raw.token_type ?? raw.tokenType ?? 'Bearer';
  const expiryDateRaw = raw.expiry_date ?? raw.expiryDate;
  const expiryDate =
    typeof expiryDateRaw === 'number' ? expiryDateRaw : expiryDateRaw ? Number(expiryDateRaw) : undefined;

  if (
    (!accessToken || typeof accessToken !== 'string') &&
    (!refreshToken || typeof refreshToken !== 'string')
  ) {
    return null;
  }

  return {
    accessToken: typeof accessToken === 'string' && accessToken ? accessToken : undefined,
    tokenType: typeof tokenType === 'string' && tokenType ? tokenType : 'Bearer',
    refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : undefined,
    resourceUrl: typeof resourceUrl === 'string' && resourceUrl ? resourceUrl : undefined,
    expiryDate: Number.isFinite(expiryDate) ? expiryDate : undefined,
    scope: typeof raw.scope === 'string' && raw.scope ? raw.scope : undefined,
  };
}

function serializeCredentials(creds) {
  return JSON.stringify(
    {
      access_token: creds.accessToken,
      token_type: creds.tokenType ?? 'Bearer',
      refresh_token: creds.refreshToken,
      resource_url: creds.resourceUrl,
      expiry_date: creds.expiryDate,
      scope: creds.scope,
    },
    null,
    2,
  );
}

function updateCredentialCache(creds, mtimeMs = Date.now()) {
  credentialCache = creds ? { ...creds } : null;
  credentialCacheMtimeMs = creds ? mtimeMs : 0;
  credentialCacheCheckedAt = Date.now();
}

function isCredentialFresh(creds) {
  return Boolean(creds?.accessToken) &&
    (typeof creds.expiryDate !== 'number' || Date.now() <= creds.expiryDate - REFRESH_BUFFER_MS);
}

async function ensureCredentialsDir() {
  await mkdir(CREDS_DIR, { recursive: true, mode: CREDS_DIR_MODE });
}

async function maybeClearStaleLock() {
  try {
    const info = await stat(LOCK_PATH);
    if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return;
    await rm(LOCK_PATH, { force: true });
    debugLog('Removed stale credential lock');
  } catch {
    // ignore lock cleanup failures
  }
}

async function acquireCredentialLock(signal) {
  await ensureCredentialsDir();

  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    throwIfAborted(signal);

    try {
      const handle = await open(LOCK_PATH, 'wx', CREDS_FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } finally {
        try {
          await handle.close();
        } catch {
          // ignore close failures
        }
      }

      return async () => {
        try {
          await rm(LOCK_PATH, { force: true });
        } catch {
          // ignore lock cleanup failures
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await maybeClearStaleLock();
      await sleep(
        getBackoffMs({
          attempt,
          baseMs: LOCK_RETRY_INTERVAL_MS,
          maxMs: LOCK_MAX_RETRY_INTERVAL_MS,
        }),
        signal,
      );
      attempt += 1;
    }
  }

  throw new Error('Timed out acquiring credential lock');
}

async function withCredentialLock(fn, signal) {
  const release = await acquireCredentialLock(signal);

  try {
    return await fn();
  } finally {
    await release();
  }
}

async function loadCredentialsFromDisk({ force = false } = {}) {
  const now = Date.now();
  if (credentialCache && !force && now - credentialCacheCheckedAt < CACHE_RELOAD_INTERVAL_MS) {
    return credentialCache;
  }

  try {
    const info = await stat(CREDS_PATH);

    if (credentialCache && !force && credentialCacheMtimeMs === info.mtimeMs) {
      credentialCacheCheckedAt = now;
      return credentialCache;
    }

    const raw = parseJson(await readFile(CREDS_PATH, 'utf-8'));
    const creds = normalizeCredentials(raw);
    updateCredentialCache(creds, info.mtimeMs);
    return creds;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      debugLog('Failed to read credential file', error);
    }
    updateCredentialCache(null);
    return null;
  }
}

async function persistCredentialsUnlocked(creds) {
  const normalized = normalizeCredentials(creds);
  if (!normalized?.accessToken && !normalized?.refreshToken) {
    throw new Error('Cannot persist empty credentials');
  }

  await ensureCredentialsDir();

  const tempPath = `${CREDS_PATH}.tmp.${randomUUID()}`;
  const payload = serializeCredentials(normalized);

  try {
    await writeFile(tempPath, payload, { encoding: 'utf-8', mode: CREDS_FILE_MODE });
    await rename(tempPath, CREDS_PATH);
    const info = await stat(CREDS_PATH).catch(() => null);
    updateCredentialCache(normalized, info?.mtimeMs ?? Date.now());
    return normalized;
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

async function saveCredentials(creds) {
  return withCredentialLock(() => persistCredentialsUnlocked(creds));
}

async function getStoredAuth(getAuth) {
  if (authBootstrapConsumed) return null;

  try {
    return await getAuth();
  } catch (error) {
    debugLog('Failed to read OpenCode auth bootstrap state', error);
    return null;
  }
}

async function bootstrapCredentialsFromAuth(getAuth, signal) {
  if (authBootstrapConsumed) return null;

  const auth = await getStoredAuth(getAuth);
  authBootstrapConsumed = true;

  if (!auth || auth.type !== 'oauth') return null;

  const bootstrapped = normalizeCredentials({
    accessToken: auth.access,
    refreshToken: auth.refresh,
    expiryDate: auth.expires,
    resourceUrl: auth.accountId,
  });

  if (!bootstrapped) return null;

  return withCredentialLock(async () => {
    const latest = await loadCredentialsFromDisk({ force: true });
    if (latest) return latest;

    if (isCredentialFresh(bootstrapped)) {
      return persistCredentialsUnlocked(bootstrapped);
    }

    if (!bootstrapped.refreshToken) {
      return bootstrapped.accessToken ? persistCredentialsUnlocked(bootstrapped) : null;
    }

    try {
      const refreshed = await refreshAccessTokenWithRetry(
        bootstrapped.refreshToken,
        bootstrapped.resourceUrl,
        signal,
      );
      return persistCredentialsUnlocked(refreshed);
    } catch (error) {
      debugLog('Failed to bootstrap credentials from OpenCode auth', error);
      if (bootstrapped.accessToken) {
        return persistCredentialsUnlocked(bootstrapped);
      }
      return null;
    }
  }, signal);
}

async function requestDeviceAuthorization(challenge, signal) {
  throwIfAborted(signal);

  const response = await fetch(QWEN_OAUTH_CONFIG.deviceCodeEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'x-request-id': randomUUID(),
    },
    body: toFormBody({
      client_id: QWEN_OAUTH_CONFIG.clientId,
      scope: QWEN_OAUTH_CONFIG.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
    signal,
  });

  const text = await response.text();
  const retryAfterMs = parseRetryAfterMs(response.headers);

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableHttpError(
        `Device authorization failed with status ${response.status}`,
        response.status,
        retryAfterMs,
      );
    }

    throw new Error(`Device authorization failed: ${response.status} ${text}`);
  }

  return parseJson(text);
}

async function requestDeviceAuthorizationWithRetry(challenge, signal) {
  let lastError = null;

  for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestDeviceAuthorization(challenge, signal);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RetryableHttpError)) throw error;

      const delayMs = getBackoffMs({
        attempt,
        retryAfterMs: error.retryAfterMs,
        baseMs: 2000,
        maxMs: 30_000,
      });
      debugLog(`Device authorization throttled; retrying in ${delayMs}ms`, error);
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

async function pollDeviceToken(deviceCode, verifier, signal) {
  throwIfAborted(signal);

  const response = await fetch(QWEN_OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: toFormBody({
      client_id: QWEN_OAUTH_CONFIG.clientId,
      device_code: deviceCode,
      grant_type: QWEN_OAUTH_CONFIG.grantType,
      code_verifier: verifier,
    }),
    signal,
  });

  const text = await response.text();
  const data = parseJson(text);
  const retryAfterMs = parseRetryAfterMs(response.headers);

  if (!response.ok) {
    if (response.status === 400 && data.error === 'authorization_pending') {
      return null;
    }

    if (response.status === 429 || data.error === 'slow_down') {
      throw new SlowDownError(retryAfterMs);
    }

    if (response.status >= 500) {
      throw new RetryableHttpError(
        `Token polling failed with status ${response.status}`,
        response.status,
        retryAfterMs,
      );
    }

    throw new Error(`Token polling failed: ${data.error ?? response.status}`);
  }

  return normalizeCredentials({
    accessToken: data.access_token,
    tokenType: data.token_type,
    refreshToken: data.refresh_token,
    expiryDate: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
    resourceUrl: data.resource_url,
    scope: data.scope,
  });
}

async function refreshAccessToken(refreshToken, resourceUrl, signal) {
  throwIfAborted(signal);

  const response = await fetch(QWEN_OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: toFormBody({
      client_id: QWEN_OAUTH_CONFIG.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal,
  });

  const text = await response.text();
  const data = parseJson(text);
  const retryAfterMs = parseRetryAfterMs(response.headers);

  if (!response.ok || !data.access_token) {
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableHttpError(
        `Token refresh failed with status ${response.status}`,
        response.status,
        retryAfterMs,
      );
    }

    throw new Error(`Token refresh failed: ${data.error ?? response.status}`);
  }

  return normalizeCredentials({
    accessToken: data.access_token,
    tokenType: data.token_type,
    refreshToken: data.refresh_token ?? refreshToken,
    expiryDate: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
    resourceUrl: data.resource_url ?? resourceUrl,
    scope: data.scope,
  });
}

async function refreshAccessTokenWithRetry(refreshToken, resourceUrl, signal) {
  let lastError = null;

  for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await refreshAccessToken(refreshToken, resourceUrl, signal);
    } catch (error) {
      lastError = error;
      if (!(error instanceof RetryableHttpError)) throw error;

      const delayMs = getBackoffMs({
        attempt,
        retryAfterMs: error.retryAfterMs,
        baseMs: 2000,
        maxMs: 30_000,
      });
      debugLog(`Token refresh throttled; retrying in ${delayMs}ms`, error);
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

async function getValidCredentials(getAuth, { forceRefresh = false, signal } = {}) {
  let creds = await loadCredentialsFromDisk();
  if (!creds) {
    creds = await bootstrapCredentialsFromAuth(getAuth, signal);
  }

  if (!creds) return null;
  if (!forceRefresh && isCredentialFresh(creds)) return creds;

  if (!creds.refreshToken) {
    return !forceRefresh && creds.accessToken ? creds : null;
  }

  return withCredentialLock(async () => {
    let latest = await loadCredentialsFromDisk({ force: true });
    if (!latest) latest = creds;

    if (!forceRefresh && isCredentialFresh(latest)) {
      return latest;
    }

    if (!latest.refreshToken) {
      return !forceRefresh && latest.accessToken ? latest : null;
    }

    try {
      const refreshed = await refreshAccessTokenWithRetry(latest.refreshToken, latest.resourceUrl, signal);
      return await persistCredentialsUnlocked(refreshed);
    } catch (error) {
      debugLog('Token refresh failed', error);
      if (!forceRefresh && latest.accessToken) return latest;
      return null;
    }
  }, signal);
}

function decodeBody(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return null;
}

function transformRequestBody(body) {
  if (!body) return body;

  try {
    const raw = decodeBody(body);
    if (!raw) return body;

    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    if (messages.some(message => message?.role === 'system')) return raw;

    parsed.messages = [{ role: 'system', content: SYSTEM_MESSAGE }, ...messages];
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function prepareRequestBody(body) {
  const transformed = transformRequestBody(body);
  const replayable =
    transformed == null ||
    typeof transformed === 'string' ||
    transformed instanceof Uint8Array ||
    transformed instanceof ArrayBuffer ||
    ArrayBuffer.isView(transformed);

  return { body: transformed, replayable };
}

function buildHeaders(token, initHeaders) {
  const headers = new Headers(initHeaders);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-DashScope-AuthType', 'qwen-oauth');
  headers.set('X-DashScope-CacheControl', 'enable');
  headers.set('X-DashScope-UserAgent', `OpenQwenCode/0.1.0 (${process.platform}; ${process.arch})`);
  return headers;
}

async function performAuthenticatedFetch(input, init, token, body) {
  return globalThis.fetch(
    new Request(input, {
      ...init,
      headers: buildHeaders(token, init?.headers),
      body,
    }),
  );
}

function shouldBackoffResponse(response) {
  return response.status === 429 || response.status >= 500;
}

function createAuthSession() {
  if (activeAuthSession?.controller && !activeAuthSession.controller.signal.aborted) {
    activeAuthSession.controller.abort(createAbortError('Superseded by a new auth session'));
  }

  const controller = new AbortController();
  const cancel = reason => {
    if (!controller.signal.aborted) {
      controller.abort(createAbortError(reason));
    }
  };

  const onProcessSignal = () => cancel('Authentication cancelled by process signal');
  process.once('SIGINT', onProcessSignal);
  process.once('SIGTERM', onProcessSignal);

  activeAuthSession = { controller };

  return {
    signal: controller.signal,
    cancel,
    cleanup() {
      process.removeListener('SIGINT', onProcessSignal);
      process.removeListener('SIGTERM', onProcessSignal);
      if (activeAuthSession?.controller === controller) {
        activeAuthSession = null;
      }
    },
  };
}

export function cancelActiveQwenAuth(reason = 'Authentication cancelled manually') {
  if (!activeAuthSession?.controller || activeAuthSession.controller.signal.aborted) return;
  activeAuthSession.controller.abort(createAbortError(reason));
}

function buildFetchWithAuth(getAuth) {
  return async (input, init) => {
    const signal = init?.signal;
    const requestBody = prepareRequestBody(init?.body);

    let credentials = await getValidCredentials(getAuth, { signal });
    if (!credentials?.accessToken) {
      return globalThis.fetch(input, init);
    }

    let lastResponse = null;

    for (let attempt = 0; attempt < REQUEST_MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);

      const response = await performAuthenticatedFetch(input, init, credentials.accessToken, requestBody.body);
      lastResponse = response;

      if ((response.status === 401 || response.status === 403) && requestBody.replayable) {
        if (attempt === REQUEST_MAX_ATTEMPTS - 1) return response;

        await response.body?.cancel?.().catch?.(() => {});

        const refreshed = await getValidCredentials(getAuth, { forceRefresh: true, signal });
        if (!refreshed?.accessToken || refreshed.accessToken === credentials.accessToken) {
          return response;
        }

        debugLog('Received auth error from upstream; retrying with refreshed token');
        credentials = refreshed;
        continue;
      }

      if (shouldBackoffResponse(response) && requestBody.replayable && attempt < REQUEST_MAX_ATTEMPTS - 1) {
        await response.body?.cancel?.().catch?.(() => {});

        const delayMs = getBackoffMs({
          attempt,
          retryAfterMs: parseRetryAfterMs(response.headers),
          baseMs: 1_000,
          maxMs: 20_000,
        });
        debugLog(`Upstream returned ${response.status}; retrying in ${delayMs}ms`);
        await sleep(delayMs, signal);
        continue;
      }

      return response;
    }

    return lastResponse ?? globalThis.fetch(input, init);
  };
}

function registerProvider(config) {
  const providers = config.provider ?? {};

  for (const id of LEGACY_PROVIDER_IDS) {
    delete providers[id];
  }

  providers[PROVIDER_ID] = {
    npm: '@ai-sdk/openai-compatible',
    name: PROVIDER_NAME,
    options: {
      apiKey: 'oauth',
      baseURL: DEFAULT_BASE_URL,
    },
    models: {
      [MODEL_ID]: {
        id: MODEL_ID,
        name: QWEN_MODELS[MODEL_ID].name,
        description: QWEN_MODELS[MODEL_ID].description,
        reasoning: QWEN_MODELS[MODEL_ID].reasoning,
        cost: QWEN_MODELS[MODEL_ID].cost,
        tool_call: true,
        attachment: true,
        limit: {
          context: QWEN_MODELS[MODEL_ID].contextWindow,
          output: QWEN_MODELS[MODEL_ID].maxOutput,
        },
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
      },
    },
  };

  config.provider = providers;
}

function disableLegacyProviders(config) {
  const disabled = new Set(config.disabled_providers ?? []);
  for (const id of LEGACY_PROVIDER_IDS) disabled.add(id);
  config.disabled_providers = [...disabled];
}

export const QwenAuthPlugin = async () => {
  return {
    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth, provider) => {
        if (provider?.models) {
          for (const model of Object.values(provider.models)) {
            if (model) model.cost = { input: 0, output: 0 };
          }
        }

        const creds = await getValidCredentials(getAuth);
        if (!creds?.accessToken) {
          return null;
        }

        return {
          apiKey: 'oauth',
          baseURL: resolveBaseURL(creds.resourceUrl),
          fetch: buildFetchWithAuth(getAuth),
        };
      },
      methods: [
        {
          type: 'oauth',
          label: 'Login with Qwen account',
          authorize: async () => {
            const { verifier, challenge } = generatePKCE();

            try {
              const deviceAuth = await requestDeviceAuthorizationWithRetry(challenge);
              const verificationUrl = normalizeVerificationUrl(
                deviceAuth.verification_uri_complete ?? deviceAuth.verification_uri,
              );

              openBrowser(verificationUrl);
              qwenAuthEvents.emit('auth-browser-opened', {
                url: verificationUrl,
                userCode: deviceAuth.user_code,
              });

              return {
                url: verificationUrl,
                instructions: `Code: ${deviceAuth.user_code}`,
                method: 'auto',
                callback: async () => {
                  const session = createAuthSession();
                  const timeoutAt = Date.now() + deviceAuth.expires_in * 1000;
                  let intervalMs = Math.max((deviceAuth.interval ?? 5) * 1000, 2_000);

                  qwenAuthEvents.emit('auth-started', {
                    url: verificationUrl,
                    userCode: deviceAuth.user_code,
                    expiresAt: timeoutAt,
                  });

                  try {
                    while (Date.now() < timeoutAt) {
                      qwenAuthEvents.emit('auth-pending', {
                        nextPollInMs: intervalMs + DEVICE_POLL_MARGIN_MS,
                        remainingMs: Math.max(timeoutAt - Date.now(), 0),
                      });

                      await sleep(intervalMs + DEVICE_POLL_MARGIN_MS, session.signal);

                      try {
                        const creds = await pollDeviceToken(deviceAuth.device_code, verifier, session.signal);
                        if (!creds) continue;

                        await saveCredentials(creds);
                        qwenAuthEvents.emit('auth-succeeded', {
                          resourceUrl: creds.resourceUrl,
                          expiresAt: creds.expiryDate,
                        });

                        return {
                          type: 'success',
                          access: creds.accessToken,
                          refresh: creds.refreshToken ?? '',
                          expires: creds.expiryDate ?? Date.now() + 3600_000,
                          accountId: creds.resourceUrl,
                        };
                      } catch (error) {
                        if (error instanceof SlowDownError) {
                          intervalMs = Math.min(
                            Math.max(intervalMs + 5_000, error.retryAfterMs ?? 0),
                            DEVICE_POLL_MAX_INTERVAL_MS,
                          );
                          qwenAuthEvents.emit('auth-slow-down', { nextPollInMs: intervalMs });
                          continue;
                        }

                        if (error instanceof RetryableHttpError) {
                          intervalMs = Math.min(
                            getBackoffMs({
                              retryAfterMs: error.retryAfterMs,
                              baseMs: intervalMs,
                              maxMs: DEVICE_POLL_MAX_INTERVAL_MS,
                            }),
                            DEVICE_POLL_MAX_INTERVAL_MS,
                          );
                          debugLog(`Token polling temporarily failed; retrying in ${intervalMs}ms`, error);
                          qwenAuthEvents.emit('auth-retrying', {
                            status: error.status,
                            nextPollInMs: intervalMs,
                          });
                          continue;
                        }

                        if (isAbortError(error)) {
                          debugLog('OAuth device flow cancelled', error);
                          qwenAuthEvents.emit('auth-cancelled');
                          return { type: 'failed' };
                        }

                        debugLog('OAuth device flow failed', error);
                        qwenAuthEvents.emit('auth-failed', {
                          message: error instanceof Error ? error.message : String(error),
                        });
                        return { type: 'failed' };
                      }
                    }

                    qwenAuthEvents.emit('auth-failed', { message: 'Device authorization timed out' });
                    return { type: 'failed' };
                  } finally {
                    session.cleanup();
                  }
                },
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown error';
              debugLog('Failed to start OAuth device flow', error);
              qwenAuthEvents.emit('auth-failed', { message });
              return {
                url: QWEN_OAUTH_CONFIG.baseUrl,
                instructions: `Error: ${message}`,
                method: 'auto',
                callback: async () => ({ type: 'failed' }),
              };
            }
          },
        },
      ],
    },
    config: async config => {
      disableLegacyProviders(config);
      registerProvider(config);
    },
  };
};

export default QwenAuthPlugin;
