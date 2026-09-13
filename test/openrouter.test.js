/* server/openrouter.js — no network. globalThis.fetch is replaced per test and
   restored afterwards; openrouter.js reads it at call time on purpose.
   DATA_DIR points at a throwaway folder: doc() works in memory without
   initStore(), so nothing here touches data/. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plumi-openrouter-'));
process.env.MEMOLANG_DATA_DIR = TMP;
process.env.DATA_DIR = TMP;
delete process.env.OPENROUTER_API_KEY;

// Dynamic so the env above is in place before server/config.js is evaluated.
const {
  listModels, chat, extractJson, estimateCost, maskKey, strictify, cachedModel, OpenRouterError,
} = await import('../server/openrouter.js');
const { doc, flushAll } = await import('../server/store.js');

const cache = doc('models-cache', {});
const realFetch = globalThis.fetch;
const KEY = 'sk-or-v1-abcdef1234';
const MODEL = 'anthropic/claude-sonnet-4.5';

after(() => { globalThis.fetch = realFetch; return flushAll(); });

/* ── helpers ─────────────────────────────────────────────────────────────── */

function stubFetch(t, steps) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const i = calls.length;
    calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
      rawBody: init.body || '',
    });
    const step = Array.isArray(steps) ? steps[Math.min(i, steps.length - 1)] : steps;
    if (typeof step === 'function') return step(i, init);
    const { status = 200, body = {} } = step || {};
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

function clearCache() { cache.set(() => ({})); }

function seedCache(models) {
  cache.set(() => ({ fetchedAt: new Date().toISOString(), models }));
}

const MODELS_BODY = {
  data: [
    {
      id: MODEL,
      name: 'Anthropic: Claude Sonnet 4.5',
      created: 1758000000,
      context_length: 200000,
      architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.000003', completion: '0.000015', image: '0.0048', request: '0' },
      top_provider: { context_length: 200000, max_completion_tokens: 64000 },
      supported_parameters: ['max_tokens', 'temperature', 'response_format', 'structured_outputs', 'tools'],
    },
    {
      // No input_modalities: the packed `modality` string has to be parsed.
      id: 'openai/gpt-4o-mini',
      name: 'OpenAI: GPT-4o-mini',
      context_length: 128000,
      architecture: { modality: 'text+image->text' },
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
      supported_parameters: ['max_tokens', 'response_format'],
    },
    {
      id: 'plain/text-only',
      name: 'Plain text only',
      context_length: 8192,
      architecture: { modality: 'text->text' },
      pricing: {},
      supported_parameters: ['max_tokens'],
    },
    { id: '', name: 'nameless junk' },
  ],
};

function completion(content, { usage, id = 'gen-abc', model = MODEL, finish = 'stop' } = {}) {
  return {
    status: 200,
    body: {
      id,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
      usage: usage === undefined
        ? { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160, cost: 0.000123 }
        : usage,
    },
  };
}

const ASK = [{ role: 'user', content: 'hi' }];
const SCHEMA = { type: 'object', properties: { reply: { type: 'string' } } };

/* ── maskKey ─────────────────────────────────────────────────────────────── */

test('maskKey shows just enough to recognise a key', () => {
  assert.equal(maskKey('sk-or-v1-abcdef1234'), 'sk-or-…1234');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(undefined), '');
  assert.equal(maskKey(null), '');
  assert.equal(maskKey('   '), '');
  assert.equal(maskKey('  sk-or-v1-abcdef1234  '), 'sk-or-…1234');
  // A real key is never echoed whole, not even a short nonsense one.
  assert.equal(maskKey('short'), '…rt');
  assert.ok(!maskKey('sk-or-v1-abcdef1234').includes('abcdef'));
});

/* ── extractJson ─────────────────────────────────────────────────────────── */

