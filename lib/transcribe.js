/**
 * Cheap voice-note transcription via Groq's whisper-large-v3-turbo. New env
 * var BELFRY_TRANSCRIBE_KEY (Groq, default) gates the feature; without it,
 * voice messages drop with a polite reply.
 *
 * No SDK — FormData is in Node ≥18 globals; we POST to the OpenAI-compatible
 * audio/transcriptions endpoint Groq exposes. Same lean-deps ethos as the
 * Anthropic summarizer in lib/summarizer.js.
 *
 * Returns the transcript text (trimmed, non-empty) or null on any failure
 * — caller decides how to surface to the user.
 */

import * as nodeFs from 'node:fs';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_TIMEOUT_MS = 30_000;

export async function transcribe({
  apiKey,
  audioPath,
  model = DEFAULT_MODEL,
  endpoint = GROQ_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  fs = nodeFs,
  logFailure = () => {},
}) {
  if (!apiKey) return null;
  if (typeof audioPath !== 'string' || audioPath.length === 0) return null;
  let buf;
  try {
    buf = fs.readFileSync(audioPath);
  } catch (err) {
    logFailure('read', err.message);
    return null;
  }
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'voice.ogg');
  fd.append('model', model);
  fd.append('response_format', 'text');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
      signal: controller.signal,
    });
    if (!res.ok) {
      logFailure(httpCategory(res.status), `http ${res.status}`);
      return null;
    }
    const text = (await res.text()).trim();
    if (text.length === 0) {
      logFailure('parse', 'empty transcript');
      return null;
    }
    return text;
  } catch (err) {
    logFailure(err?.name === 'AbortError' ? 'timeout' : 'network', err?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function httpCategory(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  return 'client_error';
}
