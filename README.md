# Embed Bot 🔗

A Discord.js bot that turns Twitter/X, Instagram, TikTok, Bluesky, and Steam store links into real, working previews, automatically. Tweets get the full treatment: translated to English when needed, native video playback, and a custom card with the author, verified badge, post timestamp, quoted tweet, and sensitive-content warnings, all built without leaving Discord.

## How It Works

When someone posts a link to:

- **Twitter/X**: the bot fetches the tweet's data, builds a rich card, and posts it directly. If the tweet has video, the video itself is downloaded and re-uploaded as a native Discord attachment, so it plays inline with no dependency on any third-party embed page.
- **Instagram**: the bot scrapes the post's caption, author, and (if present) video via a third-party fixer and builds a card directly; photos aren't supported yet (see Notes).
- **Steam**: the bot fetches the store listing via Steam's own public API and builds a card with the title, description, developers/publisher, price, and header image.
- **TikTok**: `https://tiktok.com/@user/video/123` becomes `https://tnktok.com/@user/video/123`
- **Bluesky**: `https://bsky.app/profile/user/post/abc` becomes `https://fxbsky.app/profile/user/post/abc`

For all of these, the bot deletes the original message and reposts the result via a webhook styled with the original poster's name and avatar, so it still looks like it came from them.

Twitter/X links get extra handling beyond a simple domain swap:

- **Automatic translation.** If a tweet isn't in English, its translated text is shown alongside the original language it was detected in.
- **Native video attachments.** Tweet videos are downloaded and re-uploaded to Discord directly, picking the highest quality that fits the server's file size limit. If a video is too large even at the lowest available quality, the bot automatically falls back to a plain link so Discord's own preview still plays the video.
- **A custom card**, including the tweet author (with a verified badge if applicable), the post's relative timestamp, quoted-tweet context for quote tweets, reply/retweet/like counts, and a spoiler tag over sensitive media instead of showing it openly.
- **Multiple tweets in one message** are each handled individually, up to a few per message.
- A **download button** for the original video, and a **view original** button linking back to the tweet.

Steam links don't get video: trailers are only served as fragmented DASH/HLS streams (not a single downloadable file), so a static header image is used instead. The card also can't include a button that opens the game directly in the Steam app — Discord's Link buttons only accept `http(s)` URLs — so the `steam://` deep link is shown as plain text instead, alongside a normal "View on Steam" button that opens the store page in a browser.

Reddit and Threads links aren't handled. Their known embed fixers are currently broken, so they're left as-is rather than pointing at something unreliable.

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
   - `Attach Files` (required to upload tweet videos as native attachments)
   - `Add Reactions` (used to flag a message with a warning if something fails to post)
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

- ✅ Automatically detects Twitter/X, Instagram, TikTok, Bluesky, and Steam store links
- ✅ Translates non-English tweets, showing both the translation and the source language
- ✅ Downloads and re-uploads tweet videos as native Discord attachments for playback with no external dependency
- ✅ Falls back to a plain link automatically if a video is too large to attach, so playback is never lost
- ✅ Builds a custom card for tweets: author with verified badge, relative timestamp, quoted-tweet context, reply/retweet/like counts, and spoiler-tagged sensitive media
- ✅ Handles multiple tweets in a single message
- ✅ Deletes the original message and reposts via webhook as the original poster (their name and avatar)
- ✅ Self-heals if its webhook goes stale (for example after being kicked and re-invited), instead of failing until the bot is restarted
- ✅ Ignores bot messages and DMs
- ✅ Works in all text channels and threads

## Services Used

- **Twitter/X data and translation**: [api.fxtwitter.com](https://api.fxtwitter.com)
- **Instagram**: [instagram7.com](https://instagram7.com)
- **Steam**: [Steam's official public store API](https://store.steampowered.com)
- **TikTok**: [tnktok.com](https://tnktok.com)
- **Bluesky**: [fxbsky.app](https://fxbsky.app)

## Notes

- The bot only acts on messages containing a supported social media link
- Links are converted automatically; no commands needed
- Tweet videos are held in memory only long enough to re-upload them to Discord; nothing is written to disk or a database

## Troubleshooting

**Bot not responding?**
- Check that the bot has permission to send messages in the channel
- Verify your `DISCORD_TOKEN` is correct in `.env`
- Make sure the bot has the "Send Messages" permission

**Original message not being deleted?**
- The bot needs the "Manage Messages" permission in that channel

**Reposted message doesn't show the user's name/avatar?**
- The bot needs the "Manage Webhooks" permission in that channel so it can create/use a webhook

**Every link suddenly gets a warning reaction instead of a preview?**
- This usually means the bot's cached webhook went stale, most commonly after the bot was kicked and re-invited to the server. It should recover automatically on the next message; if it doesn't, restart the bot to force it to fetch a fresh webhook.

**Links not converting?**
- Ensure links are in standard format (e.g., `https://x.com/...`)
- Some shortened or non-standard URLs may not be detected

## Credits

Bot icon: [Halloween icons created by Tiemcuala - Flaticon](https://www.flaticon.com/packs/halloween-18118697)

## License

MIT