test('extractJson takes the JSON out of whatever the model wrapped it in', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('  [1,2,3] '), [1, 2, 3]);

  // Fences, with and without a language tag.
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });

  // Prose before and after, the classic.
  assert.deepEqual(
    extractJson('Sure! Here is your lesson:\n```json\n{"lesson":{"title":"Food"},"words":[]}\n```\nLet me know if you want more!'),
    { lesson: { title: 'Food' }, words: [] },
  );
  assert.deepEqual(extractJson('Here you go: {"a":{"b":[1,2]}} — hope that helps.'), { a: { b: [1, 2] } });

  // Braces inside strings must not confuse the balance counter.
  assert.deepEqual(extractJson('{"a":"} not the end {","b":"\\"quoted\\""}'), { a: '} not the end {', b: '"quoted"' });

  // Trailing comma, the other classic.
  assert.deepEqual(extractJson('{"a":1,}'), { a: 1 });

  assert.throws(() => extractJson('I cannot help with that.'), /did not return JSON/);
  assert.throws(() => extractJson(''), /did not return JSON/);
  // The error quotes what was said so the learner can see the refusal.
  assert.throws(() => extractJson('Sorry, no.'), /Sorry, no\./);
});

/* ── strictify ───────────────────────────────────────────────────────────── */

test('strictify makes every object strict, recursively, without mutating', () => {
  const schema = {
    type: 'object',
    properties: {
      lesson: { type: 'object', properties: { title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
      words: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hanzi: { type: 'string' },
            examples: { type: 'array', items: { type: 'object', properties: { zh: { type: 'string' } } } },
            note: { anyOf: [{ type: 'object', properties: { text: { type: 'string' } } }, { type: 'null' }] },
          },
        },
      },
    },
  };
  const before = JSON.stringify(schema);
  const strict = strictify(schema);

  assert.equal(JSON.stringify(schema), before, 'the input schema must not be touched');
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ['lesson', 'words']);
  assert.equal(strict.properties.lesson.additionalProperties, false);
  assert.deepEqual(strict.properties.lesson.required, ['title', 'tags']);
  const word = strict.properties.words.items;
  assert.equal(word.additionalProperties, false);
  assert.deepEqual(word.required, ['hanzi', 'examples', 'note']);
  assert.equal(word.properties.examples.items.additionalProperties, false);
  assert.deepEqual(word.properties.examples.items.required, ['zh']);
  assert.equal(word.properties.note.anyOf[0].additionalProperties, false);
  assert.deepEqual(word.properties.note.anyOf[0].required, ['text']);
  // Arrays and scalars are left alone.
  assert.equal(strict.properties.lesson.properties.tags.additionalProperties, undefined);
});

test('strictify handles nullable objects and $defs', () => {
  const strict = strictify({
    $defs: { ex: { type: 'object', properties: { zh: { type: 'string' } } } },
    type: ['object', 'null'],
    properties: { a: { $ref: '#/$defs/ex' } },
    required: ['nonsense'],
  });
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ['a'], 'required is rebuilt from properties');
  assert.equal(strict.$defs.ex.additionalProperties, false);
  assert.deepEqual(strict.$defs.ex.required, ['zh']);
});

/* ── estimateCost ────────────────────────────────────────────────────────── */

test('estimateCost multiplies tokens by the catalogue prices', () => {
  const model = { pricing: { prompt: 0.000003, completion: 0.000015, image: 0 } };
  const cost = estimateCost(model, { promptTokens: 1000, completionTokens: 200 });
  assert.ok(Math.abs(cost - (0.003 + 0.003)) < 1e-12);
  // Raw OpenRouter field names work too.
  assert.ok(Math.abs(estimateCost(model, { prompt_tokens: 1000, completion_tokens: 0 }) - 0.003) < 1e-12);
  assert.equal(estimateCost(model, {}), 0);
  assert.equal(estimateCost({ pricing: {} }, { promptTokens: 10, completionTokens: 10 }), 0, 'a free model costs 0');
  assert.equal(estimateCost(null, { promptTokens: 10 }), null, 'an unknown model costs null, not 0');
  assert.equal(estimateCost({}, { promptTokens: 10 }), null);
});

/* ── listModels ──────────────────────────────────────────────────────────── */

