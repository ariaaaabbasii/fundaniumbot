import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG = {
  searchUrl:
    'https://www.funda.nl/zoeken/koop?selected_area=[%22alkmaar,30km%22]&price=%22100000-300000%22&object_type=[%22apartment%22]&floor_area=%2260-%22&bedrooms=%221-%22',
  pollIntervalMinutes: 10,
  firstRunNotify: false,
  maxNewListingsPerRun: 5,
  maxPhotos: 4,
  stateFile: 'data/state.json',
  userAgent: 'Mozilla/5.0 (compatible; personal-funda-home-alert/0.1; +local-personal-use)',
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    callbackPollSeconds: 15,
  },
  ntfy: {
    enabled: false,
    server: 'https://ntfy.sh',
    topic: '',
    token: '',
  },
};

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const DRY_RUN = args.has('--dry-run');

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const config = await loadConfig();

  if (ONCE) {
    await runOnce(config);
    return;
  }

  console.log(`[monitor] gestart. Interval: ${config.pollIntervalMinutes} minuten.`);
  for (;;) {
    await runOnce(config);
    await sleepWithCallbackPolling(config, config.pollIntervalMinutes * 60_000);
  }
}

async function sleepWithCallbackPolling(config, durationMs) {
  const endAt = Date.now() + durationMs;
  const pollMs = Math.max(5, Number(config.telegram.callbackPollSeconds || 15)) * 1_000;

  while (Date.now() < endAt) {
    await sleep(Math.min(pollMs, endAt - Date.now()));
    if (!config.telegram.enabled) continue;

    const state = await loadState(config);
    await handleTelegramCallbacks(config, state);
    await saveState(config, state);
  }
}

async function runOnce(config) {
  const state = await loadState(config);

  await handleTelegramCallbacks(config, state);

  console.log(`[check] Funda zoekresultaten ophalen: ${new Date().toLocaleString('nl-NL')}`);
  const searchHtml = await fetchText(config.searchUrl, config);
  const listingUrls = extractListingUrls(searchHtml);

  if (listingUrls.length === 0) {
    throw new Error('Geen Funda-listings gevonden. De pagina-structuur is mogelijk gewijzigd.');
  }

  const knownIds = new Set(Object.keys(state.seenListings || {}));
  const newUrls = listingUrls.filter((url) => !knownIds.has(listingIdFromUrl(url)));
  const firstRun = knownIds.size === 0;

  if (firstRun && !config.firstRunNotify) {
    for (const url of listingUrls) {
      state.seenListings[listingIdFromUrl(url)] = {
        url,
        firstSeenAt: new Date().toISOString(),
        seeded: true,
      };
    }
    await saveState(config, state);
    console.log(`[seed] ${listingUrls.length} bestaande listings opgeslagen. Nieuwe listings melden we vanaf de volgende run.`);
    return;
  }

  if (newUrls.length === 0) {
    await saveState(config, state);
    console.log(`[ok] Geen nieuwe woningen. Gezien: ${listingUrls.length}.`);
    return;
  }

  const limitedNewUrls = newUrls.slice(0, config.maxNewListingsPerRun);
  console.log(`[new] ${newUrls.length} nieuwe listing(s), ${limitedNewUrls.length} verwerken.`);

  for (const url of limitedNewUrls) {
    const listing = await fetchListingDetails(url, config);
    state.seenListings[listing.id] = {
      url: listing.url,
      title: listing.title,
      firstSeenAt: new Date().toISOString(),
    };

    await notify(config, listing);
    await sleep(1_000);
  }

  await saveState(config, state);
}

