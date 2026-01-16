# VPS Setup Guide for Claude Telegram Bot

A beginner-friendly guide to deploying the Obsidian Telegram Assistant on a Hetzner VPS.

---

## Prerequisites

Before starting, you'll need:

- A credit card for Hetzner (~€5/month)
- A GitHub account
- An Anthropic account (for Claude Code)
- An OpenAI account (for voice transcription, optional)

---

## Step 1: Create Your Telegram Bot

### 1.1 Talk to BotFather

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Choose a **display name** (e.g., "My Obsidian Assistant")
4. Choose a **username** (must end in `bot`, e.g., `my_obsidian_assistant_bot`)
5. BotFather will reply with your **Bot Token** — save this! It looks like:
   ```
   7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

### 1.2 Get Your Telegram User ID

1. Search for `@userinfobot` on Telegram
2. Send any message to it
3. It will reply with your **User ID** — save this! It's a number like `123456789`

This ID is used to restrict the bot to only respond to you.

### 1.3 (Optional) Disable Group Joins

To prevent others from adding your bot to groups:

1. Go back to `@BotFather`
2. Send `/mybots`
3. Select your bot
4. Go to **Bot Settings** → **Allow Groups?** → **Turn off**

---

## Step 2: Provision Hetzner VPS

### 2.1 Create Hetzner Account

1. Go to [hetzner.com](https://www.hetzner.com/)
2. Click **Cloud** in the top menu
3. Create an account and verify your email
4. Add a payment method

### 2.2 Generate SSH Key (on your Mac)

If you don't have an SSH key yet:

```bash
# Run this on your local Mac terminal
ssh-keygen -t ed25519 -C "your-email@example.com"

# Press Enter to accept default location (~/.ssh/id_ed25519)
# Enter a passphrase (recommended) or press Enter for none

# Copy your public key to clipboard
cat ~/.ssh/id_ed25519.pub | pbcopy
```

### 2.3 Create the Server

1. Go to [Hetzner Cloud Console](https://console.hetzner.cloud/)
2. Create a new project (e.g., "Claude Bot")
3. Click **Add Server**
4. Configure:
   - **Location**: Choose nearest to you (e.g., Frankfurt)
   - **Image**: Ubuntu 24.04
   - **Type**: Shared vCPU → CX22 (2 vCPU, 4GB RAM, €4.51/month)
   - **Networking**: Leave defaults (Public IPv4 + IPv6)
   - **SSH Keys**: Click "Add SSH Key", paste your public key from step 2.2
   - **Name**: `claude-bot` (or whatever you prefer)
5. Click **Create & Buy Now**
6. Note the **IP address** shown (e.g., `168.119.xxx.xxx`)

---

## Step 3: Initial Server Setup

### 3.1 Connect to Your Server

```bash
# From your Mac terminal
ssh root@YOUR_SERVER_IP
```

If it asks about fingerprint, type `yes` and press Enter.

### 3.2 Create a Non-Root User

Running as root is a security risk. Create a dedicated user:

```bash
# Create user named 'claude'
adduser claude
# Enter a password when prompted, press Enter for other fields

# Give sudo access
usermod -aG sudo claude

# Copy SSH key to new user
mkdir -p /home/claude/.ssh
cp ~/.ssh/authorized_keys /home/claude/.ssh/
chown -R claude:claude /home/claude/.ssh
chmod 700 /home/claude/.ssh
chmod 600 /home/claude/.ssh/authorized_keys

# Exit and reconnect as claude
exit
```

### 3.3 Reconnect as Claude User

```bash
ssh claude@YOUR_SERVER_IP
```

### 3.4 Install System Dependencies

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install essentials
sudo apt install -y git curl unzip poppler-utils

# Install Bun (JavaScript runtime)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Verify Bun installed
bun --version
```

