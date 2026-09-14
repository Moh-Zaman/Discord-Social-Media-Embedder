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
  SlashCommandBuilder,
  ApplicationIntegrationType,
  InteractionContextType,
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

// Builds the { duration, variants, bestUrl } shape used for both a tweet's own video and a
// quoted tweet's video, from the fxtwitter API's raw video object.
function parseVideo(video) {
  if (!video) return null;
  const mp4Variants = (video.formats ?? [])
    .filter((f) => f.container === 'mp4' && typeof f.bitrate === 'number')
    .sort((a, b) => b.bitrate - a.bitrate);
  return { duration: video.duration ?? null, variants: mp4Variants, bestUrl: video.url };
}

// Spells out a raw ISO 639-1 code ("ja") as a full language name ("Japanese"), for the quote
// translation fallback (its translation object doesn't reliably carry the API's own English
// name the way the outer tweet's does — see getTweetInfo). Built into Node's Intl support, no
// dependency needed. Falls back to the raw code itself for anything it doesn't recognize.
const languageDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });
function getLanguageName(code) {
  if (!code) return null;
  try {
    return languageDisplayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// Pulls tweet info via the fxtwitter API (fixupx.com's backend): the tweet text, an English
// translation (fxtwitter translates server-side and only returns a `translation` field when
// the tweet isn't already in English), video variants (for picking one small enough to attach
// natively), photos, author, stats, and quoted-tweet text/media if this tweet quotes another one.
async function getTweetInfo(url) {
  const idMatch = url.match(/status\/(\d+)/);
  if (!idMatch) return EMPTY_TWEET_INFO;

  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${idMatch[1]}/en`);
    if (!res.ok) return EMPTY_TWEET_INFO;

    const data = await res.json();
    const tweet = data?.tweet;
    if (!tweet) return EMPTY_TWEET_INFO;

    return {
      text: tweet.text ?? '',
      // Deriving the language name ourselves (getLanguageName, below) rather than trusting the
      // API's own source_lang_en is deliberate: confirmed live that it can come back malformed
      // for less-common languages (e.g. "language_cy" instead of "Welsh" for raw code "cy"),
      // whereas our own Intl-based lookup resolves the same raw code correctly every time.
      translation: tweet.translation
        ? {
            text: tweet.translation.text,
            sourceLang: getLanguageName(tweet.translation.source_lang) ?? tweet.translation.source_lang_en ?? null,
          }
        : null,
      video: parseVideo(tweet.media?.videos?.[0]),
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
      // Checked against tweet.quote (not tweet.quote.text) so a quote-tweet whose quoted post is
      // media-only (an image/video/gif with no caption) still registers as a quote instead of
      // being silently dropped, and its media carries over via the same photos/video shape as
      // the outer tweet. The quote's own translation field is wired up on the same defensive
      // basis as communityNote below: FxEmbed's API docs describe `quote` as reusing the exact
      // same schema as the outer tweet (which does carry translation), but this wasn't
      // confirmed against a live non-English quoted tweet, so treat it as likely-but-unverified.
      quote: tweet.quote
        ? {
            text: tweet.quote.text ?? '',
            // Same getLanguageName-first priority as the outer tweet's translation above — the
            // API's source_lang_en has now been seen both missing (quotes) and malformed
            // (outer), so it's only used as a last resort, never trusted first.
            translation: tweet.quote.translation
              ? {
                  text: tweet.quote.translation.text,
                  sourceLang:
                    getLanguageName(tweet.quote.translation.source_lang) ?? tweet.quote.translation.source_lang_en ?? null,
                }
              : null,
            author: tweet.quote.author
              ? { name: tweet.quote.author.name, screenName: tweet.quote.author.screen_name }
              : null,
            photos: tweet.quote.media?.photos?.map((p) => p.url) ?? [],
            video: parseVideo(tweet.quote.media?.videos?.[0]),
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

// One Container per tweet, in order: author (name/avatar), body text (translated text takes
// priority over the original), the tweet's own media (a native video attachment or its photos),
// then a separated section below for quoted-tweet text and media if this is a quote-tweet, then
// stats and action buttons. Own media comes before the quote section so it's clear at a glance
// which media belongs to the tweet itself versus what it's quoting. `videoAttachment` and
// `quoteVideoAttachment` are passed in separately (rather than looked up from `info`) because
// they've already been downloaded by the time this runs, and referencing an attachment by
// filename is how Components v2 embeds an uploaded file into a MediaGallery.
function buildTweetContainer(info, videoAttachment, quoteVideoAttachment) {
  const container = new ContainerBuilder().setAccentColor(0x1d9bf0);
  const isEnriched = Boolean(info.author);

  // A small platform label above the author line, similar to how X's own UI shows the source
  // above the account. Components v2 has no way to place a real logo image tucked next to small
  // text (a Section's thumbnail accessory only docks to the right, at a larger fixed size — see
  // the author-avatar comment history for why that was ruled out), so this uses the 𝕏 glyph as
  // a lightweight text-based stand-in instead of an actual image asset.
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# 𝕏 Twitter/X'));

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

  // The tweet's own media comes before the quote section (rather than after), so it's clear at
  // a glance which media belongs to the tweet itself versus the tweet it's quoting. Sensitive
  // media is spoiler-tagged (blurred, click-to-reveal) rather than shown openly, matching how X
  // itself gates flagged content instead of just displaying it.
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

  if (info.quote) {
    container.addSeparatorComponents(new SeparatorBuilder());
    const quoteHeader = info.quote.author
      ? `**Quoting [@${info.quote.author.screenName}](https://x.com/${info.quote.author.screenName}):**`
      : '**Quoting:**';
    // Translated quote text takes priority over the original, same as the tweet's own body.
    // Media-only quotes (an image/video/gif with no caption) have no text to append at all.
    const quoteText = info.quote.translation ? info.quote.translation.text : info.quote.text;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(quoteText ? `${quoteHeader}\n${quoteText}` : quoteHeader)
    );
    if (info.quote.translation) {
      const quoteTranslationNote = info.quote.translation.sourceLang
        ? `-# 🌐 Translated from ${info.quote.translation.sourceLang}`
        : '-# 🌐 Translated';
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(quoteTranslationNote));
    }

    // Quoted media is spoiler-tagged the same as the tweet's own media above — we don't get a
    // separate sensitivity flag for the quoted tweet from the API, so this reuses the outer
    // tweet's flag as the closest available signal.
    if (quoteVideoAttachment) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(`attachment://${quoteVideoAttachment.name}`).setSpoiler(info.sensitive)
        )
      );
    } else if (info.quote.photos.length) {
      const quoteGallery = new MediaGalleryBuilder();
      for (const photoUrl of info.quote.photos.slice(0, 4)) {
        quoteGallery.addItems(new MediaGalleryItemBuilder().setURL(photoUrl).setSpoiler(info.sensitive));
      }
      container.addMediaGalleryComponents(quoteGallery);
    }
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
// { ok: false } the moment the tweet's own video can't fit under the size cap (even at its
// lowest available quality, or the real download turned out bigger than estimated) — callers
// should fall back to the plain-link approach for the whole message in that case, since a
// Components-v2 message can't be partially built.
//
// A quoted tweet's video is treated as supplementary rather than essential: it's only attached
// if it fits in whatever budget is left after the tweet's own video, and if it doesn't fit (or
// there's no budget left at all), it's just silently skipped — the quote's text/photos and the
// rest of the card still go out normally rather than failing the whole message over it.
async function buildTweetCards(tweetInfos, sizeCap) {
  const containers = [];
  const files = [];

  for (const [i, info] of tweetInfos.entries()) {
    let videoAttachment = null;
    let usedBytes = 0;

    if (info.video) {
      const variant = pickVideoVariant(info.video, sizeCap);
      if (!variant) return { ok: false };

      videoAttachment = await downloadVideoAttachment(variant.url, sizeCap, `tweet-video-${i}.mp4`);
      if (!videoAttachment) return { ok: false };

      files.push(videoAttachment);
      usedBytes = videoAttachment.attachment.length;
    }

    let quoteVideoAttachment = null;
    if (info.quote?.video) {
      const remainingBudget = sizeCap - usedBytes;
      const quoteVariant = remainingBudget > 0 ? pickVideoVariant(info.quote.video, remainingBudget) : null;
      if (quoteVariant) {
        quoteVideoAttachment = await downloadVideoAttachment(quoteVariant.url, remainingBudget, `tweet-quote-video-${i}.mp4`);
        if (quoteVideoAttachment) files.push(quoteVideoAttachment);
      }
    }

    containers.push(buildTweetContainer(info, videoAttachment, quoteVideoAttachment));
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

function buildTranslationEmbeds({ translation, author, photos, stats, tweetUrl, createdTimestamp, communityNote, quote }) {
  let description = translation.text;
  if (quote) {
    const quoteHeader = quote.author ? `**Quoting @${quote.author.screenName}:**` : '**Quoting:**';
    const quoteText = quote.translation ? quote.translation.text : quote.text;
    description += quoteText ? `\n\n${quoteHeader}\n${quoteText}` : `\n\n${quoteHeader}`;
    if (quote.translation) {
      description += quote.translation.sourceLang
        ? `\n-# 🌐 Translated from ${quote.translation.sourceLang}`
        : '\n-# 🌐 Translated';
    }
  }
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
  // Quote video can't be carried over here either (embeds have no video support at all); own
  // and quoted photos are combined into one gallery rather than visually separated.
  const allPhotos = [...photos, ...(quote?.photos ?? [])];
  if (allPhotos[0]) main.setImage(allPhotos[0]);

  const galleryEmbeds = allPhotos.slice(1, 4).map((photoUrl) => new EmbedBuilder().setURL(tweetUrl ?? undefined).setImage(photoUrl));

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

// Shared by messageCreate and the /fix slash command: given raw text containing supported
// links, does everything async (tweet lookups, video downloads) needed to build a response.
// Returns null if nothing supported was found. Kept separate from the final payload/send step
// since the two callers send the result differently (webhook impersonation vs. an interaction
// reply) and need different retry behavior around it.
async function prepareLinkResponse(rawContent, guild) {
  const { matchesByRule, twitterMatches, modified } = findLinks(rawContent);
  if (!modified) return null;

  let rewritten = rawContent;
  for (const { rule, matches } of matchesByRule) {
    if (rule.name === 'twitter' || !matches.length) continue;
    rewritten = rewritten.replace(rule.regex, rule.convert);
  }

  // Messages/links with no tweet at all (just Instagram/TikTok/Bluesky) skip the whole
  // card/fallback system — those platforms already work fine via native unfurl and aren't part
  // of this feature, and Components-v2 text isn't confirmed to auto-unfurl links the way normal
  // content does.
  const hasTweet = twitterMatches.length > 0;
  const tweetInfos = hasTweet ? await getTweetInfoForMatches(twitterMatches) : [];
  const sizeCap = getAttachmentSizeCap(guild);
  const cardResult = hasTweet ? await buildTweetCards(tweetInfos, sizeCap) : null;

  return { matchesByRule, rewritten, hasTweet, tweetInfos, cardResult };
}

// The primary (best-case) payload for a prepared response: the rich Components-v2 card for
// tweets, or a plain domain-swapped link for everything else. Throws/produces cardResult.ok ===
// false when a tweet's video couldn't be attached — callers should use buildFallbackPayload
// instead in that case (see prepareLinkResponse's cardResult).
function buildPrimaryPayload({ matchesByRule, rewritten, hasTweet, cardResult }) {
  if (!hasTweet) return { content: rewritten };

  const extraLinks = buildExtraLinksContainer(matchesByRule);
  return {
    flags: MessageFlags.IsComponentsV2,
    components: extraLinks ? [...cardResult.containers, extraLinks] : cardResult.containers,
    files: cardResult.files,
  };
}

client.on('messageCreate', async (message) => {
  // Ignore bot messages and DMs
  if (message.author.bot) return;
  if (message.channel.type === ChannelType.DM) return;

  const prepared = await prepareLinkResponse(message.content, message.guild);
  if (!prepared) return;
  const { rewritten, hasTweet, tweetInfos, cardResult } = prepared;

  try {
    const isThread = message.channel.isThread();
    const webhookChannel = isThread ? message.channel.parent : message.channel;
    const threadId = isThread ? message.channel.id : undefined;

    const identity = {
      username: message.member?.displayName ?? message.author.username,
      avatarURL: message.author.displayAvatarURL(),
      threadId,
      allowedMentions: { parse: [] },
    };

    // Send the replacement first and only delete the original once it's confirmed posted —
    // otherwise a failed send would silently wipe the user's message with nothing to show
    // for it.
    try {
      if (hasTweet && !cardResult.ok) {
        await sendViaWebhook(webhookChannel, { ...buildFallbackPayload(rewritten, tweetInfos), ...identity });
      } else {
        await sendViaWebhook(webhookChannel, { ...buildPrimaryPayload(prepared), ...identity });
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
});

// /fix <link>: manually triggers the same fixing/translation/video pipeline on a pasted link.
// Registered for both guild and user installs, and usable in guilds, bot DMs, and group DMs —
// unlike the passive auto-detect above, an interaction carries its own data directly, so it
// works anywhere without needing the Message Content intent at all. This is the only way to
// get this bot's functionality in a DM or in a server it hasn't been added to as a member.
const fixCommand = new SlashCommandBuilder()
  .setName('fix')
  .setDescription('Fix a Twitter/X, Instagram, TikTok, or Bluesky link')
  .addStringOption((option) =>
    option.setName('link').setDescription('The link to fix').setRequired(true)
  )
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);

client.on('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  client.user.setActivity('for social media links', { type: 'WATCHING' });

  try {
    await client.application.commands.set([fixCommand]);
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'fix') return;

  const link = interaction.options.getString('link', true);

  const prepared = await prepareLinkResponse(link, interaction.guild);
  if (!prepared) {
    await interaction.reply({
      content: "That doesn't look like a supported link (Twitter/X, Instagram, TikTok, or Bluesky).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { rewritten, hasTweet, tweetInfos, cardResult } = prepared;
  await interaction.deferReply();

  try {
    if (hasTweet && !cardResult.ok) {
      await interaction.editReply(buildFallbackPayload(rewritten, tweetInfos));
      return;
    }

    try {
      await interaction.editReply(buildPrimaryPayload(prepared));
    } catch (sendError) {
      if (hasTweet && cardResult.ok) {
        console.error('Custom card reply failed, retrying with plain-link fallback:', sendError);
        await interaction.editReply(buildFallbackPayload(rewritten, tweetInfos));
      } else {
        throw sendError;
      }
    }
  } catch (error) {
    console.error('Error handling /fix command:', error);
    await interaction.editReply("Something went wrong fixing that link.").catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
