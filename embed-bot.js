const {
  Client,
  GatewayIntentBits,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  AttachmentBuilder,
  MessageFlags,
  RESTJSONErrorCodes,
} = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Each rule finds links for one platform and rewrites them to an embed-fixing proxy domain.
// Twitter/X gets extra treatment (translation, video, rich cards) handled separately below;
// every other platform here is just a plain domain swap relying on Discord's native unfurl.
// (Reddit and Threads are deliberately not included: their known fixers — rxddit.com and
// fixthreads.net — were tested live and are currently down/broken.)
const LINK_RULES = [
  {
    name: 'twitter',
    regex: /(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/(\S+)/gi,
    convert: (url) => url.replace(/https?:\/\/(www\.)?(twitter\.com|x\.com)/, 'https://fixupx.com'),
  },
  {
    name: 'instagram',
    regex: /(https?:\/\/)?(www\.)?instagram\.com\/(\S+)/gi,
    convert: (url) => url.replace(/https?:\/\/(www\.)?instagram\.com/, 'https://kkinstagram.com'),
  },
  {
    name: 'tiktok',
    regex: /(https?:\/\/)?(www\.)?tiktok\.com\/(\S+)/gi,
    convert: (url) => url.replace(/https?:\/\/(www\.)?tiktok\.com/, 'https://vt.tnktok.com'),
  },
  {
    name: 'tiktok-mobile',
    regex: /(https?:\/\/)?(www\.)?vt.tiktok\.com\/(\S+)/gi,
    convert: (url) => url.replace(/https?:\/\/(www\.)?vt.tiktok\.com/, 'https://vt.tnktok.com'),
  },
  {
    name: 'bluesky',
    regex: /(https?:\/\/)?(www\.)?bsky\.app\/(\S+)/gi,
    convert: (url) => url.replace(/https?:\/\/(www\.)?bsky\.app/, 'https://fxbsky.app'),
  },
];

const TWITTER_RULE = LINK_RULES.find((rule) => rule.name === 'twitter');

// Finds every social link in a message. Twitter/X matches are also returned separately (still
// in their original, unconverted form) since those need async per-tweet handling (translation,
// video, rich cards) before the final message can be built.
function findLinks(content) {
  const matchesByRule = LINK_RULES.map((rule) => ({
    rule,
    matches: [...content.matchAll(rule.regex)].map((m) => m[0]),
  }));

  return {
    matchesByRule,
    twitterMatches: matchesByRule.find((m) => m.rule.name === 'twitter').matches,
    modified: matchesByRule.some((m) => m.matches.length > 0),
  };
}

const EMPTY_TWEET_INFO = {
  text: '',
  translation: null,
  video: null,
  photos: [],
  author: null,
  stats: { likes: 0, retweets: 0, replies: 0 },
  tweetUrl: null,
  quote: null,
  createdTimestamp: null,
  sensitive: false,
  communityNote: null,
};

// Pulls tweet info via the fxtwitter API (fixupx.com's backend): the tweet text, an English
// translation (fxtwitter translates server-side and only returns a `translation` field when
// the tweet isn't already in English), video variants (for picking one small enough to attach
// natively), photos, author, stats, and quoted-tweet text if this tweet quotes another one.
async function getTweetInfo(url) {
  const idMatch = url.match(/status\/(\d+)/);
  if (!idMatch) return EMPTY_TWEET_INFO;

  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${idMatch[1]}/en`);
    if (!res.ok) return EMPTY_TWEET_INFO;

    const data = await res.json();
    const tweet = data?.tweet;
    if (!tweet) return EMPTY_TWEET_INFO;

    const video = tweet.media?.videos?.[0] ?? null;
    const mp4Variants = (video?.formats ?? [])
      .filter((f) => f.container === 'mp4' && typeof f.bitrate === 'number')
      .sort((a, b) => b.bitrate - a.bitrate);

    return {
      text: tweet.text ?? '',
      translation: tweet.translation
        ? { text: tweet.translation.text, sourceLang: tweet.translation.source_lang_en }
        : null,
      video: video ? { duration: video.duration ?? null, variants: mp4Variants, bestUrl: video.url } : null,
      photos: tweet.media?.photos?.map((p) => p.url) ?? [],
      author: tweet.author
        ? {
            name: tweet.author.name,
            screenName: tweet.author.screen_name,
            avatarUrl: tweet.author.avatar_url,
            verified: tweet.author.verification?.verified ?? false,
          }
        : null,
      stats: { likes: tweet.likes ?? 0, retweets: tweet.retweets ?? 0, replies: tweet.replies ?? 0 },
      tweetUrl: tweet.url ?? null,
      quote:
        tweet.quote && tweet.quote.text
          ? {
              text: tweet.quote.text,
              author: tweet.quote.author
                ? { name: tweet.quote.author.name, screenName: tweet.quote.author.screen_name }
                : null,
            }
          : null,
      createdTimestamp: tweet.created_timestamp ?? null,
      // possibly_sensitive is what the API calls it; not currently confirmed to ever be
      // populated with real community-note content (see comment on buildTweetContainer).
      sensitive: tweet.possibly_sensitive ?? false,
      communityNote: tweet.community_note?.text ?? null,
    };
  } catch {
    return EMPTY_TWEET_INFO;
  }
}

// Only the first few tweet links in a message get the API-driven treatment — bounds latency
// and API load if someone pastes a wall of links. Extras beyond this still get a working
// "View Original" link (via tweetUrl) in the card, just with no author/text/media/translation.
const MAX_TWEETS_TO_ENRICH = 4;

// Fetches tweet info for each Twitter/X match in parallel, deduplicating identical URLs so
// the same tweet posted twice in one message only costs one API call.
async function getTweetInfoForMatches(twitterMatches) {
  const cache = new Map();
  const pending = twitterMatches.map((url, index) => {
    if (index >= MAX_TWEETS_TO_ENRICH) return { ...EMPTY_TWEET_INFO, tweetUrl: url };
    if (!cache.has(url)) cache.set(url, getTweetInfo(url));
    return cache.get(url);
  });

  return Promise.all(pending);
}

// --- Video-attachment sizing ---
//
// Discord's exact free-tier attachment limit is inconsistently documented across sources
// (reports range from 10MB to 25MB), so this defaults conservatively for unboosted/tier-1
// servers; only the higher boosted tiers (2 and 3), which are much less ambiguous, get a
// bigger budget. Every figure here has a safety margin built in, and a failed upload still
// falls back gracefully (see the messageCreate handler's send/retry logic) even if a real
// limit turns out lower than expected.
const BYTES_PER_MB = 1024 * 1024;
function getAttachmentSizeCap(guild) {
  switch (guild?.premiumTier) {
    case 3:
      return 90 * BYTES_PER_MB;
    case 2:
      return 45 * BYTES_PER_MB;
    default:
      return 8 * BYTES_PER_MB;
  }
}

// Picks the highest-bitrate mp4 variant whose estimated size fits under the cap. Variants are
// already sorted highest-bitrate-first, so the first one that fits is the best available.
function pickVideoVariant(video, maxBytes) {
  if (!video?.variants?.length || !video.duration) return null;
  for (const variant of video.variants) {
    const estimatedBytes = (variant.bitrate * video.duration) / 8;
    if (estimatedBytes <= maxBytes) return variant;
  }
  return null;
}

// Downloads a video and wraps it as a Discord attachment, re-checking the real size against
// the cap in case the bitrate-based estimate undershot it.
async function downloadVideoAttachment(url, maxBytes, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) return null;
    return new AttachmentBuilder(buffer, { name: filename });
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const compactNumberFormatter = new Intl.NumberFormat('en', { notation: 'compact' });
function formatCompact(n) {
  return compactNumberFormatter.format(n ?? 0);
}

// --- Custom Components v2 card (replaces the fixupx.com native embed) ---

// One Container per tweet: author (name/avatar), body text (translated text takes priority
// over the original), quoted-tweet text if this is a quote-tweet, media (a native video
// attachment or the tweet's photos), stats, and action buttons. `videoAttachment` is passed
// in separately (rather than looked up from `info`) because it's already been downloaded by
// the time this runs, and referencing an attachment by filename is how Components v2 embeds
// an uploaded file into a MediaGallery.
function buildTweetContainer(info, videoAttachment) {
  const container = new ContainerBuilder().setAccentColor(0x1d9bf0);
  const isEnriched = Boolean(info.author);

  if (info.author) {
    const profileUrl = `https://x.com/${info.author.screenName}`;
    const verifiedBadge = info.author.verified ? ' ✅' : '';
    const authorLine = `[**${info.author.name}**${verifiedBadge} (@${info.author.screenName})](${profileUrl})`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(authorLine));
  }

  const bodyText = info.translation ? info.translation.text : info.text;
  if (bodyText) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyText));
  }
  if (info.translation) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 🌐 Translated from ${info.translation.sourceLang}`)
    );
  }

  // communityNote is wired up defensively: as of writing, the fxtwitter API doesn't appear to
  // ever actually populate this field (see FxEmbed issue #776), so this is future-proofing more
  // than a working feature today — it'll start showing up automatically if that ever changes.
  if (info.communityNote) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`📝 **Community Note:** ${info.communityNote}`)
    );
  }

  if (info.quote) {
    container.addSeparatorComponents(new SeparatorBuilder());
    const quoteHeader = info.quote.author
      ? `**Quoting [@${info.quote.author.screenName}](https://x.com/${info.quote.author.screenName}):**`
      : '**Quoting:**';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${quoteHeader}\n${info.quote.text}`));
  }

  // Sensitive media is spoiler-tagged (blurred, click-to-reveal) rather than shown openly,
  // matching how X itself gates flagged content instead of just displaying it.
  if (videoAttachment) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${videoAttachment.name}`).setSpoiler(info.sensitive)
      )
    );
  } else if (info.photos.length) {
    const gallery = new MediaGalleryBuilder();
    for (const photoUrl of info.photos.slice(0, 4)) {
      gallery.addItems(new MediaGalleryItemBuilder().setURL(photoUrl).setSpoiler(info.sensitive));
    }
    container.addMediaGalleryComponents(gallery);
  }

  if (isEnriched) {
    container.addSeparatorComponents(new SeparatorBuilder());
    const timestamp = info.createdTimestamp ? `<t:${info.createdTimestamp}:R> · ` : '';
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${timestamp}💬 ${formatCompact(info.stats.replies)}  🔁 ${formatCompact(info.stats.retweets)}  ❤️ ${formatCompact(info.stats.likes)}`
      )
    );
  }

  const buttons = [];
  if (info.tweetUrl) {
    buttons.push(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(info.tweetUrl).setEmoji('🔗').setLabel('View Original')
    );
  }
  if (info.video?.bestUrl) {
    const durationLabel = formatDuration(info.video.duration);
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(info.video.bestUrl)
        .setEmoji('⬇️')
        .setLabel(durationLabel ? `Download (${durationLabel})` : 'Download')
    );
  }
  if (buttons.length) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
  }

  return container;
}

// Builds one container per tweet, downloading a video attachment where needed. Returns
// { ok: false } the moment any tweet's video can't fit under the size cap (even at its lowest
// available quality, or the real download turned out bigger than estimated) — callers should
// fall back to the plain-link approach for the whole message in that case, since a
// Components-v2 message can't be partially built.
async function buildTweetCards(tweetInfos, sizeCap) {
  const containers = [];
  const files = [];

  for (const [i, info] of tweetInfos.entries()) {
    let videoAttachment = null;

    if (info.video) {
      const variant = pickVideoVariant(info.video, sizeCap);
      if (!variant) return { ok: false };

      videoAttachment = await downloadVideoAttachment(variant.url, sizeCap, `tweet-video-${i}.mp4`);
      if (!videoAttachment) return { ok: false };

      files.push(videoAttachment);
    }

    containers.push(buildTweetContainer(info, videoAttachment));
  }

  return { ok: true, containers, files };
}

// Non-Twitter links (already domain-swapped) can't be mixed into a Components-v2 message's
// `content` field, so they're shown as a plain text block in their own small container.
function buildExtraLinksContainer(matchesByRule) {
  const links = matchesByRule
    .filter(({ rule }) => rule.name !== 'twitter')
    .flatMap(({ rule, matches }) => matches.map((raw) => rule.convert(raw)));

  if (!links.length) return null;
  return new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(links.join('\n')));
}

// --- Fallback path: today's plain-link + native-unfurl behavior ---
// Used for the whole message whenever any tweet's video can't be brought in as an attachment
// (see buildTweetCards), so video playback is never sacrificed even if our own card can't be
// built. This is deliberately the same approach the bot used before the Components-v2 card
// existed: Discord needs to see the raw link to unfurl a native, playable video itself.

const DISCORD_CONTENT_LIMIT = 2000;
const MAX_TRANSLATION_CHARS = 1200;

function formatTranslationBlock(translation) {
  const text =
    translation.text.length > MAX_TRANSLATION_CHARS
      ? `${translation.text.slice(0, MAX_TRANSLATION_CHARS)}…`
      : translation.text;

  return [`> 🌐 **Translated from ${translation.sourceLang}**`, ...text.split('\n').map((line) => `> ${line}`)].join(
    '\n'
  );
}

function buildTranslationEmbeds({ translation, author, photos, stats, tweetUrl, createdTimestamp, communityNote }) {
  let description = translation.text;
  if (communityNote) description += `\n\n📝 **Community Note:** ${communityNote}`;

  const main = new EmbedBuilder()
    .setColor(0x1d9bf0)
    .setDescription(description)
    .setFooter({ text: `🌐 Translated from ${translation.sourceLang} · 💬 ${stats.replies}  🔁 ${stats.retweets}  ❤️ ${stats.likes}` });

  if (tweetUrl) main.setURL(tweetUrl);
  if (createdTimestamp) main.setTimestamp(createdTimestamp * 1000);
  if (author) {
    main.setAuthor({
      name: `${author.name}${author.verified ? ' ✅' : ''} (@${author.screenName})`,
      iconURL: author.avatarUrl ?? undefined,
      url: author.screenName ? `https://x.com/${author.screenName}` : undefined,
    });
  }
  // Legacy Embeds don't support spoiler-tagging images, unlike the Components-v2 card, so
  // sensitive photos here are shown openly — a known, accepted gap for this rare fallback path.
  if (photos[0]) main.setImage(photos[0]);

  const galleryEmbeds = photos.slice(1, 4).map((photoUrl) => new EmbedBuilder().setURL(tweetUrl ?? undefined).setImage(photoUrl));

  return [main, ...galleryEmbeds];
}