### 3.5 Install Node.js (needed for Claude Code)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version
npm --version
```

---

## Step 4: Install Claude Code CLI

### 4.1 Install the CLI

```bash
npm install -g @anthropic-ai/claude-code
```

### 4.2 Authenticate

```bash
claude login
```

This will print a URL. Copy it, open it in your browser (on your Mac/phone), log in with your Anthropic account, and authorize. Then paste the code back into the terminal.

### 4.3 Verify

```bash
claude --version
```

**Alternative: API Key Auth**

If you prefer not to use `claude login`, you can set an API key instead. Add `ANTHROPIC_API_KEY=sk-ant-...` to your `.env` file in Step 7. This is more reliable for unattended servers.

---

## Step 5: Set Up Your Obsidian Vault with Git

### 5.1 Create a Private GitHub Repository

1. Go to [github.com/new](https://github.com/new)
2. Name it (e.g., `obsidian-vault`)
3. Set to **Private**
4. Click **Create repository**

### 5.2 Set Up SSH Key for GitHub (on VPS)

```bash
# Generate SSH key on the VPS
ssh-keygen -t ed25519 -C "claude-bot"
# Press Enter for all prompts (no passphrase needed for bot)

# Display the public key
cat ~/.ssh/id_ed25519.pub
```

Copy this key, then:

1. Go to [GitHub SSH Keys](https://github.com/settings/keys)
2. Click **New SSH key**
3. Title: "Claude Bot VPS"
4. Paste the key
5. Click **Add SSH key**

### 5.3 Clone Your Vault

```bash
cd /home/claude

# Clone (replace with your repo URL)
git clone git@github.com:YOUR_USERNAME/obsidian-vault.git vault

cd vault

# Configure git identity
git config user.email "bot@yourdomain.com"
git config user.name "Claude Bot"
```

**If you have an existing vault on your Mac**, push it to GitHub first:

```bash
# On your Mac, in your vault folder:
cd /path/to/your/vault
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/obsidian-vault.git
git push -u origin main
```

---

## Step 6: Create Vault Sync Script

This script auto-commits and pushes vault changes every few minutes.

### 6.1 Create the Script

```bash
mkdir -p ~/scripts ~/logs

cat > ~/scripts/vault-sync.sh << 'EOF'
#!/bin/bash
set -euo pipefail

# Prevent multiple instances running at once
LOCKFILE="/home/claude/scripts/vault-sync.lock"
exec 200>"$LOCKFILE"
flock -n 200 || exit 0

cd /home/claude/vault

# Pull any remote changes first
git pull --rebase origin main 2>/dev/null || true

# If there are local changes, commit and push
if [[ -n $(git status --porcelain) ]]; then
    git add -A
    git commit -m "Auto-sync: $(date '+%Y-%m-%d %H:%M')" || true
    git push origin main || true
fi
EOF

chmod +x ~/scripts/vault-sync.sh
```

### 6.2 Test It

```bash
~/scripts/vault-sync.sh
```

### 6.3 Add to Cron (runs every 3 minutes)

```bash
crontab -e
# If asked, choose nano (option 1)
```

Add this line at the bottom:

```
*/3 * * * * /home/claude/scripts/vault-sync.sh >> /home/claude/logs/vault-sync.log 2>&1
```

Save and exit (Ctrl+X, then Y, then Enter in nano).

---

## Step 7: Deploy the Telegram Bot

### 7.1 Clone the Bot Repository

```bash
cd /home/claude

# Clone the bot (replace with actual repo URL)
git clone https://github.com/YOUR_USERNAME/claude-telegram-bot.git bot
cd bot

# Install dependencies
bun install
```

### 7.2 Create Environment File

```bash
cp .env.example .env
nano .env
```

Fill in these values:

```bash
# Required
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_ALLOWED_USERS=123456789

# Vault settings
VAULT_DIR=/home/claude/vault
VAULT_TIMEZONE=Europe/London

# Security
ALLOWED_PATHS=/home/claude/vault,/tmp

# Optional: Voice transcription (get key from platform.openai.com)
OPENAI_API_KEY=sk-...

# Optional: Use API key instead of claude login
# ANTHROPIC_API_KEY=sk-ant-...
```

Replace:
- `TELEGRAM_BOT_TOKEN` with your bot token from Step 1
- `TELEGRAM_ALLOWED_USERS` with your Telegram user ID from Step 1
- `VAULT_TIMEZONE` with your timezone (e.g., `Asia/Kolkata`, `America/New_York`, `Europe/Berlin`)
- `OPENAI_API_KEY` with your OpenAI key (optional, for voice notes)

Save and exit (Ctrl+X, Y, Enter).

### 7.3 Secure the Environment File

```bash
chmod 600 .env
```

### 7.4 Test the Bot

```bash
bun run src/index.ts
```

Open Telegram, find your bot, and send `/start`. If it responds, it's working!

Press Ctrl+C to stop the test.

---

## Step 8: Create Systemd Service

This keeps the bot running 24/7 and auto-restarts on crashes.

### 8.1 Create Service File

```bash
sudo tee /etc/systemd/system/claude-telegram.service << 'EOF'
[Unit]
Description=Obsidian Telegram Assistant
After=network.target

