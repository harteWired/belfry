import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setMessageReaction,
  sendDocument,
  downloadFile,
  parseByteSize,
  resolveFileCap,
  TELEGRAM_DOWNLOAD_CEILING,
} from '../lib/telegram.js';

// --- sendDocument (#outbound files) ---
function fileFetch(captured, { ok = true, status = 200, result = { ok: true, result: { message_id: 1 } } } = {}) {
  return async (url, opts) => {
    captured.push({ url, form: opts.body });
    return { ok, status, json: async () => result, text: async () => JSON.stringify(result) };
  };
}
const fakeFs = (content = 'bytes') => ({ readFileSync: () => Buffer.from(content) });

test('sendDocument uses sendPhoto for image extensions (case-insensitive)', async () => {
  const cap = [];
  await sendDocument({ botToken: 'TOK', chatId: 5, filePath: '/x/pic.PNG', caption: 'hi', fetchImpl: fileFetch(cap), fs: fakeFs() });
  assert.match(cap[0].url, /\/botTOK\/sendPhoto$/);
  assert.ok(cap[0].form.get('photo'));
  assert.equal(cap[0].form.get('chat_id'), '5');
  assert.equal(cap[0].form.get('caption'), 'hi');
});

test('sendDocument uses sendDocument for non-image, and forceDocument overrides an image', async () => {
  const cap = [];
  await sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/report.pdf', fetchImpl: fileFetch(cap), fs: fakeFs() });
  assert.match(cap[0].url, /\/sendDocument$/);
  assert.ok(cap[0].form.get('document'));
  const cap2 = [];
  await sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/pic.png', forceDocument: true, fetchImpl: fileFetch(cap2), fs: fakeFs() });
  assert.match(cap2[0].url, /\/sendDocument$/);
});

test('sendDocument threads reply_parameters and clamps caption to 1024', async () => {
  const cap = [];
  await sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/a.txt', caption: 'x'.repeat(2000), replyToMessageId: 99, fetchImpl: fileFetch(cap), fs: fakeFs() });
  assert.equal(cap[0].form.get('caption').length, 1024);
  assert.deepEqual(JSON.parse(cap[0].form.get('reply_parameters')), { message_id: 99, allow_sending_without_reply: true });
});

test('sendDocument throws on a non-ok Telegram response', async () => {
  await assert.rejects(
    () => sendDocument({ botToken: 'T', chatId: 1, filePath: '/x/a.txt', fetchImpl: fileFetch([], { ok: false, status: 400, result: { ok: false } }), fs: fakeFs() }),
    /sendDocument failed: 400/,
  );
});

function fakeFetch(captured, { ok = true, status = 200, result = { ok: true } } = {}) {
  return async (url, opts) => {
    captured.push({ url, opts, body: JSON.parse(opts.body) });
    return {
      ok,
      status,
      json: async () => result,
      text: async () => JSON.stringify(result),
    };
  };
}

test('setMessageReaction posts the emoji as a ReactionTypeEmoji array', async () => {
  const captured = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 42, messageId: 7, emoji: '👀', fetchImpl: fakeFetch(captured),
  });
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/botTOK\/setMessageReaction$/);
  assert.deepEqual(captured[0].body, {
    chat_id: 42,
    message_id: 7,
    reaction: [{ type: 'emoji', emoji: '👀' }],
  });
});

test('falsy emoji clears the reaction with an empty array', async () => {
  const captured = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 1, messageId: 2, emoji: null, fetchImpl: fakeFetch(captured),
  });
  assert.deepEqual(captured[0].body.reaction, []);
});

test('is_big is only set when requested', async () => {
  const captured = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 1, messageId: 2, emoji: '✅', isBig: true, fetchImpl: fakeFetch(captured),
  });
  assert.equal(captured[0].body.is_big, true);

  const captured2 = [];
  await setMessageReaction({
    botToken: 'TOK', chatId: 1, messageId: 2, emoji: '✅', fetchImpl: fakeFetch(captured2),
  });
  assert.equal(captured2[0].body.is_big, undefined);
});