test('listModels maps the catalogue into the contract shape', async (t) => {
  clearCache();
  const calls = stubFetch(t, { body: MODELS_BODY });
  const models = await listModels({ apiKey: KEY });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].headers['HTTP-Referer'], 'https://github.com/THRAUR/PlumiMemoLang');
  assert.equal(calls[0].headers['X-Title'], 'PlumiMemoLang');

  assert.equal(models.length, 3, 'entries without an id are dropped');
  const [sonnet, mini, plain] = models;

  assert.deepEqual(sonnet, {
    id: MODEL,
    name: 'Anthropic: Claude Sonnet 4.5',
    contextLength: 200000,
    pricing: { prompt: 0.000003, completion: 0.000015, image: 0.0048 },
    inputModalities: ['text', 'image'],
    supportsStructured: true,
    supportsJson: true,
    created: 1758000000,
  });
  assert.equal(typeof sonnet.pricing.prompt, 'number', 'prices are numbers, not strings');

  // modality fallback: "text+image->text" → ["text","image"]
  assert.deepEqual(mini.inputModalities, ['text', 'image']);
  assert.equal(mini.supportsStructured, false);
  assert.equal(mini.supportsJson, true);

  assert.deepEqual(plain.inputModalities, ['text']);
  assert.deepEqual(plain.pricing, { prompt: 0, completion: 0, image: 0 });
  assert.equal(plain.supportsJson, false);

  // Cached for chat() to look models up without a network call.
  assert.equal(cachedModel(MODEL)?.supportsStructured, true);
  assert.equal(cachedModel(`${MODEL}:floor`)?.id, MODEL, 'a :variant suffix resolves to the base model');
  assert.equal(cachedModel('nope/nope'), null);
});

test('listModels caches for 24 h and refreshes on demand', async (t) => {
  clearCache();
  const calls = stubFetch(t, { body: MODELS_BODY });

  await listModels({ apiKey: KEY });
  assert.equal(calls.length, 1);
  await listModels({ apiKey: KEY });
  assert.equal(calls.length, 1, 'the second call is served from the cache');

  await listModels({ apiKey: KEY, refresh: true });
  assert.equal(calls.length, 2, 'refresh bypasses the cache');

  // An expired cache is refetched.
  cache.set(() => ({ fetchedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), models: [{ id: 'old/model' }] }));
  const fresh = await listModels({});
  assert.equal(calls.length, 3);
  assert.equal(fresh[0].id, MODEL);
  assert.equal(calls[2].headers.Authorization, undefined, 'no key, no Authorization header');
});

test('listModels falls back to a stale cache when OpenRouter is down', async (t) => {
  cache.set(() => ({
    fetchedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    models: [{ id: 'stale/model', name: 'Stale', pricing: { prompt: 0, completion: 0, image: 0 } }],
  }));
  stubFetch(t, () => { throw new Error('getaddrinfo ENOTFOUND openrouter.ai'); });
  const models = await listModels({ apiKey: KEY });
  assert.equal(models[0].id, 'stale/model', 'a stale catalogue beats no catalogue');
});

test('listModels reports a rejected key in human words', async (t) => {
  clearCache();
  stubFetch(t, { status: 401, body: { error: { message: 'No auth credentials found', code: 401 } } });
  await assert.rejects(
    () => listModels({ apiKey: 'sk-or-v1-wrong' }),
    (e) => {
      assert.ok(e instanceof OpenRouterError);
      assert.equal(e.status, 401);
      assert.equal(e.message, 'OpenRouter rejected the API key. Check it in Settings.');
      assert.ok(!e.message.includes('sk-or-v1-wrong'), 'the key never appears in an error');
      return true;
    },
  );
});

/* ── chat ────────────────────────────────────────────────────────────────── */

test('chat sends the app headers, usage accounting and the right body', async (t) => {
  clearCache();
  const calls = stubFetch(t, completion('Hello 你好'));
  const out = await chat({ apiKey: KEY, model: MODEL, messages: ASK, temperature: 0.2, maxTokens: 1234 });

  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].headers['HTTP-Referer'], 'https://github.com/THRAUR/PlumiMemoLang');
  assert.equal(calls[0].headers['X-Title'], 'PlumiMemoLang');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');

  assert.equal(calls[0].body.model, MODEL);
  assert.deepEqual(calls[0].body.messages, ASK);
  assert.equal(calls[0].body.temperature, 0.2);
  assert.equal(calls[0].body.max_tokens, 1234);
  assert.deepEqual(calls[0].body.usage, { include: true }, 'usage accounting must be on');
  assert.equal(calls[0].body.response_format, undefined, 'no schema, no response_format');
  assert.ok(!calls[0].rawBody.includes(KEY), 'the key travels in the header, never in the body');

  assert.equal(out.text, 'Hello 你好');
  assert.equal(out.json, null);
  assert.equal(out.model, MODEL);
  assert.equal(out.id, 'gen-abc');
  assert.deepEqual(out.usage, { promptTokens: 120, completionTokens: 40, totalTokens: 160, cost: 0.000123 });
});

