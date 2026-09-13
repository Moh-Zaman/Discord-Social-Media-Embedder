const {
  Client,
  GatewayIntentBits,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
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

// Regex patterns for social media links
const TWITTER_REGEX = /(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/(\S+)/gi;
const INSTAGRAM_REGEX = /(https?:\/\/)?(www\.)?instagram\.com\/(\S+)/gi;

// Function to convert Twitter/X links to fixupx.com
function convertTwitterLink(url) {
  // Handle both x.com and twitter.com
  if (url.includes('x.com')) {
    return url.replace(/https?:\/\/(www\.)?x\.com/, 'https://fixupx.com');
  } else if (url.includes('twitter.com')) {
    return url.replace(/https?:\/\/(www\.)?twitter\.com/, 'https://fixupx.com');
  }
  return url;
}

// Function to convert Instagram links to kkinstagram.com
function convertInstagramLink(url) {
  return url.replace(/https?:\/\/(www\.)?instagram\.com/, 'https://kkinstagram.com');
}

// Function to find and convert social media links
function processMessage(content) {
  const twitterMatches = [...content.matchAll(TWITTER_REGEX)].map((m) => m[0]);
  const instagramMatches = [...content.matchAll(INSTAGRAM_REGEX)].map((m) => m[0]);

  let processedContent = content;
  if (twitterMatches.length) {
    processedContent = processedContent.replace(TWITTER_REGEX, convertTwitterLink);
  }
  if (instagramMatches.length) {
    processedContent = processedContent.replace(INSTAGRAM_REGEX, convertInstagramLink);
  }

  return {
    processed: processedContent,
    modified: twitterMatches.length > 0 || instagramMatches.length > 0,
    twitterMatches,
    instagramMatches,
  };
}

// Pulls the direct video URL for a tweet via the fxtwitter API (fixupx.com's backend).
// Image-only tweets return null so no download button shows up for them.
async function getTwitterDownloadUrl(url) {
  const idMatch = url.match(/status\/(\d+)/);
  if (!idMatch) return null;

  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${idMatch[1]}`);
    if (!res.ok) return null;

    const data = await res.json();
    return data?.tweet?.media?.videos?.[0]?.url ?? null;
  } catch {
    return null;
  }
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

client.on('messageCreate', async (message) => {
  // Ignore bot messages and DMs
  if (message.author.bot) return;
  if (message.channel.type === ChannelType.DM) return;

  const { processed, modified, twitterMatches } = processMessage(message.content);

  // Only act if we found and modified social media links
  if (modified) {
    const downloadUrl = twitterMatches.length
      ? await getTwitterDownloadUrl(twitterMatches[0])
      : null;

    try {
      const isThread = message.channel.isThread();
      const webhookChannel = isThread ? message.channel.parent : message.channel;
      const webhook = await getWebhook(webhookChannel);

      const components = downloadUrl
        ? [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setURL(downloadUrl)
                .setEmoji('⬇️')
                .setLabel('Download')
            ),
          ]
        : [];

      await message.delete();

      // Plain text (not an embed) so Discord unfurls the proxy link itself
      await webhook.send({
        content: processed,
        username: message.member?.displayName ?? message.author.username,
        avatarURL: message.author.displayAvatarURL(),
        threadId: isThread ? message.channel.id : undefined,
        allowedMentions: { parse: [] },
        components,
      });
    } catch (error) {
      console.error('Error processing message:', error);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