function buildFallbackContent(content, tweetInfos) {
  const embeds = [];
  const downloadUrls = [];
  let index = 0;

  let result = content.replace(TWITTER_RULE.regex, (match) => {
    const info = tweetInfos[index++] ?? EMPTY_TWEET_INFO;
    if (info.video?.bestUrl) downloadUrls.push(info.video.bestUrl);

    const usesRichEmbed = Boolean(info.translation) && !info.video;
    if (usesRichEmbed) {
      embeds.push(...buildTranslationEmbeds(info));
      return '';
    }

    const link = TWITTER_RULE.convert(match);
    return info.translation ? `${formatTranslationBlock(info.translation)}\n${link}` : link;
  });

  result = result.replace(/\n{3,}/g, '\n\n').trim();
  if (result.length > DISCORD_CONTENT_LIMIT) {
    result = `${result.slice(0, DISCORD_CONTENT_LIMIT - 1)}…`;
  }

  return { content: result, embeds: embeds.slice(0, 10), downloadUrls: downloadUrls.slice(0, 5) };
}

function buildFallbackPayload(rewrittenContent, tweetInfos) {
  const { content, embeds, downloadUrls } = buildFallbackContent(rewrittenContent, tweetInfos);
  const components = downloadUrls.map((url, i) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(url)
        .setEmoji('⬇️')
        .setLabel(downloadUrls.length > 1 ? `Download (${i + 1})` : 'Download')
    )
  );

  return { content: content || undefined, embeds, components };
}

