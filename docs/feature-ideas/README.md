# Feature ideas

Drafted GitHub issue bodies for ideas that came out of the 2026-05-09
competitive-research sweep. None are filed yet; they're checked in here so
they survive the session and can be filed later with one command.

Each `.md` here is shaped like the existing belfry issues (#13, #14):
motivation, shape, inspiration with attribution, open questions, non-goals.
The first line is an HTML comment of the form `<!-- title: ... -->` — the
file-all script reads this for the issue title.

To file them all:

```sh
gh auth login          # if you haven't already
./file-all.sh --dry-run   # preview
./file-all.sh             # actually file
```

To file one:

```sh
gh issue create --repo harteWired/belfry \
  --title "<the title from the file's HTML comment>" \
  --body-file <name>.md
```

Once filed, you can either delete the `.md` (history is on GitHub) or leave
it as a checked-in design note. The `.md` files are not consumed by the
daemon at runtime — they're docs.

## Index

| File | Title | Inspirations |
|---|---|---|
| `inline-approval-buttons.md` | Inline approval buttons for permission prompts | jsayubi/ccgram (MIT) |
| `voice-notes-whisper.md` | Voice notes inbound — Whisper transcription on Telegram audio | six-ddc/ccbot (MIT) |
| `forum-topics-routing.md` | Optional forum-topic routing per slug | six-ddc/ccbot (MIT), kidandcat/ccc (MIT) |
| `image-attachments.md` | Image attachments inbound — pass-through to session as image_path | anthropics/claude-plugins-official telegram plugin (MIT, scoped LICENSE) |
| `resume-from-phone.md` | `/resume` — pick from recent sessions and reattach from the phone | six-ddc/ccbot (MIT) |

## License hygiene

Every named project above ships an OSI-approved license. Other projects
came up during the research sweep — some claim a license in their README
but ship no `LICENSE` file, and some ship neither. Those are deliberately
unnamed in the issue bodies; if a feature here drew real implementation
inspiration from one of those repos, that lineage is genuinely missing from
the attribution and should be reconstructed before the feature ships.
