# Obsidian Telegram Assistant

Capture daily notes and query your Obsidian vault from Telegram, powered by Claude Code.

Default behavior is fast capture: any message becomes a timestamped entry in
`Daily/YYYY-MM-DD.md`. Use `/claude` only when you want assistant mode.

## Features

- Default capture to daily note with `[HH:MM]` timestamps
- `/claude` assistant mode for search, questions, and actions
- Voice transcription via OpenAI (optional)
- Photo/document capture saved to `Attachments/` with links in the daily note
- Auto-linking from `Links.md` (exact match only)
- `/tz` command to update timezone while traveling

## Quick Start

```bash
bun install
cp .env.example .env
# Edit .env with your credentials and paths
bun run src/index.ts
```

## Environment

Required:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USERS`

Recommended:

- `VAULT_DIR` (path to your Obsidian vault)
- `VAULT_TIMEZONE` (default timezone, e.g., `Asia/Kolkata`)
- `LINKS_FILE` (defaults to `VAULT_DIR/Links.md`)
- `BOT_SETTINGS_FILE` (defaults to `VAULT_DIR/.bot/settings.json`)
- `OPENAI_API_KEY` (for voice transcription)

## Commands

- `/start` - Show status and commands
- `/new` - Start a fresh Claude session
- `/stop` - Stop the current query
- `/status` - Show session status
- `/resume` - Resume last session
- `/claude` - Assistant mode (search/action)
- `/tz` - Set timezone (e.g., `/tz Asia/Kolkata`)

Tip: use `!` prefix to interrupt a running query.

## Vault Layout

```
vault/
├── CLAUDE.md
├── Daily/
│   └── 2026-01-15.md
├── Links.md
├── .bot/
│   └── settings.json
└── Attachments/
    └── 2026-01/
```

`Links.md` is a simple list of allowed auto-links (one `[[link]]` per line).
If you type `[[something]]` in a message, it is appended to `Links.md`.

## VPS Setup

See `docs/setup-vps.md` for Hetzner + Git sync instructions.

## Security

This bot runs Claude Code with permissions bypassed inside the allowed paths.
Set `ALLOWED_PATHS` carefully and review `SECURITY.md` before deploying.