client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  client.user.setActivity('for social media links', { type: 'WATCHING' });
});

// One webhook per channel, reused so we don't create a new one for every message
const webhookCache = new Map();

async function getWebhook(channel) {
  if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);

  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find((wh) => wh.owner?.id === client.user.id);

  if (!webhook) {
    webhook = await channel.createWebhook({ name: 'Embed Bot Relay' });
  }

  webhookCache.set(channel.id, webhook);
  return webhook;
}

// Sends through the channel's cached webhook, and self-heals if that webhook has gone stale
// (e.g. the bot was kicked and re-invited, or someone deleted the webhook manually) — Discord
// then rejects the send with "Unknown Webhook" (10015). Dropping the cache entry and fetching
// a fresh webhook recovers automatically instead of every message failing until a manual
// restart clears the in-memory cache.
async function sendViaWebhook(channel, payload) {
  const webhook = await getWebhook(channel);
  try {
    return await webhook.send(payload);
  } catch (error) {
    if (error.code !== RESTJSONErrorCodes.UnknownWebhook) throw error;

    console.error('Cached webhook is stale, refreshing and retrying once:', error);
    webhookCache.delete(channel.id);
    const freshWebhook = await getWebhook(channel);
    return freshWebhook.send(payload);
  }
}

client.on('messageCreate', async (message) => {
  // Ignore bot messages and DMs
  if (message.author.bot) return;
  if (message.channel.type === ChannelType.DM) return;

  const { matchesByRule, twitterMatches, modified } = findLinks(message.content);

  // Only act if we found and modified social media links
  if (modified) {
    const tweetInfos = await getTweetInfoForMatches(twitterMatches);

    try {
      const isThread = message.channel.isThread();
      const webhookChannel = isThread ? message.channel.parent : message.channel;
      const threadId = isThread ? message.channel.id : undefined;

      // Non-Twitter links just get their plain domain swap; Twitter links go through the
      // card-building pipeline below.
      let rewritten = message.content;
      for (const { rule, matches } of matchesByRule) {
        if (rule.name === 'twitter' || !matches.length) continue;
        rewritten = rewritten.replace(rule.regex, rule.convert);
      }

      const identity = {
        username: message.member?.displayName ?? message.author.username,
        avatarURL: message.author.displayAvatarURL(),
        threadId,
        allowedMentions: { parse: [] },
      };

      // Messages with no tweet at all (just Instagram/TikTok/Bluesky) skip the whole
      // card/fallback system and keep the original simple plain-content behavior — those
      // platforms already work fine via native unfurl and aren't part of this feature, and
      // Components-v2 text isn't confirmed to auto-unfurl links the way normal content does.
      const hasTweet = twitterMatches.length > 0;

      const sizeCap = getAttachmentSizeCap(message.guild);
      const cardResult = hasTweet ? await buildTweetCards(tweetInfos, sizeCap) : null;

      // Send the replacement first and only delete the original once it's confirmed posted —
      // otherwise a failed send would silently wipe the user's message with nothing to show
      // for it.
      try {
        if (!hasTweet) {
          await sendViaWebhook(webhookChannel, { content: rewritten, ...identity });
        } else if (cardResult.ok) {
          const extraLinks = buildExtraLinksContainer(matchesByRule);
          await sendViaWebhook(webhookChannel, {
            flags: MessageFlags.IsComponentsV2,
            components: extraLinks ? [...cardResult.containers, extraLinks] : cardResult.containers,
            files: cardResult.files,
            ...identity,
          });
        } else {
          await sendViaWebhook(webhookChannel, { ...buildFallbackPayload(rewritten, tweetInfos), ...identity });
        }
      } catch (sendError) {
        // If the custom-card send failed unexpectedly (e.g. our size estimate was wrong and
        // Discord rejected the upload), retry once with the plain-link fallback before giving
        // up — this is the safety net for cases buildTweetCards' proactive check didn't catch.
        // (No retry is attempted for the other paths — there's nothing further to fall back to.)
        if (hasTweet && cardResult.ok) {
          try {
            console.error('Custom card send failed, retrying with plain-link fallback:', sendError);
            await sendViaWebhook(webhookChannel, { ...buildFallbackPayload(rewritten, tweetInfos), ...identity });
          } catch (fallbackError) {
            console.error('Fallback send also failed, leaving original in place:', fallbackError);
            await message.react('⚠️').catch(() => {});
            return;
          }
        } else {
          console.error('Failed to post replacement message, leaving original in place:', sendError);
          await message.react('⚠️').catch(() => {});
          return;
        }
      }

      await message.delete().catch((deleteError) => {
        console.error('Replacement posted but failed to delete the original message:', deleteError);
      });
    } catch (error) {
      console.error('Error processing message:', error);
      await message.react('⚠️').catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
