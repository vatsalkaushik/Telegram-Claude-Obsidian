# Obsidian Telegram Assistant

Capture daily notes, log meals, and query your Obsidian vault from Telegram,
powered by Claude Code.

The journal bot is fast capture: any message becomes a timestamped entry in
`Daily/YYYY-MM-DD.md`. The meals bot treats any message as a meal log and
stores generated meal notes in `Meals/`.

## Features

- Default capture to daily note with `[HH:MM]` timestamps
- Dedicated meals bot for macro estimates without typing `/meal`
- `/claude` assistant mode for search, questions, and actions
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

- `JOURNAL_TELEGRAM_BOT_TOKEN` (falls back to `TELEGRAM_BOT_TOKEN`)
- `MEAL_TELEGRAM_BOT_TOKEN` (optional; enables the dedicated meals bot)
- `TELEGRAM_ALLOWED_USERS`

Recommended:

- `VAULT_DIR` (path to your Obsidian vault)
- `VAULT_TIMEZONE` (default timezone, e.g., `Asia/Kolkata`)
- `DAILY_DIR` (defaults to `VAULT_DIR/Daily`)
- `MEALS_DIR` (defaults to `VAULT_DIR/Meals`)
- `LINKS_FILE` (defaults to `VAULT_DIR/Links.md`)
- `BOT_SETTINGS_FILE` (defaults to `VAULT_DIR/.bot/settings.json`)
- `ANTHROPIC_API_KEY` (for meal analysis)

## Commands

Journal bot:

- `/start` or `/help` - Show status and commands
- `/new` - Start a fresh Claude session
- `/stop` - Stop the current query
- `/status` - Show session status
- `/resume` - Resume last session
- `/claude` - Assistant mode (search/action)
- `/tz` - Set timezone (e.g., `/tz Asia/Kolkata`)

Meals bot:

- Plain text - Log a meal with macro estimates
- Photo - Analyze as a meal photo
- `/meal` - Optional explicit meal log
- `/tz` - Set timezone (shared with the journal bot)

## Vault Layout

```
vault/
├── CLAUDE.md
├── Daily/
│   └── 2026-01-15.md
├── Meals/
│   └── 2026-01-15.md
├── Links.md
├── .bot/
│   ├── settings.json
│   └── meals/
│       └── 2026-01-15.json
└── Attachments/
    └── 2026-01/
```

`Links.md` is a simple list of allowed auto-links (one `[[link]]` per line).
If you type `[[something]]` in a message, it is appended to `Links.md`.

## VPS Setup

See `docs/setup-vps.md` for Hetzner + Git sync instructions.

### Updating the Bot on VPS

After pushing changes from your local machine:

```bash
ssh claude@YOUR_SERVER_IP
cd /home/claude/bot
git pull
bun install
sudo systemctl restart claude-telegram
```

### Useful VPS Commands

```bash
# Check bot status
sudo systemctl status claude-telegram

# View live logs
sudo journalctl -u claude-telegram -f

# Restart bot
sudo systemctl restart claude-telegram

# Check disk usage
df -h
```

## Security

This bot runs Claude Code with permissions bypassed inside the allowed paths.
Set `ALLOWED_PATHS` carefully and review `docs/SECURITY.md` before deploying.
