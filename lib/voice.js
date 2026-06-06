/**
 * Telegram voice-note inbound: download the .ogg via getFile, POST to a
 * Whisper-compatible transcription endpoint, return the text. Inbound voice
 * messages then flow through the normal routing pipeline as if the user had
 * typed the transcript.
 *
 * Defaults to Groq's free Whisper-large-v3-turbo. OpenAI's whisper-1 is the
 * documented fallback. Both speak the same multipart `audio/transcriptions`
 * shape — switching providers is just an endpoint + default model.
 *
 * Built on Node 20's built-in FormData/Blob — no SDK, no multipart helper
 * dep, in keeping with the project's lean-deps rule.
 */

import * as nodeFs from 'node:fs';
import { basename } from 'node:path';

import { downloadFile } from './telegram.js';

export const DEFAULT_PROVIDER = 'groq';
export const DEFAULT_MAX_DURATION_SEC = 60;

export const PROVIDERS = {
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
  },
};

/**
 * POST audio bytes to the chosen provider's Whisper endpoint. Returns the
 * trimmed transcript text. Throws on any non-2xx response or unknown
 * provider — the caller decides whether to surface that to the user.
 */
export async function transcribeAudio({
  apiKey,
  audioPath,
  mimeType = 'audio/ogg',
  provider = DEFAULT_PROVIDER,
  model,
  fetchImpl = globalThis.fetch,
  fs = nodeFs,
}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown transcribe provider: ${provider}`);
  if (!apiKey) throw new Error('transcribe: missing apiKey');
  const bytes = fs.readFileSync(audioPath);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: mimeType }), basename(audioPath));
  form.set('model', model ?? cfg.model);
  form.set('response_format', 'json');
  const res = await fetchImpl(cfg.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`transcribe ${provider} ${res.status}: ${err.slice(0, 200)}`);
  }
  const json = await res.json();
  return { text: (json.text ?? '').trim() };
}

/**
 * Build a voice-message handler bound to a single daemon's config. Returns
 * a function `({ message }) → { text } | { error } | null` that the poller
 * calls when an inbound update carries `message.voice`.
 *
 * The handler returns:
 *   - `{ text }` on success
 *   - `{ error: 'no-key' }` if no API key is configured (poller surfaces
 *     a one-line "voice support is off" reply to the chat)
 *   - `{ error: 'too-long', durationSec }` if voice.duration exceeds the
 *     cap (default 60s)
 *   - `{ error: 'download-failed' | 'transcribe-failed' | 'empty-transcript' }`
 *     on network / API failures
 *   - `null` if the message has no voice field at all (defensive — the
 *     poller checks before calling, but a no-op is safer than a throw).
 */
export function makeVoiceHandler({
  apiKey,
  provider = DEFAULT_PROVIDER,
  botToken,
  attachmentDir,
  maxDurationSec = DEFAULT_MAX_DURATION_SEC,
  log = () => {},
  downloadFileImpl = downloadFile,
  transcribeImpl = transcribeAudio,
}) {
  return async function handleVoice({ message }) {
    const voice = message?.voice;
    if (!voice?.file_id) return null;
    if (!apiKey) return { error: 'no-key' };
    if (typeof voice.duration === 'number' && voice.duration > maxDurationSec) {
      return { error: 'too-long', durationSec: voice.duration };
    }
    let audioPath;
    try {
      audioPath = await downloadFileImpl({
        botToken,
        fileId: voice.file_id,
        destDir: attachmentDir,
        destName: `voice-${Date.now()}-${message.message_id ?? 'x'}`,
      });
    } catch (err) {
      log(`voice download failed (msg ${message.message_id}): ${err.message}`);
      return { error: 'download-failed' };
    }
    try {
      const { text } = await transcribeImpl({
        apiKey,
        audioPath,
        mimeType: voice.mime_type || 'audio/ogg',
        provider,
      });
      if (!text) return { error: 'empty-transcript' };
      return { text, audioPath };
    } catch (err) {
      log(`voice transcribe failed (msg ${message.message_id}): ${err.message}`);
      return { error: 'transcribe-failed', detail: err.message };
    }
  };
}

/**
 * User-facing message for each voice-handler error code. Kept short — these
 * land on a phone lock screen, so the body should fit in the preview.
 */
export function voiceErrorReply(result, { maxDurationSec = DEFAULT_MAX_DURATION_SEC } = {}) {
  switch (result?.error) {
    case 'no-key':
      return '🎙 voice notes need BELFRY_TRANSCRIBE_KEY — ignoring';
    case 'too-long':
      return `🎙 voice notes capped at ${maxDurationSec}s; resend a shorter clip`;
    case 'download-failed':
      return '🎙 couldn\'t fetch the voice note from Telegram — try resending';
    case 'transcribe-failed':
      return '🎙 transcription failed — the provider returned an error';
    case 'empty-transcript':
      return '🎙 transcription came back empty — re-record with clearer audio';
    default:
      return '🎙 voice note dropped (unknown reason)';
  }
}