[Service]
Type=simple
User=claude
WorkingDirectory=/home/claude/bot
ExecStart=/home/claude/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=10
Environment=PATH=/home/claude/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF
```

### 8.2 Enable and Start

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable auto-start on boot
sudo systemctl enable claude-telegram

# Start the service
sudo systemctl start claude-telegram

# Check status
sudo systemctl status claude-telegram
```

You should see "active (running)" in green.

---

## Step 9: Set Up Local Sync (Mac/PC)

### 9.1 Install Obsidian Git Plugin

1. Open Obsidian
2. Go to **Settings** → **Community plugins**
3. Turn off **Restricted mode**
4. Click **Browse** and search for "Obsidian Git"
5. Install and enable it

### 9.2 Configure the Plugin

Go to **Settings** → **Obsidian Git**:

- **Auto pull interval**: 5 minutes
- **Auto push after commit**: enabled
- **Pull updates on startup**: enabled
- **Commit message**: `Local: {{date}}`

---

## Step 10: Set Up Mobile Sync (iOS)

### 10.1 Install Working Copy

1. Download [Working Copy](https://apps.apple.com/app/working-copy/id896694807) from App Store
2. Purchase the pro version (one-time ~$20) or use free with limitations

### 10.2 Clone Your Vault

1. Open Working Copy
2. Tap **+** → **Clone repository**
3. Sign in to GitHub and select your vault repo
4. Wait for clone to complete

### 10.3 Open in Obsidian

1. Open Obsidian on iOS
2. Tap **Open folder as vault**
3. Navigate to Working Copy's folder and select your vault

### 10.4 Set Up Auto-Pull (Optional)

Create an iOS Shortcut that runs when you open Obsidian:

1. Open **Shortcuts** app
2. Create new shortcut
3. Add action: **Working Copy** → **Pull Repository**
4. Select your vault repo
5. Add automation: When Obsidian opens → Run this shortcut

---

## Maintenance Commands

### View Bot Logs

```bash
# Live logs
sudo journalctl -u claude-telegram -f

# Last 100 lines
sudo journalctl -u claude-telegram -n 100
```

### Restart Bot

```bash
sudo systemctl restart claude-telegram
```

### Check Bot Status

```bash
sudo systemctl status claude-telegram
```

### Update Bot Code

```bash
cd /home/claude/bot
git pull
bun install
sudo systemctl restart claude-telegram
```

### Re-authenticate Claude Code

If Claude stops working, re-authenticate:

```bash
claude login
sudo systemctl restart claude-telegram
```

### View Sync Logs

```bash
tail -f /home/claude/logs/vault-sync.log
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot not responding | `sudo systemctl status claude-telegram` — check for errors |
| "Unauthorized" error | Verify `TELEGRAM_ALLOWED_USERS` matches your user ID |
| Voice notes not working | Check `OPENAI_API_KEY` is set correctly |
| Sync conflicts | Check `~/logs/vault-sync.log`, manually resolve in Git |
| Claude auth expired | Run `claude login` and restart service |
| Can't SSH to server | Check your IP hasn't changed; verify SSH key |
| Permission denied on .env | Run `chmod 600 .env` |

---

## Security Checklist

- [ ] Bot token is not committed to Git
- [ ] `.env` file has restricted permissions (`chmod 600 .env`)
- [ ] Only your Telegram user ID is in `TELEGRAM_ALLOWED_USERS`
- [ ] SSH password authentication is disabled (key-only)
- [ ] Regular `apt update && apt upgrade` for security patches
- [ ] `ALLOWED_PATHS` is minimal (vault + /tmp only)

---

## Cost Summary

| Item | Cost |
|------|------|
| Hetzner VPS (CX22) | ~€4.50/month |
| GitHub Private Repos | Free |
| Claude Code (with subscription) | $0 additional |
| OpenAI Whisper API | ~$0.50-2/month |
| Working Copy (iOS, one-time) | ~$20 |
| **Total** | **~€5/month + one-time iOS cost** |
