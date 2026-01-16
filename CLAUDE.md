# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Run TypeScript type checking
bun install        # Install dependencies
```

## Architecture

This is a Telegram bot that captures Obsidian daily notes and routes `/claude` queries to Claude Code. Built with Bun and grammY.

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → (capture or /claude) → Vault append or Claude session → Audit log
```

### Key Modules

- **`src/index.ts`** - Entry point, registers handlers, starts polling
- **`src/config.ts`** - Environment parsing, safety prompts, vault paths
- **`src/session.ts`** - `ClaudeSession` class wrapping Agent SDK with streaming, session persistence
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety checks
- **`src/vault.ts`** - Daily note append, auto-linking, timezone settings
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status formatting
- **`src/utils.ts`** - Audit logging, voice transcription (OpenAI), typing indicators
- **`src/types.ts`** - Shared TypeScript types

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** - `/start`, `/new`, `/stop`, `/status`, `/resume`, `/claude`, `/tz`
- **`assistant.ts`** - `/claude` handler with streaming responses
- **`text.ts`** - Default capture to daily note
- **`voice.ts`** - Voice→text via OpenAI, append to daily note
- **`photo.ts`** - Save photos to Attachments and link in daily note
- **`document.ts`** - Save documents to Attachments, append link and excerpt
- **`streaming.ts`** - Shared `StreamingState` and status callback factory

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `VAULT_DIR` - Obsidian vault root
- `VAULT_TIMEZONE` - Default timezone for daily notes
- `LINKS_FILE` - Auto-link list (one per line)
- `BOT_SETTINGS_FILE` - Runtime settings (timezone override)
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers can be defined in `mcp-config.ts` (optional).

### Runtime Files

- `/tmp/claude-telegram-session.json` - Session persistence for `/resume`
- `/tmp/telegram-bot/` - Temp voice downloads
- `/tmp/claude-telegram-audit.log` - Audit log

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter

**Streaming pattern**: `/claude` uses `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart the bot so changes can be tested (`bun run start`).

## Standalone Build

The bot can be compiled to a standalone binary with `bun build --compile`. This is used by the ClaudeBot macOS app wrapper.

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package (to avoid bundling issues):

```bash
brew install poppler  # Provides pdftotext
```

### PATH Requirements

When running as a standalone binary (especially from a macOS app), the PATH may not include Homebrew. The launcher must ensure PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` won't be found and PDF parsing will fail silently with an error message.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.
