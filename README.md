# Embed Bot 🔗

A lightweight Discord.js bot that automatically converts Twitter/X and Instagram links to proxy URLs for better embeds in Discord.

## How It Works

When someone posts a link to:
- **Twitter/X**: `https://x.com/user/status/123` → `https://fixupx.com/user/status/123`
- **Instagram**: `https://instagram.com/p/ABC123/` → `https://kkinstagram.com/p/ABC123/`

The bot deletes the original message and reposts the converted link(s) via a webhook styled with the original poster's name and avatar, as a plain-text message (no bot embed), so Discord's own link unfurling generates the preview from the proxy service.

## Setup

### 1. Prerequisites
- Node.js 16.6.0 or higher
- A Discord bot token (from Discord Developer Portal)

### 2. Installation

```bash
npm install
```

### 3. Configure Environment

Copy `.env.example` to `.env` and add your bot token:

```bash
cp .env.example .env
```

Edit `.env`:
```
DISCORD_TOKEN=your_actual_bot_token_here
```

### 4. Invite Bot to Your Server

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application
3. Go to OAuth2 → URL Generator
4. Select scopes: `bot`
5. Select permissions:
   - `Send Messages`
   - `Send Messages in Threads`
   - `Read Message History`
   - `Manage Messages` (required to delete the original user message)
   - `Manage Webhooks` (required to post as the original user via webhook)
6. Copy the generated URL and open it to invite the bot

### 5. Run the Bot

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Features

- ✅ Automatically detects Twitter/X links
- ✅ Automatically detects Instagram links
- ✅ Converts links to proxy services for better embeds
- ✅ Deletes the original message and reposts via webhook as the original poster (their name + avatar), as plain text (no bot embed)
- ✅ Ignores bot messages
- ✅ Works in all text channels

## Proxy Services Used

- **Twitter/X**: [fixupx.com](https://fixupx.com) - Fixes Twitter embed issues
- **Instagram**: [kkinstagram.com](https://kkinstagram.com) - Improves Instagram embeds

## Notes

- The bot only replies to messages containing social media links
- The bot ignores its own messages and DMs
- Links are converted automatically; no commands needed
- The embed response shows which platform(s) were detected

## Troubleshooting

**Bot not responding?**
- Check that the bot has permission to send messages in the channel
- Verify your `DISCORD_TOKEN` is correct in `.env`
- Make sure the bot has the "Send Messages" permission

**Original message not being deleted?**
- The bot needs the "Manage Messages" permission in that channel

**Reposted message doesn't show the user's name/avatar?**
- The bot needs the "Manage Webhooks" permission in that channel so it can create/use a webhook

**Links not converting?**
- Ensure links are in standard format (e.g., `https://x.com/...`)
- Some shortened or non-standard URLs may not be detected

## License

MIT