test('throws on a non-ok HTTP response', async () => {
  const fetchImpl = fakeFetch([], { ok: false, status: 400, result: { ok: false, description: 'REACTION_INVALID' } });
  await assert.rejects(
    () => setMessageReaction({ botToken: 'TOK', chatId: 1, messageId: 2, emoji: '🛠', fetchImpl }),
    /setMessageReaction failed: 400/,
  );
});

// --- attachment size cap (BELFRY_ATTACHMENT_MAX_BYTES) ---
test('parseByteSize accepts plain bytes and unit suffixes', () => {
  assert.equal(parseByteSize('4194304'), 4194304);
  assert.equal(parseByteSize('8mb'), 8 * 1024 * 1024);
  assert.equal(parseByteSize('8 MB'), 8 * 1024 * 1024);
  assert.equal(parseByteSize('512k'), 512 * 1024);
  assert.equal(parseByteSize('1.5m'), Math.round(1.5 * 1024 * 1024));
  assert.equal(parseByteSize('1g'), 1024 ** 3);
});

test('parseByteSize returns null for empty/invalid/non-positive input', () => {
  for (const bad of ['', '   ', undefined, null, 'lots', '-5', '0', '4tb', '1..2m']) {
    assert.equal(parseByteSize(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('resolveFileCap defaults to 4 MB when the env is unset or invalid', () => {
  assert.equal(resolveFileCap({}), 4 * 1024 * 1024);
  assert.equal(resolveFileCap({ BELFRY_ATTACHMENT_MAX_BYTES: 'garbage' }), 4 * 1024 * 1024);
});

test('resolveFileCap honours a valid override and clamps to Telegram\'s 20 MB ceiling', () => {
  assert.equal(resolveFileCap({ BELFRY_ATTACHMENT_MAX_BYTES: '8mb' }), 8 * 1024 * 1024);
  assert.equal(resolveFileCap({ BELFRY_ATTACHMENT_MAX_BYTES: '50mb' }), TELEGRAM_DOWNLOAD_CEILING);
});

// downloadFile: getFile meta first, then the file bytes.
function downloadFetch({ declaredSize, bytesLen }) {
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/x.jpg', file_size: declaredSize } }),
      };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array(bytesLen).buffer };
  };
}

test('downloadFile rejects on the declared getFile size before streaming', async () => {
  let streamed = false;
  const fetchImpl = async (url) => {
    if (url.includes('/file/')) { streamed = true; }
    if (url.endsWith('/getFile')) {
      return { ok: true, json: async () => ({ ok: true, result: { file_path: 'a.jpg', file_size: 9_000_000 } }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(
    () => downloadFile({ botToken: 'T', fileId: 'F', destDir: '/tmp/x', destName: 'd', fetchImpl, sizeCap: 4 * 1024 * 1024 }),
    /file too large: 9000000 > 4194304/,
  );
  assert.equal(streamed, false, 'must not stream bytes once the declared size exceeds the cap');
});

test('downloadFile backstops on streamed length when getFile omits file_size', async () => {
  const fetchImpl = downloadFetch({ declaredSize: undefined, bytesLen: 5_000_000 });
  await assert.rejects(
    () => downloadFile({ botToken: 'T', fileId: 'F', destDir: '/tmp/x', destName: 'd', fetchImpl, sizeCap: 4 * 1024 * 1024 }),
    /file too large: 5000000 > 4194304/,
  );
});

test('downloadFile writes the file when a raised cap admits it', async () => {
  const writes = [];
  const fs = {
    mkdirSync: () => {},
    writeFileSync: (out, buf) => writes.push({ out, len: buf.length }),
  };
  const path = { extname: () => '.jpg', join: (...p) => p.join('/') };
  const fetchImpl = downloadFetch({ declaredSize: 6_000_000, bytesLen: 6_000_000 });
  const out = await downloadFile({
    botToken: 'T', fileId: 'F', destDir: '/tmp/x', destName: 'd',
    fetchImpl, fs, path, sizeCap: 8 * 1024 * 1024,
  });
  assert.equal(out, '/tmp/x/d.jpg');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].len, 6_000_000);
});