test('chat picks the strongest JSON mode the model supports', async (t) => {
  seedCache([
    { id: 'a/structured', pricing: {}, supportsStructured: true, supportsJson: true },
    { id: 'b/jsononly', pricing: {}, supportsStructured: false, supportsJson: true },
    { id: 'c/neither', pricing: {}, supportsStructured: false, supportsJson: false },
  ]);
  const calls = stubFetch(t, completion('{"reply":"ok"}'));

  await chat({ apiKey: KEY, model: 'a/structured', messages: ASK, schema: SCHEMA, schemaName: 'extract' });
  const rf = calls[0].body.response_format;
  assert.equal(rf.type, 'json_schema');
  assert.equal(rf.json_schema.name, 'extract');
  assert.equal(rf.json_schema.strict, true);
  assert.equal(rf.json_schema.schema.additionalProperties, false, 'the schema went through strictify');
  assert.deepEqual(rf.json_schema.schema.required, ['reply']);

  await chat({ apiKey: KEY, model: 'b/jsononly', messages: ASK, schema: SCHEMA });
  assert.deepEqual(calls[1].body.response_format, { type: 'json_object' });

  await chat({ apiKey: KEY, model: 'c/neither', messages: ASK, schema: SCHEMA });
  assert.equal(calls[2].body.response_format, undefined, 'the prompt asks for JSON instead');

  await chat({ apiKey: KEY, model: 'unknown/model', messages: ASK, schema: SCHEMA });
  assert.equal(calls[3].body.response_format, undefined, 'an uncached model gets no response_format');
});

test('chat digs the JSON out of fences and prose', async (t) => {
  seedCache([{ id: MODEL, pricing: {}, supportsStructured: true, supportsJson: true }]);
  const calls = stubFetch(t, completion('Of course! Here is the lesson:\n```json\n{"words":[{"hanzi":"謝謝"}]}\n```\nAnything else?'));
  const out = await chat({ apiKey: KEY, model: MODEL, messages: ASK, schema: SCHEMA });
  assert.equal(calls.length, 1, 'no retry was needed');
  assert.deepEqual(out.json, { words: [{ hanzi: '謝謝' }] });
});

test('chat retries exactly once when the JSON is broken, and sums the usage', async (t) => {
  seedCache([{ id: MODEL, pricing: {}, supportsStructured: true, supportsJson: true }]);
  const calls = stubFetch(t, [
    completion('I think the answer is: {"words": [ {"hanzi": ', { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.0001 } }),
    completion('{"words":[{"hanzi":"你好"}]}', { usage: { prompt_tokens: 130, completion_tokens: 20, total_tokens: 150, cost: 0.0002 }, id: 'gen-retry' }),
  ]);
  const out = await chat({ apiKey: KEY, model: MODEL, messages: ASK, schema: SCHEMA });

  assert.equal(calls.length, 2, 'one nudge, no more');
  const turns = calls[1].body.messages;
  assert.equal(turns.length, 3);
  assert.equal(turns[1].role, 'assistant');
  assert.equal(turns[2].role, 'user');
  assert.match(turns[2].content, /ONLY the JSON/);
  assert.deepEqual(out.json, { words: [{ hanzi: '你好' }] });
  assert.equal(out.id, 'gen-retry');
  // Both calls were paid for.
  assert.equal(out.usage.promptTokens, 230);
  assert.equal(out.usage.completionTokens, 30);
  assert.equal(out.usage.totalTokens, 260);
  assert.ok(Math.abs(out.usage.cost - 0.0003) < 1e-12);
});