async function loadConfig() {
  const configPath = path.join(ROOT_DIR, 'config.json');
  const fileConfig = await readJsonIfExists(configPath, {});
  const config = mergeConfig(DEFAULT_CONFIG, fileConfig);

  config.searchUrl = process.env.FUNDA_SEARCH_URL || config.searchUrl;
  config.pollIntervalMinutes = Number(process.env.POLL_INTERVAL_MINUTES || config.pollIntervalMinutes);
  config.firstRunNotify = boolFromEnv('FIRST_RUN_NOTIFY', config.firstRunNotify);
  config.maxNewListingsPerRun = Number(process.env.MAX_NEW_LISTINGS_PER_RUN || config.maxNewListingsPerRun);
  config.maxPhotos = Number(process.env.MAX_PHOTOS || config.maxPhotos);
  config.stateFile = process.env.STATE_FILE || config.stateFile;
  config.userAgent = process.env.USER_AGENT || config.userAgent;

  config.telegram.enabled = boolFromEnv('TELEGRAM_ENABLED', config.telegram.enabled);
  config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || config.telegram.botToken;
  config.telegram.chatId = process.env.TELEGRAM_CHAT_ID || config.telegram.chatId;
  config.telegram.callbackPollSeconds = Number(
    process.env.TELEGRAM_CALLBACK_POLL_SECONDS || config.telegram.callbackPollSeconds,
  );

  config.ntfy.enabled = boolFromEnv('NTFY_ENABLED', config.ntfy.enabled);
  config.ntfy.server = process.env.NTFY_SERVER || config.ntfy.server;
  config.ntfy.topic = process.env.NTFY_TOPIC || config.ntfy.topic;
  config.ntfy.token = process.env.NTFY_TOKEN || config.ntfy.token;

  return config;
}

function mergeConfig(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key]) {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function boolFromEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(value.toLowerCase());
}

async function loadState(config) {
  const statePath = resolveFromRoot(config.stateFile);
  const state = await readJsonIfExists(statePath, {});
  return {
    seenListings: state.seenListings || {},
    decisions: state.decisions || {},
    telegramUpdateOffset: state.telegramUpdateOffset || 0,
  };
}

async function saveState(config, state) {
  const statePath = resolveFromRoot(config.stateFile);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function resolveFromRoot(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(ROOT_DIR, filePath);
}

async function fetchText(url, config) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': config.userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} bij ophalen van ${url}`);
  }

  return response.text();
}

function extractListingUrls(html) {
  const urls = [];
  const jsonLdMatch = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]+data-hid=["']result-list-metadata["'][^>]*>(.*?)<\/script>/s,
  );

  if (jsonLdMatch) {
    try {
      const data = JSON.parse(decodeHtml(jsonLdMatch[1]));
      for (const item of data.itemListElement || []) {
        if (item.url) urls.push(normalizeFundaUrl(item.url));
      }
    } catch (error) {
      console.warn(`[warn] JSON-LD van zoekpagina niet leesbaar: ${error.message}`);
    }
  }

  if (urls.length === 0) {
    const matches = html.matchAll(/href=["'](\/detail\/koop\/[^"']+?\/\d+\/)["']/g);
    for (const match of matches) urls.push(normalizeFundaUrl(match[1]));
  }

  return [...new Set(urls)].filter((url) => /\/detail\/koop\/.+\/\d+\/$/.test(url));
}

async function fetchListingDetails(url, config) {
  const html = await fetchText(url, config);
  const jsonLd = extractListingJsonLd(html);
  const photos = extractPhotos(jsonLd).slice(0, config.maxPhotos);
  const features = extractFeatures(html, [
    'Vraagprijs',
    'Wonen',
    'Aantal kamers',
    'Energielabel',
    'Bouwjaar',
    'Soort appartement',
    'Aanvaarding',
  ]);

  const description = extractMetaContent(html, 'description') || jsonLd?.description || '';
  const addressParts = [
    jsonLd?.address?.streetAddress || jsonLd?.name,
    jsonLd?.address?.addressLocality,
  ].filter(Boolean);
  const title = addressParts.join(', ') || jsonLd?.name || titleFromUrl(url);

  return {
    id: listingIdFromUrl(url),
    url: normalizeFundaUrl(url),
    title,
    price: formatPrice(jsonLd?.offers?.price, features.Vraagprijs),
    description: cleanText(description),
    summary: buildSummary({ title, description, features, price: formatPrice(jsonLd?.offers?.price, features.Vraagprijs) }),
    photos,
    features,
  };
}

