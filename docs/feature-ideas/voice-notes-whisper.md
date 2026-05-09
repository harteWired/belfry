<!-- title: Voice notes inbound — Whisper transcription on Telegram audio -->
## Motivation

Typing a paragraph on a phone keyboard while walking, driving, or making dinner is annoying. Telegram's voice notes (hold the mic icon) are the most natural way to dictate to a bot — and Whisper-quality transcription is now cheap enough to run per-message without thinking about cost.

Use cases:

- *"the api session is failing on the new auth flow, look at logs from the last 20 minutes and tell me what broke"* — easier said than typed
- Driving home, want to start a refactor by describing it
- Walking and notice an idea worth dropping into a project

The conversational agent (#13) already handles natural-language inbound. Voice → text → existing agent path is a strict capability addition.

## Shape

### Inbound voice messages

Telegram's `getUpdates` returns a `voice` field on messages with audio:

```json
{
  "message": {
    "voice": {
      "file_id": "...",
      "duration": 12,
      "mime_type": "audio/ogg"
    }
  }
}
```

Belfry currently drops these in `lib/router.js` because `text` is empty. Path:

1. Detect `message.voice` in the poller before the text check.
2. Fetch the audio file via `getFile` then `https://api.telegram.org/file/bot<TOKEN>/<file_path>` (existing pattern; same shape as `download_attachment` in the bundled telegram MCP plugin).
3. POST to OpenAI/Anthropic Whisper-equivalent for transcription. Anthropic doesn't ship audio-in for the Messages API yet, so this needs OpenAI's `audio/transcriptions` (`whisper-1` or successor) — adds a second API key (`OPENAI_API_KEY`) to the daemon's env. Or: cloud-agnostic via Groq's free Whisper tier, which keeps the no-SDK / one-key footprint cleaner.
4. Treat the transcribed text as if the user had typed it. All the existing routes (quote-reply, `/<slug>`, `/status`, agent) apply unchanged.

### Provider

Decision tree:

- **Groq** — free tier, Whisper-large-v3-turbo, fast (~2s for a 30s clip). New env var, cloud-agnostic. Best fit for the project's lean-deps ethos.
- **OpenAI** — proven, $0.006/min. Requires another vendor key for users who already have one.
- **Anthropic** — not yet supported for audio-in via Messages API. Skip until they ship it.

Plan: env var `BELFRY_TRANSCRIBE_KEY` + optional `BELFRY_TRANSCRIBE_PROVIDER` (default `groq`). Without the key, voice messages drop with a one-line "voice messages need a transcribe key" reply so the user knows why nothing happened.

### Confirmation reply

Voice → text is lossy. Before injecting transcribed text into a session, consider echoing back the transcript as a confirmation:

```
🎙 "the api session is failing on the new auth flow, look at logs from the last 20 minutes and tell me what broke"
→ api: routing
```

The user can quote-reply with corrections. For high-confidence transcriptions (Whisper provides a confidence score) we can skip the echo and just route — same threshold dance as the agent's confidence cutoff.

## Inspiration

[six-ddc/ccbot](https://github.com/six-ddc/ccbot) (MIT) has Whisper voice-note support already; their architecture uses a tmux backend, but the inbound-audio handling is independent of how injection works downstream and is a clean reference for the fetch/transcribe shape.

## Open questions

- **Privacy.** Audio leaves the host on every voice message, which is a meaningful step up from text (which already leaves for the summarizer). Worth a one-line note in the README's Trust model section. Default off makes sense.
- **Length cap.** Transcribing a 5-minute monologue produces a wall of text. Cap at ~60 seconds with a polite "voice notes capped at 60s; resend a shorter clip" reply.
- **Forward-as-attachment.** A nice-to-have: forward the original audio to the session as a downloadable attachment alongside the transcript, so the receiving Claude can re-listen for nuance. Probably YAGNI — text is plenty.

## Non-goals

- Not voice replies *out*. The phone speaker isn't the issue — text on the lock screen wins.
- Not local transcription. Adding faster-whisper as a runtime dep would balloon the install footprint by an order of magnitude. Cloud-only.
- Not voice-driven session creation. If the agent's natural-language routing (#13) doesn't pick the right slug from the transcript, that's a #13 problem.
