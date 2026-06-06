import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transcribeAudio,
  makeVoiceHandler,
  voiceErrorReply,
  PROVIDERS,
} from '../lib/voice.js';

function fakeFs({ bytes = new Uint8Array([1, 2, 3]) } = {}) {
  return { readFileSync: () => Buffer.from(bytes) };
}

test('transcribeAudio: posts multipart to Groq endpoint by default and returns text', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ({ text: '  hello world  ' }),
    };
  };
  const { text } = await transcribeAudio({
    apiKey: 'k1',
    audioPath: '/tmp/v.ogg',
    fetchImpl,
    fs: fakeFs(),
  });
  assert.equal(text, 'hello world');
  assert.equal(captured.url, PROVIDERS.groq.endpoint);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer k1');
  assert.ok(captured.init.body instanceof FormData);
  assert.equal(captured.init.body.get('model'), PROVIDERS.groq.model);
});

test('transcribeAudio: switches endpoint + model for openai provider', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ text: 'ok' }) };
  };
  await transcribeAudio({
    apiKey: 'k',
    audioPath: '/tmp/v.ogg',
    provider: 'openai',
    fetchImpl,
    fs: fakeFs(),
  });
  assert.equal(captured.url, PROVIDERS.openai.endpoint);
  assert.equal(captured.init.body.get('model'), PROVIDERS.openai.model);
});

test('transcribeAudio: throws on unknown provider before touching network', async () => {
  let touched = false;
  const fetchImpl = async () => { touched = true; return { ok: true, json: async () => ({}) }; };
  await assert.rejects(
    () => transcribeAudio({ apiKey: 'k', audioPath: '/tmp/v.ogg', provider: 'bogus', fetchImpl, fs: fakeFs() }),
    /unknown transcribe provider/,
  );
  assert.equal(touched, false);
});

test('transcribeAudio: throws with status + body excerpt on non-2xx', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => 'Invalid API Key',
  });
  await assert.rejects(
    () => transcribeAudio({ apiKey: 'bad', audioPath: '/tmp/v.ogg', fetchImpl, fs: fakeFs() }),
    /transcribe groq 401.*Invalid API Key/,
  );
});

test('makeVoiceHandler: returns no-key error when apiKey missing', async () => {
  const handler = makeVoiceHandler({ apiKey: '', botToken: 't', attachmentDir: '/tmp' });
  const result = await handler({ message: { voice: { file_id: 'F', duration: 5 }, message_id: 1 } });
  assert.deepEqual(result, { error: 'no-key' });
});

test('makeVoiceHandler: returns null for messages without a voice field', async () => {
  const handler = makeVoiceHandler({ apiKey: 'k', botToken: 't', attachmentDir: '/tmp' });
  assert.equal(await handler({ message: { text: 'hi' } }), null);
});

test('makeVoiceHandler: caps duration at maxDurationSec', async () => {
  const handler = makeVoiceHandler({
    apiKey: 'k', botToken: 't', attachmentDir: '/tmp', maxDurationSec: 60,
    downloadFileImpl: async () => { throw new Error('should not download'); },
  });
  const result = await handler({ message: { voice: { file_id: 'F', duration: 90 }, message_id: 1 } });
  assert.deepEqual(result, { error: 'too-long', durationSec: 90 });
});

test('makeVoiceHandler: happy path downloads then transcribes', async () => {
  let downloadCalled, transcribeCalled;
  const handler = makeVoiceHandler({
    apiKey: 'k',
    botToken: 'T',
    attachmentDir: '/var/tmp',
    downloadFileImpl: async (args) => {
      downloadCalled = args;
      return '/var/tmp/voice-1.ogg';
    },
    transcribeImpl: async (args) => {
      transcribeCalled = args;
      return { text: 'deploy the api change' };
    },
  });
  const result = await handler({
    message: {
      voice: { file_id: 'FILE', duration: 8, mime_type: 'audio/ogg' },
      message_id: 42,
    },
  });
  assert.deepEqual(result, { text: 'deploy the api change', audioPath: '/var/tmp/voice-1.ogg' });
  assert.equal(downloadCalled.fileId, 'FILE');
  assert.equal(downloadCalled.destDir, '/var/tmp');
  assert.match(downloadCalled.destName, /^voice-\d+-42$/);
  assert.equal(transcribeCalled.audioPath, '/var/tmp/voice-1.ogg');
  assert.equal(transcribeCalled.mimeType, 'audio/ogg');
});

test('makeVoiceHandler: empty transcript surfaces as empty-transcript error', async () => {
  const handler = makeVoiceHandler({
    apiKey: 'k', botToken: 'T', attachmentDir: '/tmp',
    downloadFileImpl: async () => '/tmp/voice-x.ogg',
    transcribeImpl: async () => ({ text: '' }),
  });
  const result = await handler({ message: { voice: { file_id: 'F', duration: 3 }, message_id: 9 } });
  assert.deepEqual(result, { error: 'empty-transcript' });
});

test('makeVoiceHandler: download failure surfaces as download-failed (no transcribe call)', async () => {
  let transcribed = false;
  const handler = makeVoiceHandler({
    apiKey: 'k', botToken: 'T', attachmentDir: '/tmp',
    downloadFileImpl: async () => { throw new Error('timeout'); },
    transcribeImpl: async () => { transcribed = true; return { text: 'x' }; },
  });
  const result = await handler({ message: { voice: { file_id: 'F', duration: 3 }, message_id: 9 } });
  assert.deepEqual(result, { error: 'download-failed' });
  assert.equal(transcribed, false);
});

test('makeVoiceHandler: transcribe failure surfaces detail + logs', async () => {
  const logs = [];
  const handler = makeVoiceHandler({
    apiKey: 'k', botToken: 'T', attachmentDir: '/tmp',
    downloadFileImpl: async () => '/tmp/v.ogg',
    transcribeImpl: async () => { throw new Error('groq 503'); },
    log: (m) => logs.push(m),
  });
  const result = await handler({ message: { voice: { file_id: 'F', duration: 3 }, message_id: 9 } });
  assert.equal(result.error, 'transcribe-failed');
  assert.match(result.detail, /groq 503/);
  assert.ok(logs.some((l) => l.includes('groq 503')), `expected log line, got: ${JSON.stringify(logs)}`);
});

test('voiceErrorReply: maps each error to a short user-facing string', () => {
  assert.match(voiceErrorReply({ error: 'no-key' }), /BELFRY_TRANSCRIBE_KEY/);
  assert.match(voiceErrorReply({ error: 'too-long' }, { maxDurationSec: 45 }), /45s/);
  assert.match(voiceErrorReply({ error: 'download-failed' }), /resending|fetch/i);
  assert.match(voiceErrorReply({ error: 'transcribe-failed' }), /transcription/);
  assert.match(voiceErrorReply({ error: 'empty-transcript' }), /empty/);
  assert.match(voiceErrorReply({ error: 'wat' }), /unknown/);
});