function extractListingJsonLd(html) {
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gs);
  for (const match of scripts) {
    try {
      const data = JSON.parse(decodeHtml(match[1]));
      const types = Array.isArray(data['@type']) ? data['@type'] : [data['@type']];
      if (types.includes('Product') || data.offers?.price || data.photo) return data;
    } catch {
      // Continue with the next JSON-LD block.
    }
  }
  return {};
}

function extractPhotos(jsonLd) {
  const photos = [];
  if (jsonLd?.image) photos.push(jsonLd.image);
  for (const photo of jsonLd?.photo || []) {
    if (typeof photo === 'string') photos.push(photo);
    if (photo?.contentUrl) photos.push(photo.contentUrl);
  }
  return [...new Set(photos)];
}

function extractFeatures(html, labels) {
  const features = {};
  for (const label of labels) {
    const value = extractFeature(html, label);
    if (value) features[label] = value;
  }
  return features;
}

function extractFeature(html, label) {
  const escaped = escapeRegex(label);
  const re = new RegExp(`<dt[^>]*>\\s*${escaped}\\s*<\\/dt>\\s*<dd[^>]*>(.*?)<\\/dd>`, 'is');
  const match = html.match(re);
  if (!match) return '';
  return cleanText(stripTags(match[1]));
}

function extractMetaContent(html, name) {
  const re = new RegExp(`<meta\\s+name=["']${escapeRegex(name)}["']\\s+content=["']([^"']*)["']`, 'i');
  const match = html.match(re);
  return match ? decodeHtml(match[1]) : '';
}

function buildSummary({ title, description, features, price }) {
  const bullets = [];
  if (price) bullets.push(price);
  if (features.Wonen) bullets.push(features.Wonen);
  if (features['Aantal kamers']) bullets.push(features['Aantal kamers']);
  if (features.Energielabel) bullets.push(`energielabel ${features.Energielabel}`);
  if (features.Bouwjaar) bullets.push(`bouwjaar ${features.Bouwjaar}`);
  if (features.Aanvaarding) bullets.push(`aanvaarding ${features.Aanvaarding}`);

  const intro = bullets.length > 0 ? `${title}: ${bullets.join(', ')}.` : `${title}.`;
  const text = cleanText(description);
  return text ? `${intro}\n\n${truncate(text, 650)}` : intro;
}

async function notify(config, listing) {
  if (DRY_RUN || (!config.telegram.enabled && !config.ntfy.enabled)) {
    console.log(`[dry-run] Nieuwe woning:\n${formatListingMessage(listing)}`);
    return;
  }

  if (config.telegram.enabled) {
    await sendTelegramListing(config, listing);
  }

  if (config.ntfy.enabled) {
    await sendNtfyListing(config, listing);
  }
}

function formatListingMessage(listing) {
  const lines = [
    `Nieuwe Funda-match: ${listing.title}`,
    listing.price ? `Prijs: ${listing.price}` : '',
    listing.features.Wonen ? `Wonen: ${listing.features.Wonen}` : '',
    listing.features['Aantal kamers'] ? `Kamers: ${listing.features['Aantal kamers']}` : '',
    listing.features.Energielabel ? `Energielabel: ${listing.features.Energielabel}` : '',
    '',
    listing.summary,
    '',
    listing.url,
  ];
  return lines.filter((line) => line !== '').join('\n');
}