test('chat gives up after the retry with a human message', async (t) => {
  seedCache([{ id: MODEL, pricing: {}, supportsStructured: true, supportsJson: true }]);
  const calls = stubFetch(t, completion('I am not able to produce JSON.'));
  await assert.rejects(
    () => chat({ apiKey: KEY, model: MODEL, messages: ASK, schema: SCHEMA }),
    (e) => {
      assert.match(e.message, /did not return usable JSON/);
      assert.match(e.message, new RegExp(MODEL));
      assert.equal(e.usage.promptTokens, 240, 'the failed attempts are still accounted for');
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test('chat falls back to catalogue prices when OpenRouter reports no cost', async (t) => {
  seedCache([{ id: MODEL, pricing: { prompt: 0.000003, completion: 0.000015, image: 0 }, supportsStructured: true, supportsJson: true }]);
  stubFetch(t, completion('hi', { usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
  const out = await chat({ apiKey: KEY, model: MODEL, messages: ASK });
  assert.equal(out.usage.totalTokens, 1100, 'total_tokens is derived when missing');
  assert.ok(Math.abs(out.usage.cost - (0.003 + 0.0015)) < 1e-12);
});

test('chat turns HTTP statuses into sentences the learner can act on', async (t) => {
  clearCache();
  const cases = [
    [401, 'OpenRouter rejected the API key. Check it in Settings.'],
    [402, 'Your OpenRouter account is out of credits.'],
    [404, `That model was not found on OpenRouter. (model: ${MODEL})`],
    [429, `OpenRouter is rate-limiting requests. Try again in a minute. (model: ${MODEL})`],
  ];
  for (const [status, message] of cases) {
    stubFetch(t, { status, body: { error: { message: 'upstream detail', code: status } } });
    await assert.rejects(
      () => chat({ apiKey: KEY, model: MODEL, messages: ASK }),
      (e) => {
        assert.equal(e.message, message);
        assert.equal(e.status, status);
        assert.ok(!e.message.includes(KEY));
        return true;
      },
    );
  }

  // A 200 with an error envelope (provider blew up) is still an error.
  stubFetch(t, { status: 200, body: { error: { message: 'Provider returned error', code: 502 } } });
  await assert.rejects(() => chat({ apiKey: KEY, model: MODEL, messages: ASK }), /having trouble \(status 502\)/);
});

test('chat reports a timeout and a cancellation differently', async (t) => {
  clearCache();
  // A fetch that never answers, but does honour the abort signal.
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    });
  });
  t.after(() => { globalThis.fetch = realFetch; });

  await assert.rejects(
    () => chat({ apiKey: KEY, model: MODEL, messages: ASK, timeoutMs: 25 }),
    (e) => {
      assert.equal(e.message, `OpenRouter did not answer in time. (model: ${MODEL})`);
      return true;
    },
  );

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(
    () => chat({ apiKey: KEY, model: MODEL, messages: ASK, timeoutMs: 5000, signal: ac.signal }),
    (e) => {
      assert.equal(e.message, 'Cancelled.', 'an aborted job is not a timeout');
      return true;
    },
  );
});

test('chat refuses to call without a key or a model', async (t) => {
  const calls = stubFetch(t, completion('hi'));
  await assert.rejects(() => chat({ apiKey: '', model: MODEL, messages: ASK }), /Add your OpenRouter API key in Settings first\./);
  await assert.rejects(() => chat({ apiKey: KEY, model: '', messages: ASK }), /Pick one in Settings\./);
  await assert.rejects(() => chat({ apiKey: KEY, model: MODEL, messages: [] }), /Nothing to ask the model\./);
  assert.equal(calls.length, 0, 'nothing left the machine');
});

test('chat surfaces an empty answer and a refusal', async (t) => {
  clearCache();
  stubFetch(t, completion('   '));
  await assert.rejects(() => chat({ apiKey: KEY, model: MODEL, messages: ASK }), /returned an empty answer/);

  stubFetch(t, {
    status: 200,
    body: { id: 'x', model: MODEL, choices: [{ message: { role: 'assistant', content: '', refusal: 'I cannot help with that.' } }] },
  });
  await assert.rejects(() => chat({ apiKey: KEY, model: MODEL, messages: ASK }), /declined to answer: I cannot help with that\./);
});

test('chat accepts content returned as an array of parts', async (t) => {
  clearCache();
  stubFetch(t, {
    status: 200,
    body: {
      id: 'x',
      model: MODEL,
      choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  });
  const out = await chat({ apiKey: KEY, model: MODEL, messages: ASK, schema: SCHEMA });
  assert.deepEqual(out.json, { a: 1 });
});
