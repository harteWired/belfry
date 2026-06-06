<!-- title: Image attachments inbound — pass-through to session as image_path -->
## Motivation

The most common "complex" thing I want to send from my phone to a coding session is a screenshot — of an error dialog, a UI bug, a stack trace, a design reference. Today belfry drops these silently because `message.text` is empty when the message is photo-only.

Claude Code's MCP `notifications/claude/channel` accepts an `image_path` attribute on the channel notification — the same path the bundled `plugin:telegram` uses to forward photos into a session. Belfry can do the same: download the photo, save it, and emit a channel notification with the path so Claude Code reads it as if the user had attached an image at the prompt.

## Shape

### Inbound

Telegram updates with photos:

```json
{
  "message": {
    "photo": [
      { "file_id": "...", "width": 90, "height": 67, "file_size": 1234 },
      { "file_id": "...", "width": 1280, "height": 960, "file_size": 89012 }
    ],
    "caption": "fix this"
  }
}
```

Telegram delivers multiple resolutions; we want the largest (last in the array). Path:

1. Detect `message.photo` (or `message.document` with image MIME) before the text check. Route via the existing rules: caption present → caption is the routing token (`/<slug> fix this` style) or quote-reply target. No caption → unmatched, agent decides.
2. `getFile` with the largest resolution's `file_id` to get the path; download from `https://api.telegram.org/file/bot<TOKEN>/<file_path>` to a daemon-controlled scratch dir (e.g. `~/.local/state/belfry/attachments/<unix-ts>-<slug>.jpg`, mode 0600).
3. Emit the MCP channel notification with both `content` (the caption text, if any) and `image_path` (absolute path on disk).

### MCP channel notification shape

The bundled `plugin:telegram` uses something like:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "fix this",
    "image_path": "/path/to/file.jpg"
  }
}
```

Verify exact shape via the bundled plugin source ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram), MIT) — the spoke (`bin/belfry-mcp.js`) currently emits `content` only; we'd add the optional `image_path` field.

### Cleanup

Attachments live until the session reads them — the path is opaque to belfry. Daemon should periodically GC `~/.local/state/belfry/attachments/` of files older than e.g. 24h, since the session has either consumed them or moved on.

### Document support

Telegram also delivers `message.document` for non-photo file uploads. v1 scope is photos only (`image/*`); documents need session-level handling that's currently out of scope (Claude Code can read text files but the path-injection contract for arbitrary docs is less clean).

## Inspiration

The bundled [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) telegram plugin (MIT, scoped LICENSE in the subdir) is the upstream reference for both `image_path` and `attachment_file_id` channel-notification fields. Belfry's spoke already mirrors that plugin's `notifications/claude/channel` shape; image support is a strict extension.

## Open questions

- **Size cap.** Telegram caps photos at 10 MB and documents at 50 MB. For belfry we probably cap at 4 MB to keep daemon memory bounded and respect mobile network reality.
- **EXIF / sensitive metadata.** Photos from a phone include GPS, device info. For belfry's single-user case this is fine (the user is sending to themselves), but worth a one-line note in Trust model that attached photos retain their EXIF.
- **Caption as routing token.** If caption is `/<slug> rest of caption`, route to slug with `rest of caption` as content + image_path. If caption is just `/<slug>`, route to slug with empty content + image_path. If quote-reply, use that slug + caption as content. If no caption and no quote-reply, the agent (#13) handles unmatched — could ask "send this image to which session?"

## Non-goals

- Not arbitrary documents. Photos only for v1.
- Not OCR. The image is forwarded as-is; Claude Code does the reading.
- Not image *out*. Sessions producing images aren't a thing in current Claude Code.
- Not attachment compression / re-encode. Forward what Telegram delivers.