async function sendTelegramListing(config, listing) {
  requireTelegramConfig(config);

  const caption = truncate(formatListingMessage(listing), 1000);
  const replyMarkup = {
    inline_keyboard: [
      [{ text: 'Bekijk / reageer', url: listing.url }],
      [
        { text: 'Ja, interessant', callback_data: `interest:${listing.id}` },
        { text: 'Nee', callback_data: `ignore:${listing.id}` },
      ],
    ],
  };

  if (listing.photos[0]) {
    await telegramApi(config, 'sendPhoto', {
      chat_id: config.telegram.chatId,
      photo: listing.photos[0],
      caption,
      reply_markup: replyMarkup,
    });

    const extraPhotos = listing.photos.slice(1, config.maxPhotos);
    for (const photo of extraPhotos) {
      await telegramApi(config, 'sendPhoto', {
        chat_id: config.telegram.chatId,
        photo,
      });
      await sleep(300);
    }
  } else {
    await telegramApi(config, 'sendMessage', {
      chat_id: config.telegram.chatId,
      text: caption,
      reply_markup: replyMarkup,
      disable_web_page_preview: false,
    });
  }
}

async function handleTelegramCallbacks(config, state) {
  if (!config.telegram.enabled || !config.telegram.botToken) return;

  const data = await telegramApi(config, 'getUpdates', {
    offset: state.telegramUpdateOffset || 0,
    timeout: 0,
    allowed_updates: ['callback_query'],
  });

  for (const update of data.result || []) {
    state.telegramUpdateOffset = Math.max(state.telegramUpdateOffset || 0, update.update_id + 1);
    const callback = update.callback_query;
    if (!callback?.data) continue;

    const [decision, listingId] = callback.data.split(':');
    if (!['interest', 'ignore'].includes(decision) || !listingId) continue;

    state.decisions[listingId] = {
      decision,
      decidedAt: new Date().toISOString(),
      from: callback.from?.username || callback.from?.first_name || 'telegram',
    };

    const text = decision === 'interest' ? 'Genoteerd als interessant.' : 'Genoteerd als niet interessant.';
    await telegramApi(config, 'answerCallbackQuery', {
      callback_query_id: callback.id,
      text,
      show_alert: false,
    });
  }
}

async function sendNtfyListing(config, listing) {
  if (!config.ntfy.topic) {
    throw new Error('ntfy.enabled staat aan, maar ntfy.topic is leeg.');
  }

  const topicUrl = `${config.ntfy.server.replace(/\/$/, '')}/${encodeURIComponent(config.ntfy.topic)}`;
  const headers = {
    Title: `Nieuwe Funda-match: ${listing.title}`,
    Tags: 'house,rotating_light',
    Click: listing.url,
    Actions: `view, Bekijk / reageer, ${listing.url}`,
  };

  if (listing.photos[0]) headers.Attach = listing.photos[0];
  if (config.ntfy.token) headers.Authorization = `Bearer ${config.ntfy.token}`;

  const response = await fetch(topicUrl, {
    method: 'POST',
    headers,
    body: formatListingMessage(listing),
  });

  if (!response.ok) {
    throw new Error(`ntfy HTTP ${response.status}: ${await response.text()}`);
  }
}

async function telegramApi(config, method, body) {
  requireTelegramConfig(config);
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} fout: ${JSON.stringify(data)}`);
  }
  return data;
}

function requireTelegramConfig(config) {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    throw new Error('telegram.enabled staat aan, maar botToken of chatId is leeg.');
  }
}

function normalizeFundaUrl(url) {
  if (url.startsWith('http')) return url;
  return `https://www.funda.nl${url}`;
}

function listingIdFromUrl(url) {
  const match = url.match(/\/(\d+)\/?$/);
  if (!match) throw new Error(`Geen listing-id gevonden in URL: ${url}`);
  return match[1];
}

function titleFromUrl(url) {
  const parts = new URL(normalizeFundaUrl(url)).pathname.split('/').filter(Boolean);
  return parts.at(-2)?.replace(/^appartement-/, '').replaceAll('-', ' ') || url;
}

function formatPrice(price, fallback) {
  if (price == null || price === '') return fallback || '';
  const number = Number(price);
  if (!Number.isFinite(number)) return fallback || String(price);
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(number);
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value || '';
  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function stripTags(value) {
  return value.replace(/<!--.*?-->/gs, '').replace(/<[^>]+>/g, ' ');
}

function cleanText(value) {
  return decodeHtml(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,:;!?])/g, '$1')
    .trim();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
