import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SEARCH_URL =
  'https://www.funda.nl/zoeken/koop?selected_area=[%22alkmaar,30km%22]&price=%22100000-300000%22&object_type=[%22apartment%22]&floor_area=%2260-%22&bedrooms=%221-%22';

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const config = await loadConfig();
  const html = await fetchText(config.searchUrl, config);
  const [url] = extractListingUrls(html);

  if (!url) {
    throw new Error('Geen woningen gevonden in de zoekresultaten.');
  }

  const listing = await fetchListingDetails(url, config);
  const message = formatListing(listing);
  console.log(message);

  if (config.telegram?.enabled && config.telegram.botToken && config.telegram.chatId) {
    await sendTelegram(config, listing, message);
    console.log('\n[telegram] Verzonden.');
  }
}

async function loadConfig() {
  const configPath = path.join(ROOT_DIR, 'config.json');
  const config = await readJsonIfExists(configPath, {});
  return {
    searchUrl: process.env.FUNDA_SEARCH_URL || config.searchUrl || DEFAULT_SEARCH_URL,
    userAgent:
      process.env.USER_AGENT ||
      config.userAgent ||
      'Mozilla/5.0 (compatible; personal-funda-home-alert/0.1; +local-personal-use)',
    telegram: {
      enabled: envBool('TELEGRAM_ENABLED', config.telegram?.enabled || false),
      botToken: process.env.TELEGRAM_BOT_TOKEN || config.telegram?.botToken || '',
      chatId: process.env.TELEGRAM_CHAT_ID || config.telegram?.chatId || '',
    },
  };
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

async function fetchText(url, config) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      'User-Agent': config.userAgent,
    },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} bij ophalen van ${url}`);
  return response.text();
}

function extractListingUrls(html) {
  const urls = [];
  const jsonLdMatch = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]+data-hid=["']result-list-metadata["'][^>]*>(.*?)<\/script>/s,
  );

  if (jsonLdMatch) {
    const data = JSON.parse(decodeHtml(jsonLdMatch[1]));
    for (const item of data.itemListElement || []) {
      if (item.url) urls.push(normalizeFundaUrl(item.url));
    }
  }

  if (urls.length === 0) {
    const matches = html.matchAll(/href=["'](\/detail\/koop\/[^"']+?\/\d+\/)["']/g);
    for (const match of matches) urls.push(normalizeFundaUrl(match[1]));
  }

  return [...new Set(urls)];
}

async function fetchListingDetails(url, config) {
  const html = await fetchText(url, config);
  const jsonLd = extractListingJsonLd(html);
  const features = extractFeatures(html);
  const price = numberFromValue(jsonLd?.offers?.price) || euroNumber(features.Vraagprijs);
  const livingArea = numberFromValue(features.Wonen);
  const pricePerM2 = euroNumber(features['Vraagprijs per m²']) || (price && livingArea ? Math.round(price / livingArea) : null);
  const description = cleanText(extractMetaContent(html, 'description') || jsonLd.description || '');
  const title = [jsonLd?.address?.streetAddress || jsonLd?.name || titleFromUrl(url), jsonLd?.address?.addressLocality]
    .filter(Boolean)
    .join(', ');

  return {
    id: listingIdFromUrl(url),
    url,
    title,
    price,
    priceText: features.Vraagprijs || formatEuro(price),
    pricePerM2,
    livingArea,
    rooms: features['Aantal kamers'] || '',
    energyLabel: cleanEnergyLabel(features.Energielabel),
    buildYear: numberFromValue(features.Bouwjaar),
    acceptance: features.Aanvaarding || '',
    apartmentType: features['Soort appartement'] || '',
    description,
    photos: extractPhotos(jsonLd),
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
      // Keep trying other JSON-LD blocks.
    }
  }
  return {};
}

function extractFeatures(html) {
  const labels = ['Vraagprijs', 'Vraagprijs per m²', 'Wonen', 'Aantal kamers', 'Energielabel', 'Bouwjaar', 'Aanvaarding', 'Soort appartement'];
  const features = {};
  for (const label of labels) {
    const value = extractFeature(html, label);
    if (value) features[label] = value;
  }
  return features;
}

function extractFeature(html, label) {
  const re = new RegExp(`<dt[^>]*>\\s*${escapeRegex(label)}\\s*<\\/dt>\\s*<dd[^>]*>(.*?)<\\/dd>`, 'is');
  const match = html.match(re);
  return match ? cleanText(stripTags(match[1])) : '';
}

function extractMetaContent(html, name) {
  const re = new RegExp(`<meta\\s+name=["']${escapeRegex(name)}["']\\s+content=["']([^"']*)["']`, 'i');
  const match = html.match(re);
  return match ? decodeHtml(match[1]) : '';
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

function formatListing(listing) {
  return [
    `Bovenste Funda-woning: ${listing.title}`,
    listing.priceText ? `Prijs: ${listing.priceText}` : '',
    listing.pricePerM2 ? `Prijs per m2: ${formatEuro(listing.pricePerM2)}` : '',
    listing.livingArea ? `Wonen: ${listing.livingArea} m2` : '',
    listing.rooms ? `Kamers: ${listing.rooms}` : '',
    listing.energyLabel ? `Energielabel: ${listing.energyLabel}` : '',
    listing.buildYear ? `Bouwjaar: ${listing.buildYear}` : '',
    listing.acceptance ? `Aanvaarding: ${listing.acceptance}` : '',
    listing.apartmentType ? `Type: ${listing.apartmentType}` : '',
    '',
    truncate(listing.description, 700),
    '',
    listing.url,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function sendTelegram(config, listing, message) {
  const body = listing.photos[0]
    ? {
        chat_id: config.telegram.chatId,
        photo: listing.photos[0],
        caption: truncate(message, 1000),
        reply_markup: { inline_keyboard: [[{ text: 'Bekijk / reageer', url: listing.url }]] },
      }
    : {
        chat_id: config.telegram.chatId,
        text: message,
        reply_markup: { inline_keyboard: [[{ text: 'Bekijk / reageer', url: listing.url }]] },
      };

  const method = listing.photos[0] ? 'sendPhoto' : 'sendMessage';
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram fout: ${JSON.stringify(data)}`);
}

function normalizeFundaUrl(url) {
  return url.startsWith('http') ? url : `https://www.funda.nl${url}`;
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

function numberFromValue(value) {
  if (value == null || value === '') return null;
  const match = String(value).replace(/\./g, '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function euroNumber(value) {
  return numberFromValue(value);
}

function cleanEnergyLabel(value) {
  const match = String(value || '').match(/\b(A\+{0,5}|B|C|D|E|F|G)\b/i);
  return match ? match[1].toUpperCase() : cleanText(value || '');
}

function formatEuro(value) {
  if (value == null || value === '') return '';
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(value));
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value || '';
  return `${value.slice(0, maxLength - 1).trim()}...`;
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

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(value.toLowerCase());
}
