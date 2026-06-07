import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SEARCH_URL =
  'https://www.funda.nl/zoeken/koop?selected_area=[%22alkmaar,30km%22]&price=%22100000-300000%22&object_type=[%22apartment%22]&floor_area=%2260-%22&bedrooms=%221-%22';

const DEFAULT_CONFIG = {
  searchUrl: DEFAULT_SEARCH_URL,
  pollIntervalMinutes: 10,
  firstRunNotify: false,
  maxNewListingsPerRun: 5,
  maxPhotos: 4,
  currentListingsSnapshotFile: 'data/current-listings.json',
  maxSearchPages: 8,
  maxTop10Listings: 60,
  maxAnalysisPhotos: 3,
  top10CacheMinutes: 120,
  notifyNoNewListings: false,
  noNewNotificationMinutes: 60,
  maxNotificationListingAgeDays: 3,
  stateFile: 'data/state.json',
  userAgent: 'Mozilla/5.0 (compatible; personal-funda-home-alert/0.1; +local-personal-use)',
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    callbackPollSeconds: 15,
  },
  openai: {
    enabled: false,
    apiKey: '',
    model: 'gpt-4.1-mini',
    autoAnalyzeNewListings: true,
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
const SEND_ACTIONS = args.has('--send-actions');
const RUN_TOP10 = args.has('--top10');
const RUN_TOP = args.has('--top');

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const config = await loadConfig();

  if (SEND_ACTIONS) {
    await sendActionsMenu(config);
    return;
  }

  if (RUN_TOP10) {
    const state = await loadState(config);
    await sendTop10(config, state, { forceRefresh: true });
    await saveState(config, state);
    return;
  }

  if (RUN_TOP) {
    const state = await loadState(config);
    await sendTopListing(config, state);
    await saveState(config, state);
    return;
  }

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

async function runOnce(config) {
  const state = await loadState(config);
  const previousSnapshot = await loadCurrentListingsSnapshot(config);

  await handleTelegramUpdates(config, state);

  console.log(`[check] Funda zoekresultaten ophalen: ${new Date().toLocaleString('nl-NL')}`);
  const listingUrls = await fetchSearchListingUrls(config, { allPages: true });
  state.lastCheckAt = new Date().toISOString();
  state.lastSearchCount = listingUrls.length;

  if (listingUrls.length === 0) {
    throw new Error('Geen Funda-listings gevonden. De pagina-structuur is mogelijk gewijzigd.');
  }

  const knownIds = new Set(Object.keys(state.seenListings || {}));
  const previousSnapshotIds = new Set((previousSnapshot.listings || []).map((listing) => listing.id));
  const snapshotMissing = previousSnapshotIds.size === 0;
  const firstRun = knownIds.size === 0;

  if (snapshotMissing) {
    seedSeenListingsFromUrls(state, listingUrls, { seeded: firstRun && !config.firstRunNotify });
    await saveCurrentListingsSnapshot(config, buildCurrentListingsSnapshot(listingUrls, state));
    await saveState(config, state);
    console.log(`[seed] ${listingUrls.length} huidige listings als startsnapshot opgeslagen. Nieuwe listings melden we vanaf de volgende run.`);
    return;
  }

  const newUrls = listingUrls.filter((url) => !previousSnapshotIds.has(listingIdFromUrl(url)));

  if (newUrls.length === 0) {
    await maybeNotifyNoNewListings(config, state, { checkedCount: listingUrls.length });
    await saveCurrentListingsSnapshot(config, buildCurrentListingsSnapshot(listingUrls, state));
    await saveState(config, state);
    console.log(`[ok] Geen nieuwe woningen. Gezien in huidig filterresultaat: ${listingUrls.length}.`);
    return;
  }

  console.log(`[new] ${newUrls.length} onbekende listing(s) gevonden, publicatiedatum controleren.`);

  const candidateListings = [];
  for (const url of newUrls) {
    const listing = await getListingDetails(config, state, url, { refresh: true });
    candidateListings.push(listing);
  }

  const sortedCandidates = sortByNewestListedAt(candidateListings, { previousSnapshotIds });
  console.log(
    `[new] ${sortedCandidates.length} kandidaat-woning(en) gesorteerd op Funda-datum${sortedCandidates[0]?.listedDateText ? `, nieuwste: ${sortedCandidates[0].listedDateText}` : ''}.`,
  );

  let autoAnalysesLeft = openaiEnabled(config) && config.openai.autoAnalyzeNewListings ? 3 : 0;
  let notifiedCount = 0;
  let oldSkippedCount = 0;
  let runLimitSkippedCount = 0;

  for (const listing of sortedCandidates) {
    state.seenListings[listing.id] = {
      url: listing.url,
      title: listing.title,
      firstSeenAt: new Date().toISOString(),
      listedAt: listing.listedAt || null,
    };

    if (!isRecentEnoughForNewNotification(config, listing)) {
      oldSkippedCount += 1;
      state.seenListings[listing.id].notificationSkipped = 'older-than-new-threshold';
      console.log(
        `[skip] ${listing.id} niet gemeld: Funda-datum ${listing.listedDateText || 'onbekend'} is ouder dan ${config.maxNotificationListingAgeDays} dagen.`,
      );
      continue;
    }

    if (notifiedCount >= config.maxNewListingsPerRun) {
      runLimitSkippedCount += 1;
      state.seenListings[listing.id].notificationSkipped = 'run-limit';
      continue;
    }

    if (autoAnalysesLeft > 0) {
      listing.analysis = await getListingAnalysis(config, state, listing, { mode: 'short' });
      autoAnalysesLeft -= 1;
    }

    await notifyNewListing(config, listing);
    state.seenListings[listing.id].notifiedAt = new Date().toISOString();
    notifiedCount += 1;
    await sleep(900);
  }

  if (notifiedCount === 0) {
    await maybeNotifyNoNewListings(config, state, {
      checkedCount: listingUrls.length,
      oldSkippedCount,
      runLimitSkippedCount,
    });
  }

  await saveCurrentListingsSnapshot(config, buildCurrentListingsSnapshot(listingUrls, state));
  await saveState(config, state);
}

async function maybeNotifyNoNewListings(config, state, { checkedCount, oldSkippedCount = 0, runLimitSkippedCount = 0 } = {}) {
  if (!config.notifyNoNewListings) return;
  if (state.lastNoNewNotificationAt && minutesAgo(state.lastNoNewNotificationAt) < config.noNewNotificationMinutes) return;

  const lines = [
    '<b>✅ Funda check</b>',
    'Geen nieuwe woningen gevonden.',
    '',
    `🏠 <b>Gecheckt:</b> ${checkedCount || 0} woning(en).`,
  ];

  if (oldSkippedCount) lines.push(`🗓️ <b>Genegeerd als oud:</b> ${oldSkippedCount} woning(en).`);
  if (runLimitSkippedCount) lines.push(`⏳ <b>Niet gemeld door runlimiet:</b> ${runLimitSkippedCount} woning(en).`);
  lines.push('', `Volgende check over ongeveer <b>${config.pollIntervalMinutes}</b> minuten.`);

  await sendTelegramText(config, lines.join('\n'), undefined, { parseMode: 'HTML' });
  state.lastNoNewNotificationAt = new Date().toISOString();
}

async function sleepWithCallbackPolling(config, durationMs) {
  const endAt = Date.now() + durationMs;
  const pollMs = Math.max(5, Number(config.telegram.callbackPollSeconds || 15)) * 1_000;

  while (Date.now() < endAt) {
    await sleep(Math.min(pollMs, endAt - Date.now()));
    if (!config.telegram.enabled) continue;

    const state = await loadState(config);
    await handleTelegramUpdates(config, state);
    await saveState(config, state);
  }
}

async function handleTelegramUpdates(config, state) {
  if (!config.telegram.enabled || !config.telegram.botToken) return;

  await ensureTelegramPollingMode(config);

  const data = await telegramApi(config, 'getUpdates', {
    offset: state.telegramUpdateOffset || 0,
    timeout: 0,
    allowed_updates: ['message', 'callback_query'],
  });

  const updates = data.result || [];
  console.log(`[telegram] ${updates.length} update(s) opgehaald via polling.`);

  for (const update of updates) {
    state.telegramUpdateOffset = Math.max(state.telegramUpdateOffset || 0, update.update_id + 1);

    if (update.message?.text) {
      try {
        await handleTelegramCommand(config, state, update.message);
      } catch (error) {
        console.error(`[telegram] Command mislukt: ${error.stack || error.message}`);
        await sendTelegramText(config, `Actie mislukt: ${truncate(error.message, 700)}\n\nGebruik /status om te kijken of de bot verder draait.`);
      }
    }

    if (update.callback_query) {
      try {
        await handleTelegramCallback(config, state, update.callback_query);
      } catch (error) {
        console.error(`[telegram] Callback mislukt: ${error.stack || error.message}`);
        await sendTelegramText(config, `Knopactie mislukt: ${truncate(error.message, 700)}\n\nGebruik /actions om het opnieuw te proberen.`);
      }
    }
  }
}

async function ensureTelegramPollingMode(config) {
  const info = await telegramApi(config, 'getWebhookInfo', {});
  const webhookUrl = info.result?.url || '';
  if (!webhookUrl) return;

  await telegramApi(config, 'deleteWebhook', { drop_pending_updates: false });
  console.log('[telegram] Actieve webhook verwijderd zodat GitHub Actions getUpdates kan pollen.');
}

async function handleTelegramCommand(config, state, message) {
  const chatId = String(message.chat?.id || '');
  if (config.telegram.chatId && chatId !== String(config.telegram.chatId)) {
    await telegramApi(config, 'sendMessage', {
      chat_id: chatId,
      text: 'Deze bot is ingesteld voor een andere chat.',
    });
    return;
  }

  const [rawCommand] = message.text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];
  console.log(`[telegram] Command ontvangen: ${command}`);

  if (['/start', '/help', '/actions'].includes(command)) {
    await sendActionsMenu(config);
    return;
  }

  if (command === '/top') {
    await sendTopListing(config, state);
    return;
  }

  if (command === '/status') {
    await sendStatus(config, state);
    return;
  }

  if (command === '/top10') {
    const progress = await createProgressReporter(config, 'Top 10 gestart', [
      'Telegram command is opgepakt door de GitHub-run.',
      'Ik haal nu alle woningen onder je filter op.',
    ]);
    await sendTop10(config, state, { progress });
    return;
  }

  if (command === '/list') {
    await sendCurrentList(config, state);
    return;
  }

  if (command === '/stats') {
    await sendMarketStats(config, state);
    return;
  }

  if (command === '/saved') {
    await sendSavedListings(config, state);
    return;
  }

  await sendTelegramText(config, 'Onbekend commando. Gebruik /actions om alle acties te zien.');
}

async function handleTelegramCallback(config, state, callback) {
  if (!callback?.data) return;

  const [action, listingId] = callback.data.split(':');
  console.log(`[telegram] Knopactie ontvangen: ${action}${listingId ? ` voor ${listingId}` : ''}`);
  await safeAnswerCallbackQuery(config, callback.id, callbackText(action));

  if (['interest', 'ignore', 'maybe'].includes(action) && listingId) {
    const decision = action === 'interest' ? 'interessant' : action === 'maybe' ? 'twijfel' : 'niet interessant';
    state.decisions[listingId] = {
      decision,
      decidedAt: new Date().toISOString(),
      from: callback.from?.username || callback.from?.first_name || 'telegram',
    };
    await sendTelegramText(config, `Genoteerd: ${decision}.`);
    return;
  }

  if (action === 'analysis' && listingId) {
    const listing = await getListingById(config, state, listingId);
    if (!listing) {
      await sendTelegramText(config, 'Ik kan deze woning niet meer vinden in de cache.');
      return;
    }
    const analysis = await getListingAnalysis(config, state, listing, { mode: 'full', forceRefresh: true });
    await sendTelegramText(config, formatAnalysisMessage(listing, analysis), inlineKeyboardForListing(listing), {
      parseMode: 'HTML',
    });
    return;
  }

  if (action === 'photos' && listingId) {
    const listing = await getListingById(config, state, listingId);
    if (!listing) {
      await sendTelegramText(config, 'Ik kan deze woning niet meer vinden in de cache.');
      return;
    }
    await sendListingPhotos(config, listing);
    return;
  }

  if (action === 'stats' && listingId) {
    const listing = await getListingById(config, state, listingId);
    if (!listing) {
      await sendTelegramText(config, 'Ik kan deze woning niet meer vinden in de cache.');
      return;
    }
    const marketListings = Object.values(state.listingCache || {}).map((entry) => entry.listing).filter(Boolean);
    await sendTelegramText(
      config,
      formatListingStats(listing, marketSnapshot(marketListings)),
      inlineKeyboardForListing(listing),
      { parseMode: 'HTML' },
    );
    return;
  }

  if (action === 'top') {
    await sendTopListing(config, state);
    return;
  }

  if (action === 'top10') {
    const progress = await createProgressReporter(config, 'Top 10 gestart', [
      'Je knopdruk is opgepakt door de GitHub-run.',
      'Ik ververs de ranking en stuur zo updates.',
    ]);
    await sendTop10(config, state, { forceRefresh: true, progress });
    return;
  }

  if (action === 'list') {
    await sendCurrentList(config, state);
    return;
  }

  if (action === 'statsall') {
    await sendMarketStats(config, state);
    return;
  }

  if (action === 'status') {
    await sendStatus(config, state);
    return;
  }

  if (action === 'saved') {
    await sendSavedListings(config, state);
    return;
  }

  if (action === 'help') {
    await sendActionsMenu(config);
  }
}

async function safeAnswerCallbackQuery(config, callbackQueryId, text) {
  try {
    await telegramApi(config, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  } catch (error) {
    console.warn(`[warn] Callback acknowledgement overgeslagen: ${error.message}`);
  }
}

function callbackText(action) {
  const labels = {
    interest: 'Opgeslagen als interessant.',
    ignore: 'Opgeslagen als niet interessant.',
    maybe: 'Opgeslagen als twijfel.',
    analysis: 'Analyse wordt gemaakt.',
    photos: 'Foto\'s worden opgehaald.',
    stats: 'Stats worden opgehaald.',
    top: 'Meest recente woning wordt opgehaald.',
    top10: 'Top 10 wordt gemaakt.',
    list: 'Lijst wordt opgehaald.',
    statsall: 'Marktstats worden opgehaald.',
    status: 'Status wordt opgehaald.',
    saved: 'Bewaarde woningen worden opgehaald.',
    help: 'Acties worden verstuurd.',
  };
  return labels[action] || 'Actie ontvangen.';
}

async function sendActionsMenu(config) {
  requireTelegramConfig(config);

  const openaiStatus = openaiEnabled(config) ? 'aan' : 'uit';
  const text = [
    '<b>🏠 Funda bot acties</b>',
    '',
    '<b>Snelle acties</b>',
    '📍 /status - laatste check en cache-status',
    '🆕 /top - meest recente woning volgens Funda-datum',
    '🏆 /top10 - uitgebreide top 10 met klikbare woningen',
    '🏠 /list - actuele woningen, gesorteerd op Funda-datum',
    '📊 /stats - marktstats met prijs/m² oordeel',
    '⭐ /saved - jouw keuzes',
    '🧭 /actions - dit menu opnieuw',
    '',
    '<b>Werking</b>',
    `🧠 OpenAI analyse: <b>${openaiStatus}</b>`,
    'Nieuwe woningen krijgen knoppen voor Funda, interesse, twijfel, afwijzen, stats, foto\'s en analyse.',
    '',
    'Laptop-runner reageert zolang je laptop aan staat. GitHub blijft als cloud-fallback aanwezig, maar schedules bleken minder betrouwbaar.',
  ].join('\n');

  await sendTelegramText(config, text, {
    inline_keyboard: [
      [{ text: '🆕 Meest recent', callback_data: 'top' }, { text: '🏆 Top 10 analyse', callback_data: 'top10' }],
      [{ text: '🏠 Actuele lijst', callback_data: 'list' }, { text: '📊 Marktstats', callback_data: 'statsall' }],
      [{ text: '📍 Status', callback_data: 'status' }, { text: '⭐ Bewaarde keuzes', callback_data: 'saved' }],
    ],
  }, { parseMode: 'HTML' });
}

async function createProgressReporter(config, title, initialLines = []) {
  if (DRY_RUN) {
    console.log(`[dry-run] Progress: ${title}\n${initialLines.join('\n')}`);
    return {
      async update(lines) {
        console.log(`[dry-run] Progress update:\n${lines.join('\n')}`);
      },
      async done(lines) {
        console.log(`[dry-run] Progress done:\n${lines.join('\n')}`);
      },
    };
  }

  const startedAt = Date.now();
  let lastEditAt = 0;
  const message = await sendTelegramText(config, formatProgressMessage(title, initialLines, startedAt), undefined, {
    returnLastMessage: true,
  });
  const messageId = message?.message_id;

  async function edit(lines) {
    if (!messageId) {
      await sendTelegramText(config, formatProgressMessage(title, lines, startedAt));
      return;
    }

    try {
      await telegramApi(config, 'editMessageText', {
        chat_id: config.telegram.chatId,
        message_id: messageId,
        text: formatProgressMessage(title, lines, startedAt),
        reply_markup: {
          inline_keyboard: [[{ text: 'Status', callback_data: 'status' }]],
        },
        disable_web_page_preview: true,
      });
    } catch (error) {
      if (!String(error.message).includes('message is not modified')) throw error;
    }
  }

  return {
    async update(lines, { force = false } = {}) {
      if (!force && Date.now() - lastEditAt < 2_500) return;
      lastEditAt = Date.now();
      await edit(lines);
    },
    async done(lines) {
      await edit(lines);
    },
  };
}

function formatProgressMessage(title, lines, startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return [
    title,
    '',
    ...lines,
    '',
    `Looptijd: ${seconds}s`,
    'Deze status wordt bijgewerkt zolang de GitHub-run bezig is.',
  ].join('\n');
}

async function sendStatus(config, state) {
  const lastCheck = state.lastCheckAt
    ? new Date(state.lastCheckAt).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })
    : 'nog niet bekend';
  const text = [
    '<b>📍 Botstatus</b>',
    '',
    `🕒 <b>Laatste check:</b> ${htmlEscape(lastCheck)}`,
    `🏠 <b>Woningen gezien:</b> ${Object.keys(state.seenListings || {}).length}`,
    `🧺 <b>Listing-cache:</b> ${Object.keys(state.listingCache || {}).length}`,
    `🧠 <b>Analyses-cache:</b> ${Object.keys(state.analyses || {}).length}`,
    `📄 <b>Laatste totaal aantal:</b> ${state.lastSearchCount || 0}`,
    `🏆 <b>Top10-cache:</b> ${state.top10Cache?.createdAt ? 'aanwezig' : 'leeg'}`,
    `🤖 <b>OpenAI:</b> ${openaiEnabled(config) ? 'aan' : 'uit'}`,
    '',
    'Gebruik /actions voor alle acties.',
  ].join('\n');

  await sendTelegramText(config, text, {
    inline_keyboard: [
      [{ text: '🏆 Top 10 analyse', callback_data: 'top10' }, { text: '📊 Marktstats', callback_data: 'statsall' }],
      [{ text: '🏠 Actuele lijst', callback_data: 'list' }],
    ],
  }, { parseMode: 'HTML' });
}

async function sendTopListing(config, state) {
  const listing = await getMostRecentListing(config, state);
  if (!listing) {
    await sendTelegramText(config, 'Geen woningen gevonden onder je filter.');
    return;
  }

  const analysis = openaiEnabled(config) ? await getListingAnalysis(config, state, listing, { mode: 'short' }) : null;
  listing.analysis = analysis;
  await sendTelegramListing(config, listing, { heading: 'Meest recente Funda-woning' });
}

async function sendCurrentList(config, state) {
  const previousSnapshot = await loadCurrentListingsSnapshot(config);
  const previousSnapshotIds = new Set((previousSnapshot.listings || []).map((listing) => listing.id));
  const listings = await getAllCurrentListings(config, state);
  if (listings.length === 0) {
    await sendTelegramText(config, 'Geen woningen gevonden onder je filter.');
    return;
  }

  const market = marketSnapshot(listings);
  const sorted = sortByNewestListedAt(listings, { previousSnapshotIds }).slice(0, 10);
  const text = [
    '<b>🏠 Actuele woningen</b>',
    '<i>Gesorteerd op Funda-datum, niet op positie op de website.</i>',
    '',
    ...sorted.map((listing, index) => formatCompactListingLineHtml(listing, index + 1, market)),
    '',
    'Gebruik <b>Top 10 analyse</b> voor de uitgebreide ranking.',
  ].join('\n');

  await sendTelegramText(config, text, {
    inline_keyboard: [[{ text: '🏆 Top 10 analyse', callback_data: 'top10' }, { text: '📊 Marktstats', callback_data: 'statsall' }]],
  }, { parseMode: 'HTML' });
}

async function sendMarketStats(config, state) {
  const progress = await createProgressReporter(config, 'Marktstats gestart', [
    'Ik haal de huidige filterresultaten op.',
    'Daarna bereken ik prijs, m2 en instapklaar-signalen.',
  ]);
  const listings = await getAllCurrentListings(config, state, { progress });
  if (listings.length === 0) {
    await sendTelegramText(config, 'Geen woningen gevonden onder je filter.');
    return;
  }

  const prices = listings.map((listing) => listing.price).filter(Number.isFinite);
  const ppm = listings.map((listing) => listing.pricePerM2).filter(Number.isFinite);
  const living = listings.map((listing) => listing.livingArea).filter(Number.isFinite);
  const market = marketSnapshot(listings);
  const best = rankListingsFallback(listings).slice(0, 5);
  const text = [
    '<b>📊 Marktstats voor je huidige filter</b>',
    '<i>Gebaseerd op de opgehaalde Funda-resultaten binnen jouw zoekfilter.</i>',
    '',
    `🏘️ <b>Aantal:</b> ${listings.length} woningen`,
    prices.length ? `💰 <b>Vraagprijs mediaan:</b> ${formatEuro(median(prices))}` : '',
    prices.length ? `⚖️ <b>Vraagprijs gemiddeld:</b> ${formatEuro(avg(prices))}` : '',
    ppm.length ? `📐 <b>Prijs per m² mediaan:</b> ${formatEuro(market.medianPricePerM2)}` : '',
    living.length ? `📏 <b>Woonoppervlak mediaan:</b> ${Math.round(median(living))} m²` : '',
    `✨ <b>Instapklaar hoog:</b> ${listings.filter((listing) => listing.readinessScore >= 70).length}`,
    `🌱 <b>Energielabel A/B/C:</b> ${listings.filter((listing) => ['A', 'A+', 'A++', 'A+++', 'A++++', 'B', 'C'].includes(listing.energyLabel)).length}`,
    '',
    '<b>🏅 Beste matches</b>',
    ...best.map((item, index) => formatCompactListingLineHtml(item.listing, index + 1, market, item.score)),
  ]
    .filter((line) => line !== '')
    .join('\n');

  await sendTelegramText(config, text, {
    inline_keyboard: [[{ text: '🏆 Top 10 analyse', callback_data: 'top10' }, { text: '🏠 Actuele lijst', callback_data: 'list' }]],
  }, { parseMode: 'HTML' });
  await progress.done(['Marktstats zijn verstuurd.']);
}

async function sendTop10(config, state, options = {}) {
  const progress = options.progress || (await createProgressReporter(config, 'Top 10 gestart', ['Ik zet de analyse klaar.']));
  const cached = state.top10Cache;
  if (!options.forceRefresh && cached && minutesAgo(cached.createdAt) < config.top10CacheMinutes) {
    await progress.update(['Ik gebruik de bestaande top10-cache.', 'Resultaten worden nu verstuurd.'], { force: true });
    await sendTop10Result(config, state, cached.result, { cached: true });
    await progress.done(['Top 10 uit cache is verstuurd.']);
    return;
  }

  await progress.update(['Stap 1/4: zoekresultaatpagina\'s ophalen.'], { force: true });
  const listings = await getAllCurrentListings(config, state, { progress });
  if (listings.length === 0) {
    await sendTelegramText(config, 'Geen woningen gevonden onder je filter.');
    await progress.done(['Geen woningen gevonden onder je filter.']);
    return;
  }

  await progress.update([`Stap 3/4: ${listings.length} woningen ranken met ${openaiEnabled(config) ? 'OpenAI' : 'lokale score'}.`], {
    force: true,
  });
  const result = openaiEnabled(config)
    ? await rankListingsWithOpenAi(config, listings)
    : rankListingsFallback(listings).slice(0, 10).map((item) => ({
        id: item.listing.id,
        score: item.score,
        reason: item.reason,
        risks: item.risks,
      }));

  state.top10Cache = {
    createdAt: new Date().toISOString(),
    result,
  };

  await progress.update(['Stap 4/4: top 10 versturen naar Telegram.'], { force: true });
  await sendTop10Result(config, state, result, { cached: false });
  await progress.done(['Top 10 is klaar en verstuurd.', 'Je krijgt ook woningkaarten van de top 3.']);
}

async function sendTop10Result(config, state, result, { cached }) {
  const listings = [];
  for (const item of result.slice(0, 10)) {
    const listing = await getListingById(config, state, item.id);
    if (listing) listings.push({ item, listing });
  }

  const market = marketSnapshot(Object.values(state.listingCache || {}).map((entry) => entry.listing).filter(Boolean));
  const cacheLabel = cached ? ' <i>(cache)</i>' : '';
  const lines = [`<b>🏆 Top 10 Funda-filter</b>${cacheLabel}`, '<i>Prijs, ruimte, instapklaar-signalen en analyse samengevat.</i>', ''];

  for (const [index, { item, listing }] of listings.entries()) {
    lines.push(formatTop10ItemHtml(listing, item, index + 1, market));
    lines.push('');
  }

  const text = splitTelegramText(lines.join('\n').trim());
  for (const part of text) {
    await sendTelegramText(config, part, undefined, { parseMode: 'HTML' });
    await sleep(350);
  }

  const topListings = listings.slice(0, 3).map(({ listing }) => listing);

  for (const [index, listing] of topListings.entries()) {
    await sendTelegramListing(config, listing, { heading: `Top ${index + 1}` });
    await sleep(650);
  }
}

async function sendSavedListings(config, state) {
  const entries = Object.entries(state.decisions || {});
  if (entries.length === 0) {
    await sendTelegramText(config, 'Je hebt nog geen woningen gemarkeerd.');
    return;
  }

  const lines = ['<b>⭐ Jouw gemarkeerde woningen</b>', ''];
  for (const [id, decision] of entries.slice(-20).reverse()) {
    const listing = await getListingById(config, state, id);
    const title = listing ? htmlLink(listing.title, listing.url) : `Woning ${htmlEscape(id)}`;
    lines.push(`${decisionEmoji(decision.decision)} <b>${htmlEscape(decision.decision)}:</b> ${title}`);
    lines.push('');
  }

  await sendTelegramText(config, lines.join('\n').trim(), undefined, { parseMode: 'HTML' });
}

async function getAllCurrentListings(config, state, { progress } = {}) {
  const urls = await fetchSearchListingUrls(config, { allPages: true, progress });
  const limitedUrls = urls.slice(0, config.maxTop10Listings);
  const listings = [];

  for (const [index, url] of limitedUrls.entries()) {
    console.log(`[detail] ${index + 1}/${limitedUrls.length}: ${url}`);
    if (progress && (index === 0 || (index + 1) % 5 === 0 || index + 1 === limitedUrls.length)) {
      await progress.update([
        `Stap 2/4: woningdetails ophalen.`,
        `Details: ${index + 1}/${limitedUrls.length}`,
        `Gevonden URLs: ${urls.length}`,
      ]);
    }
    listings.push(await getListingDetails(config, state, url));
    await sleep(500);
  }

  return listings;
}

async function getMostRecentListing(config, state) {
  const previousSnapshot = await loadCurrentListingsSnapshot(config);
  const previousSnapshotIds = new Set((previousSnapshot.listings || []).map((listing) => listing.id));
  const listings = await getAllCurrentListings(config, state);
  return sortByNewestListedAt(listings, { previousSnapshotIds })[0] || null;
}

function sortByNewestListedAt(listings, { previousSnapshotIds } = {}) {
  return [...listings].sort((a, b) => {
    const aTime = a.listedAt ? Date.parse(a.listedAt) : 0;
    const bTime = b.listedAt ? Date.parse(b.listedAt) : 0;
    if (aTime !== bTime) return bTime - aTime;
    if (previousSnapshotIds) {
      const aIsNew = !previousSnapshotIds.has(a.id);
      const bIsNew = !previousSnapshotIds.has(b.id);
      if (aIsNew !== bIsNew) return Number(bIsNew) - Number(aIsNew);
    }
    return Number(b.id || 0) - Number(a.id || 0);
  });
}

async function fetchSearchListingUrls(config, { allPages, progress, maxPages: requestedMaxPages } = {}) {
  const urls = [];
  const seen = new Set();
  const maxPages = requestedMaxPages || (allPages ? config.maxSearchPages : 1);

  for (let page = 1; page <= maxPages; page += 1) {
    if (progress) {
      await progress.update([
        'Stap 1/4: zoekresultaatpagina\'s ophalen.',
        `Pagina: ${page}/${maxPages}`,
        `Woningen gevonden tot nu toe: ${urls.length}`,
      ]);
    }
    const pageUrl = page === 1 ? config.searchUrl : withSearchParam(config.searchUrl, 'page', String(page));
    const html = await fetchText(pageUrl, config);
    const pageUrls = extractListingUrls(html);
    const newPageUrls = pageUrls.filter((url) => !seen.has(url));

    for (const url of newPageUrls) {
      seen.add(url);
      urls.push(url);
    }

    if (!allPages || pageUrls.length === 0 || newPageUrls.length === 0) break;
    await sleep(550);
  }

  return urls;
}

async function getListingDetails(config, state, url, { refresh = false } = {}) {
  const id = listingIdFromUrl(url);
  const cached = state.listingCache?.[id];
  if (!refresh && cached?.listing && minutesAgo(cached.fetchedAt) < 360 && !hasInvalidListedDate(cached.listing)) {
    return cached.listing;
  }

  const listing = await fetchListingDetails(url, config);
  state.listingCache[id] = {
    fetchedAt: new Date().toISOString(),
    listing,
  };
  state.seenListings[id] = state.seenListings[id] || {
    url: listing.url,
    title: listing.title,
    firstSeenAt: new Date().toISOString(),
  };
  return listing;
}

async function getListingById(config, state, listingId) {
  if (state.listingCache?.[listingId]?.listing) return state.listingCache[listingId].listing;
  const url = state.seenListings?.[listingId]?.url;
  if (!url) return null;
  return getListingDetails(config, state, url);
}

async function fetchListingDetails(url, config) {
  const html = await fetchText(url, config);
  const jsonLd = extractListingJsonLd(html);
  const labels = [
    'Vraagprijs',
    'Vraagprijs per m2',
    'Vraagprijs per m²',
    'Wonen',
    'Aantal kamers',
    'Aantal slaapkamers',
    'Energielabel',
    'Bouwjaar',
    'Aanvaarding',
    'Aangeboden sinds',
    'Soort appartement',
    'Servicekosten',
    'Ligging',
    'Buitenruimte',
    'Schuur/berging',
    'VvE checklist',
  ];
  const features = extractFeatures(html, labels);
  const price = numberFromValue(jsonLd?.offers?.price) || euroNumber(features.Vraagprijs);
  const livingArea = numberFromValue(features.Wonen);
  const pricePerM2 =
    euroNumber(features['Vraagprijs per m2']) ||
    euroNumber(features['Vraagprijs per m²']) ||
    (price && livingArea ? Math.round(price / livingArea) : null);
  const description = cleanText(extractMetaContent(html, 'description') || jsonLd?.description || '');
  const title = [jsonLd?.address?.streetAddress || jsonLd?.name || titleFromUrl(url), jsonLd?.address?.addressLocality]
    .filter(Boolean)
    .join(', ');
  const roomsText = features['Aantal kamers'] || '';
  const bedrooms = numberFromValue(features['Aantal slaapkamers']) || bedroomsFromRoomsText(roomsText);
  const energyLabel = cleanEnergyLabel(features.Energielabel);
  const photos = extractPhotos(jsonLd).slice(0, 12);
  const readiness = estimateReadiness({ description, features, photos });
  const listedDateText = normalizeListedDateText(features['Aangeboden sinds']) || extractListedDateText(html);
  const listedAt = parseDutchNumericDate(listedDateText);

  return {
    id: listingIdFromUrl(url),
    url: normalizeFundaUrl(url),
    title,
    price,
    priceText: features.Vraagprijs || formatEuro(price),
    pricePerM2,
    livingArea,
    rooms: roomsText,
    bedrooms,
    energyLabel,
    buildYear: numberFromValue(features.Bouwjaar),
    acceptance: features.Aanvaarding || '',
    listedAt,
    listedDateText,
    apartmentType: features['Soort appartement'] || '',
    serviceCosts: features.Servicekosten || '',
    location: features.Ligging || '',
    outdoor: features.Buitenruimte || '',
    storage: features['Schuur/berging'] || '',
    vve: features['VvE checklist'] || '',
    features,
    description,
    photos,
    readinessScore: readiness.score,
    readinessReason: readiness.reason,
    summary: buildSummary({ title, description, features, priceText: features.Vraagprijs || formatEuro(price), pricePerM2 }),
  };
}

async function getListingAnalysis(config, state, listing, { mode = 'short', forceRefresh = false } = {}) {
  const cached = state.analyses?.[listing.id]?.[mode];
  if (!forceRefresh && cached && minutesAgo(cached.createdAt) < 240) return cached.analysis;

  const fallback = fallbackListingAnalysis(listing);
  if (!openaiEnabled(config)) return fallback;

  try {
    const analysis = await analyzeListingWithOpenAi(config, listing, mode);
    state.analyses[listing.id] = state.analyses[listing.id] || {};
    state.analyses[listing.id][mode] = {
      createdAt: new Date().toISOString(),
      analysis,
    };
    return analysis;
  } catch (error) {
    console.warn(`[warn] OpenAI analyse mislukt voor ${listing.id}: ${error.message}`);
    return fallback;
  }
}

async function analyzeListingWithOpenAi(config, listing, mode) {
  const prompt = [
    'Je bent mijn aankoop-assistent voor appartementen rond Alkmaar.',
    'Ik zoek vooral instapklare woningen: binnen netjes, weinig kluswerk, leeg is acceptabel, mooi ingericht is extra positief.',
    'Wees praktisch, kritisch en kort. Geef geen juridisch of financieel advies, maar wel aandachtspunten.',
    'Gebruik score en readiness altijd op een schaal van 0 tot 100, waarbij 50 middelmatig is en 80+ sterk.',
    '',
    `Analysemodus: ${mode}`,
    `Titel: ${listing.title}`,
    `Prijs: ${listing.priceText || formatEuro(listing.price)}`,
    `Prijs per m2: ${listing.pricePerM2 ? formatEuro(listing.pricePerM2) : 'onbekend'}`,
    `Wonen: ${listing.livingArea || 'onbekend'} m2`,
    `Kamers: ${listing.rooms || 'onbekend'}`,
    `Slaapkamers: ${listing.bedrooms || 'onbekend'}`,
    `Energielabel: ${listing.energyLabel || 'onbekend'}`,
    `Bouwjaar: ${listing.buildYear || 'onbekend'}`,
    `Aanvaarding: ${listing.acceptance || 'onbekend'}`,
    `Type: ${listing.apartmentType || 'onbekend'}`,
    `Servicekosten: ${listing.serviceCosts || 'onbekend'}`,
    `Ligging: ${listing.location || 'onbekend'}`,
    `Buitenruimte: ${listing.outdoor || 'onbekend'}`,
    `Omschrijving: ${truncate(listing.description, 1800)}`,
    '',
    'Geef een compacte analyse volgens het gevraagde JSON-schema.',
  ].join('\n');

  const content = [{ type: 'input_text', text: prompt }];
  for (const photo of listing.photos.slice(0, config.maxAnalysisPhotos)) {
    content.push({ type: 'input_image', image_url: photo });
  }

  let data = await openAiResponses(config, content, analysisJsonSchema());
  let text = extractOpenAiText(data);
  let parsed = parseJsonObject(text);

  if (!parsed && content.length > 1) {
    data = await openAiResponses(config, [{ type: 'input_text', text: prompt }], analysisJsonSchema());
    text = extractOpenAiText(data);
    parsed = parseJsonObject(text);
  }

  if (!parsed) throw new Error(`OpenAI gaf geen bruikbare JSON: ${truncate(text, 300)}`);

  return normalizeAnalysis(parsed);
}

async function rankListingsWithOpenAi(config, listings) {
  const compactListings = listings.map((listing) => ({
    id: listing.id,
    title: listing.title,
    price: listing.price,
    pricePerM2: listing.pricePerM2,
    livingArea: listing.livingArea,
    rooms: listing.rooms,
    bedrooms: listing.bedrooms,
    energyLabel: listing.energyLabel,
    buildYear: listing.buildYear,
    serviceCosts: listing.serviceCosts,
    readinessScore: listing.readinessScore,
    readinessReason: listing.readinessReason,
    description: truncate(listing.description, 700),
    photoCount: listing.photos.length,
  }));

  const prompt = [
    'Maak een top 10 van deze Funda-appartementen voor mij.',
    'Mijn voorkeur: instapklaar, mooi/netjes interieur, weinig kluswerk, leeg is acceptabel, goede prijs per m2, voldoende ruimte, liefst energie niet dramatisch.',
    'Gebruik de tekst en stats. Foto-URLs zijn eerder per woning bekeken door de listing-analyse niet gegarandeerd, dus wees eerlijk over onzekerheid.',
    'Geef de ranking volgens het gevraagde JSON-schema.',
    '',
    JSON.stringify(compactListings),
  ].join('\n');

  try {
    const data = await openAiResponses(config, [{ type: 'input_text', text: prompt }], rankingJsonSchema());
    const parsed = parseJsonObject(extractOpenAiText(data));
    if (!Array.isArray(parsed?.rankings)) throw new Error('Geen rankings-array');
    return parsed.rankings
      .filter((item) => item?.id)
      .slice(0, 10)
      .map((item) => ({
        id: String(item.id),
        score: clamp(Number(item.score) || 0, 0, 100),
        reason: cleanText(item.reason || ''),
        risks: cleanText(item.risks || ''),
      }));
  } catch (error) {
    console.warn(`[warn] OpenAI top10 mislukt: ${error.message}`);
    return rankListingsFallback(listings).slice(0, 10).map((item) => ({
      id: item.listing.id,
      score: item.score,
      reason: item.reason,
      risks: item.risks,
    }));
  }
}

async function openAiResponses(config, content, textFormat) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.openai.model,
      input: [{ role: 'user', content }],
      text: { format: textFormat },
      temperature: 0.2,
      max_output_tokens: 2200,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function analysisJsonSchema() {
  return {
    type: 'json_schema',
    name: 'funda_listing_analysis',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        score: { type: 'number', minimum: 0, maximum: 100 },
        readiness: { type: 'number', minimum: 0, maximum: 100 },
        summary: { type: 'string' },
        pros: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        cons: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        interior: { type: 'string' },
        action: { type: 'string' },
      },
      required: ['score', 'readiness', 'summary', 'pros', 'cons', 'interior', 'action'],
    },
  };
}

function rankingJsonSchema() {
  return {
    type: 'json_schema',
    name: 'funda_top10_ranking',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rankings: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              score: { type: 'number', minimum: 0, maximum: 100 },
              reason: { type: 'string' },
              risks: { type: 'string' },
            },
            required: ['id', 'score', 'reason', 'risks'],
          },
        },
      },
      required: ['rankings'],
    },
  };
}

function extractOpenAiText(data) {
  if (data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
      else if (content.text && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function fallbackListingAnalysis(listing) {
  const score = fallbackScore(listing);
  return {
    score,
    readiness: listing.readinessScore,
    summary: `${listing.title} scoort ${score}/100 op basis van prijs, m2, energielabel en instapklaar-signalen.`,
    pros: fallbackPros(listing),
    cons: fallbackCons(listing),
    interior: listing.readinessReason,
    action: score >= 78 ? 'Snel bekijken en eventueel reageren.' : score >= 65 ? 'Interessant genoeg om te vergelijken.' : 'Alleen bewaren als locatie of prijs heel aantrekkelijk is.',
  };
}

function rankListingsFallback(listings) {
  return listings
    .map((listing) => ({
      listing,
      score: fallbackScore(listing),
      reason: fallbackPros(listing).join('; '),
      risks: fallbackCons(listing).join('; '),
    }))
    .sort((a, b) => b.score - a.score);
}

function fallbackScore(listing) {
  let score = 50;
  if (listing.readinessScore) score += (listing.readinessScore - 50) * 0.35;
  if (listing.pricePerM2 && listing.pricePerM2 < 3800) score += 12;
  else if (listing.pricePerM2 && listing.pricePerM2 < 4500) score += 6;
  else if (listing.pricePerM2 && listing.pricePerM2 > 5200) score -= 10;
  if (listing.livingArea >= 75) score += 8;
  else if (listing.livingArea >= 65) score += 4;
  if (['A', 'A+', 'A++', 'A+++', 'A++++', 'B', 'C'].includes(listing.energyLabel)) score += 8;
  if (['E', 'F', 'G'].includes(listing.energyLabel)) score -= 8;
  if (listing.bedrooms >= 2) score += 4;
  if (listing.serviceCosts && numberFromValue(listing.serviceCosts) > 250) score -= 5;
  return clamp(Math.round(score), 0, 100);
}

function fallbackPros(listing) {
  const pros = [];
  if (listing.readinessScore >= 70) pros.push('goede instapklaar-signalen');
  if (listing.pricePerM2 && listing.pricePerM2 < 4200) pros.push('relatief sterke prijs per m2');
  if (listing.livingArea >= 70) pros.push('fijn woonoppervlak');
  if (['A', 'A+', 'A++', 'A+++', 'A++++', 'B', 'C'].includes(listing.energyLabel)) pros.push(`energielabel ${listing.energyLabel}`);
  if (listing.bedrooms >= 2) pros.push('minstens twee slaapkamers');
  return pros.length ? pros : ['past binnen je basisfilter'];
}

function fallbackCons(listing) {
  const cons = [];
  if (listing.readinessScore < 50) cons.push('mogelijk kluswerk of gedateerde staat');
  if (listing.pricePerM2 && listing.pricePerM2 > 5000) cons.push('hoge prijs per m2');
  if (['E', 'F', 'G'].includes(listing.energyLabel)) cons.push(`laag energielabel ${listing.energyLabel}`);
  if (listing.serviceCosts && numberFromValue(listing.serviceCosts) > 250) cons.push('servicekosten lijken hoog');
  return cons.length ? cons : ['geen grote rode vlag uit de beschikbare tekst'];
}

function normalizeAnalysis(value) {
  return {
    score: clamp(Number(value.score) || 0, 0, 100),
    readiness: clamp(Number(value.readiness) || 0, 0, 100),
    summary: cleanText(value.summary || ''),
    pros: arrayOfText(value.pros).slice(0, 4),
    cons: arrayOfText(value.cons).slice(0, 4),
    interior: cleanText(value.interior || ''),
    action: cleanText(value.action || ''),
  };
}

async function notifyNewListing(config, listing) {
  if (DRY_RUN || (!config.telegram.enabled && !config.ntfy.enabled)) {
    console.log(`[dry-run] Nieuwe woning:\n${formatListingMessage(listing, 'Nieuwe Funda-match')}`);
    return;
  }

  if (config.telegram.enabled) await sendTelegramListing(config, listing, { heading: 'Nieuwe Funda-match' });
  if (config.ntfy.enabled) await sendNtfyListing(config, listing);
}

async function sendTelegramListing(config, listing, { heading }) {
  if (DRY_RUN) {
    console.log(`[dry-run] Telegram listing:\n${formatListingMessage(listing, heading)}`);
    return;
  }

  requireTelegramConfig(config);

  const caption = truncate(formatListingMessageHtml(listing, heading), 1000);
  const replyMarkup = inlineKeyboardForListing(listing);

  if (listing.photos[0]) {
    await telegramApi(config, 'sendPhoto', {
      chat_id: config.telegram.chatId,
      photo: listing.photos[0],
      caption,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  } else {
    await sendTelegramText(config, caption, replyMarkup, { parseMode: 'HTML' });
  }
}

async function sendListingPhotos(config, listing) {
  if (DRY_RUN) {
    console.log(`[dry-run] ${listing.photos.length} foto(s) voor ${listing.title}`);
    return;
  }

  if (!listing.photos.length) {
    await sendTelegramText(config, 'Deze woning heeft geen foto-URLs in de gevonden metadata.');
    return;
  }

  await sendTelegramText(config, `Foto's voor ${listing.title}`);
  for (const photo of listing.photos.slice(0, config.maxPhotos)) {
    await telegramApi(config, 'sendPhoto', {
      chat_id: config.telegram.chatId,
      photo,
    });
    await sleep(350);
  }
}

function inlineKeyboardForListing(listing) {
  return {
    inline_keyboard: [
      [{ text: '🔎 Bekijk op Funda', url: listing.url }],
      [
        { text: '⭐ Interessant', callback_data: `interest:${listing.id}` },
        { text: '🤔 Twijfel', callback_data: `maybe:${listing.id}` },
        { text: '🚫 Nee', callback_data: `ignore:${listing.id}` },
      ],
      [
        { text: '🧠 Analyse', callback_data: `analysis:${listing.id}` },
        { text: '📊 Stats', callback_data: `stats:${listing.id}` },
        { text: '📸 Foto\'s', callback_data: `photos:${listing.id}` },
      ],
    ],
  };
}

function formatListingMessageHtml(listing, heading, market = null) {
  const score = listing.analysis?.score ?? fallbackScore(listing);
  const priceLabel = pricePerM2Label(listing, market);
  const lines = [
    `<b>${htmlEscape(heading)}</b>`,
    htmlLink(listing.title, listing.url),
    '',
    `${ratingEmoji(score)} <b>Eindrating:</b> ${formatRating(score)}`,
    listing.analysis ? `🧠 <b>AI-score:</b> ${formatRating(listing.analysis.score)}` : '',
    `✨ <b>Instapklaar:</b> ${formatRating(listing.analysis?.readiness ?? listing.readinessScore)}`,
    '',
    listing.priceText ? `💰 <b>Prijs:</b> ${htmlEscape(listing.priceText)}` : '',
    listing.pricePerM2 ? `📐 <b>Prijs/m²:</b> ${formatEuro(listing.pricePerM2)} ${htmlEscape(priceLabel)}` : '',
    listing.livingArea ? `📏 <b>Wonen:</b> ${listing.livingArea} m²` : '',
    listing.rooms ? `🛏️ <b>Kamers:</b> ${htmlEscape(listing.rooms)}` : '',
    listing.energyLabel ? `🌱 <b>Energielabel:</b> ${htmlEscape(listing.energyLabel)}` : '',
    listing.buildYear ? `🏗️ <b>Bouwjaar:</b> ${listing.buildYear}` : '',
    listing.listedDateText ? `🗓️ <b>Op Funda:</b> ${htmlEscape(listing.listedDateText)}` : '',
    listing.serviceCosts ? `🏢 <b>Servicekosten:</b> ${htmlEscape(listing.serviceCosts)}` : '',
    '',
    '<b>Samenvatting</b>',
    htmlEscape(truncate(listing.analysis?.summary || listing.summary, 650)),
    listing.analysis?.interior ? `\n🛋️ <b>Interieur:</b> ${htmlEscape(listing.analysis.interior)}` : '',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

function formatListingMessage(listing, heading) {
  const lines = [
    `${heading}`,
    '====================',
    listing.title,
    '',
    listing.priceText ? `Prijs: ${listing.priceText}` : '',
    listing.pricePerM2 ? `Prijs per m2: ${formatEuro(listing.pricePerM2)}` : '',
    listing.livingArea ? `Wonen: ${listing.livingArea} m2` : '',
    listing.rooms ? `Kamers: ${listing.rooms}` : '',
    listing.energyLabel ? `Energielabel: ${listing.energyLabel}` : '',
    listing.buildYear ? `Bouwjaar: ${listing.buildYear}` : '',
    listing.listedDateText ? `Op Funda: ${listing.listedDateText}` : '',
    listing.serviceCosts ? `Servicekosten: ${listing.serviceCosts}` : '',
    listing.readinessScore ? `Instapklaar: ${scoreBar(listing.readinessScore)} ${listing.readinessScore}/100` : '',
    listing.analysis ? `AI-score: ${scoreBar(listing.analysis.score)} ${listing.analysis.score}/100` : '',
    '',
    'Samenvatting',
    '------------',
    listing.analysis?.summary || listing.summary,
    listing.analysis?.interior ? `Interieur: ${listing.analysis.interior}` : '',
    '',
    listing.url,
  ];
  return lines.filter((line) => line !== '').join('\n');
}

function formatAnalysisMessage(listing, analysis) {
  const score = analysis.score;
  return [
    '<b>🧠 Analyse</b>',
    htmlLink(listing.title, listing.url),
    '',
    `${ratingEmoji(score)} <b>Eindrating:</b> ${formatRating(score)}`,
    `✨ <b>Instapklaar:</b> ${formatRating(analysis.readiness)}`,
    '',
    htmlEscape(analysis.summary),
    '',
    analysis.pros.length ? `✅ <b>Plus:</b> ${htmlEscape(analysis.pros.join('; '))}` : '',
    analysis.cons.length ? `⚠️ <b>Let op:</b> ${htmlEscape(analysis.cons.join('; '))}` : '',
    analysis.interior ? `🛋️ <b>Interieur:</b> ${htmlEscape(analysis.interior)}` : '',
    analysis.action ? `🎯 <b>Actie:</b> ${htmlEscape(analysis.action)}` : '',
    '',
    htmlLink('Open woning op Funda', listing.url),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function formatListingStats(listing, market = null) {
  const score = fallbackScore(listing);
  return [
    '<b>📊 Woningstats</b>',
    htmlLink(listing.title, listing.url),
    '',
    `${ratingEmoji(score)} <b>Eindrating:</b> ${formatRating(score)}`,
    listing.priceText ? `💰 <b>Prijs:</b> ${htmlEscape(listing.priceText)}` : '',
    listing.pricePerM2 ? `📐 <b>Prijs/m²:</b> ${formatEuro(listing.pricePerM2)} ${htmlEscape(pricePerM2Label(listing, market))}` : '',
    market?.medianPricePerM2 ? `📍 <b>Filtermediaan:</b> ${formatEuro(market.medianPricePerM2)}/m²` : '',
    listing.livingArea ? `📏 <b>Wonen:</b> ${listing.livingArea} m²` : '',
    listing.rooms ? `🛏️ <b>Kamers:</b> ${htmlEscape(listing.rooms)}` : '',
    listing.bedrooms ? `🚪 <b>Slaapkamers:</b> ${listing.bedrooms}` : '',
    listing.energyLabel ? `🌱 <b>Energielabel:</b> ${htmlEscape(listing.energyLabel)}` : '',
    listing.buildYear ? `🏗️ <b>Bouwjaar:</b> ${listing.buildYear}` : '',
    listing.listedDateText ? `🗓️ <b>Op Funda:</b> ${htmlEscape(listing.listedDateText)}` : '',
    listing.acceptance ? `🔑 <b>Aanvaarding:</b> ${htmlEscape(listing.acceptance)}` : '',
    listing.apartmentType ? `🏢 <b>Type:</b> ${htmlEscape(listing.apartmentType)}` : '',
    listing.serviceCosts ? `🧾 <b>Servicekosten:</b> ${htmlEscape(listing.serviceCosts)}` : '',
    listing.location ? `📍 <b>Ligging:</b> ${htmlEscape(listing.location)}` : '',
    listing.outdoor ? `🌤️ <b>Buitenruimte:</b> ${htmlEscape(listing.outdoor)}` : '',
    listing.storage ? `📦 <b>Berging:</b> ${htmlEscape(listing.storage)}` : '',
    `✨ <b>Instapklaar:</b> ${formatRating(listing.readinessScore)}`,
    `📝 <b>Samenvatting:</b> ${htmlEscape(listing.readinessReason)}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function compactListingLine(listing) {
  const bits = [
    listing.title,
    listing.priceText || formatEuro(listing.price),
    listing.pricePerM2 ? `${formatEuro(listing.pricePerM2)}/m2` : '',
    listing.livingArea ? `${listing.livingArea} m2` : '',
    listing.energyLabel ? `label ${listing.energyLabel}` : '',
    `ready ${listing.readinessScore}/100`,
  ].filter(Boolean);
  return bits.join(' - ');
}

function formatCompactListingLineHtml(listing, index, market = null, score = fallbackScore(listing)) {
  const bits = [
    `${index}. ${htmlLink(listing.title, listing.url)}`,
    `${ratingEmoji(score)} ${formatRating(score)}`,
    listing.priceText ? `💰 ${htmlEscape(listing.priceText)}` : '',
    listing.pricePerM2 ? `📐 ${formatEuro(listing.pricePerM2)}/m² ${htmlEscape(pricePerM2Label(listing, market))}` : '',
    listing.livingArea ? `📏 ${listing.livingArea} m²` : '',
    listing.listedDateText ? `🗓️ ${htmlEscape(listing.listedDateText)}` : '',
  ].filter(Boolean);
  return bits.join('\n');
}

function formatTop10ItemHtml(listing, item, index, market) {
  const score = clamp(Math.round(Number(item.score) || fallbackScore(listing)), 0, 100);
  const lines = [
    `<b>${index}.</b> ${htmlLink(listing.title, listing.url)}`,
    `${ratingEmoji(score)} <b>Rating:</b> ${formatRating(score)}`,
    listing.priceText ? `💰 ${htmlEscape(listing.priceText)}` : '',
    listing.pricePerM2 ? `📐 ${formatEuro(listing.pricePerM2)}/m² ${htmlEscape(pricePerM2Label(listing, market))}` : '',
    listing.livingArea ? `📏 ${listing.livingArea} m²` : '',
    listing.energyLabel ? `🌱 Label ${htmlEscape(listing.energyLabel)}` : '',
    listing.listedDateText ? `🗓️ Op Funda: ${htmlEscape(listing.listedDateText)}` : '',
    item.reason ? `✅ ${htmlEscape(truncate(item.reason, 230))}` : '',
    item.risks ? `⚠️ ${htmlEscape(truncate(item.risks, 190))}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function marketSnapshot(listings) {
  const pricePerM2Values = listings.map((listing) => listing?.pricePerM2).filter(Number.isFinite);
  return {
    medianPricePerM2: pricePerM2Values.length ? Math.round(median(pricePerM2Values)) : null,
  };
}

function pricePerM2Label(listing, market = null) {
  if (!listing.pricePerM2) return '';
  const medianPricePerM2 = market?.medianPricePerM2;
  if (medianPricePerM2) {
    const ratio = listing.pricePerM2 / medianPricePerM2;
    if (ratio <= 0.9) return '(goedkoop voor dit filter)';
    if (ratio >= 1.12) return '(duur voor dit filter)';
    return '(marktconform)';
  }
  if (listing.pricePerM2 < 3800) return '(goedkoop)';
  if (listing.pricePerM2 > 5200) return '(duur)';
  return '(marktconform)';
}

function formatRating(score) {
  const normalized = clamp(Math.round(Number(score) || 0), 0, 100);
  const label = normalized >= 85 ? 'uitstekend' : normalized >= 75 ? 'sterk' : normalized >= 65 ? 'goed' : normalized >= 50 ? 'twijfel' : 'zwak';
  return `${scoreBar(normalized)} ${normalized}/100 - ${label}`;
}

function ratingEmoji(score) {
  const normalized = clamp(Math.round(Number(score) || 0), 0, 100);
  if (normalized >= 85) return '🔥';
  if (normalized >= 75) return '⭐';
  if (normalized >= 65) return '✅';
  if (normalized >= 50) return '🤔';
  return '⚠️';
}

function decisionEmoji(decision) {
  if (decision === 'interessant') return '⭐';
  if (decision === 'twijfel') return '🤔';
  return '🚫';
}

function scoreBar(score) {
  const normalized = clamp(Math.round(Number(score) || 0), 0, 100);
  const filled = Math.round(normalized / 10);
  return `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}]`;
}

async function sendTelegramText(config, text, replyMarkup = undefined, options = {}) {
  if (DRY_RUN) {
    console.log(`[dry-run] Telegram tekst:\n${text}`);
    if (replyMarkup) console.log(`[dry-run] Reply markup: ${JSON.stringify(replyMarkup)}`);
    return { message_id: 0 };
  }

  requireTelegramConfig(config);
  const parts = splitTelegramText(text);
  let lastMessage = null;
  for (const [index, part] of parts.entries()) {
    const data = await telegramApi(config, 'sendMessage', {
      chat_id: config.telegram.chatId,
      text: part,
      reply_markup: index === parts.length - 1 ? replyMarkup : undefined,
      disable_web_page_preview: false,
      parse_mode: options.parseMode,
    });
    lastMessage = data.result;
    await sleep(250);
  }
  return options.returnLastMessage ? lastMessage : undefined;
}

async function sendNtfyListing(config, listing) {
  if (!config.ntfy.topic) throw new Error('ntfy.enabled staat aan, maar ntfy.topic is leeg.');

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
    body: formatListingMessage(listing, 'Nieuwe Funda-match'),
  });

  if (!response.ok) throw new Error(`ntfy HTTP ${response.status}: ${await response.text()}`);
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
  config.maxSearchPages = Number(process.env.MAX_SEARCH_PAGES || config.maxSearchPages);
  config.maxTop10Listings = Number(process.env.MAX_TOP10_LISTINGS || config.maxTop10Listings);
  config.maxAnalysisPhotos = Number(process.env.MAX_ANALYSIS_PHOTOS || config.maxAnalysisPhotos);
  config.top10CacheMinutes = Number(process.env.TOP10_CACHE_MINUTES || config.top10CacheMinutes);
  config.notifyNoNewListings = boolFromEnv('NOTIFY_NO_NEW_LISTINGS', config.notifyNoNewListings);
  config.noNewNotificationMinutes = Number(process.env.NO_NEW_NOTIFICATION_MINUTES || config.noNewNotificationMinutes);
  config.maxNotificationListingAgeDays = Number(
    process.env.MAX_NOTIFICATION_LISTING_AGE_DAYS || config.maxNotificationListingAgeDays,
  );
  config.currentListingsSnapshotFile = process.env.CURRENT_LISTINGS_SNAPSHOT_FILE || config.currentListingsSnapshotFile;
  config.stateFile = process.env.STATE_FILE || config.stateFile;
  config.userAgent = process.env.USER_AGENT || config.userAgent;

  config.telegram.enabled = boolFromEnv('TELEGRAM_ENABLED', config.telegram.enabled);
  config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || config.telegram.botToken;
  config.telegram.chatId = process.env.TELEGRAM_CHAT_ID || config.telegram.chatId;
  config.telegram.callbackPollSeconds = Number(
    process.env.TELEGRAM_CALLBACK_POLL_SECONDS || config.telegram.callbackPollSeconds,
  );

  config.openai.enabled = boolFromEnv('OPENAI_ENABLED', config.openai.enabled);
  config.openai.apiKey = process.env.OPENAI_API_KEY || config.openai.apiKey;
  config.openai.model = process.env.OPENAI_MODEL || config.openai.model;
  config.openai.autoAnalyzeNewListings = boolFromEnv(
    'OPENAI_AUTO_ANALYZE_NEW_LISTINGS',
    config.openai.autoAnalyzeNewListings,
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

async function loadState(config) {
  const statePath = resolveFromRoot(config.stateFile);
  const state = await readJsonIfExists(statePath, {});
  return {
    seenListings: state.seenListings || {},
    decisions: state.decisions || {},
    listingCache: state.listingCache || {},
    analyses: state.analyses || {},
    top10Cache: state.top10Cache || null,
    lastCheckAt: state.lastCheckAt || null,
    lastSearchCount: state.lastSearchCount || 0,
    lastNoNewNotificationAt: state.lastNoNewNotificationAt || null,
    telegramUpdateOffset: state.telegramUpdateOffset || 0,
  };
}

async function loadCurrentListingsSnapshot(config) {
  const snapshotPath = resolveFromRoot(config.currentListingsSnapshotFile);
  const snapshot = await readJsonIfExists(snapshotPath, {});
  return {
    recordedAt: snapshot.recordedAt || null,
    total: snapshot.total || 0,
    listings: Array.isArray(snapshot.listings) ? snapshot.listings : [],
  };
}

async function saveCurrentListingsSnapshot(config, snapshot) {
  const snapshotPath = resolveFromRoot(config.currentListingsSnapshotFile);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function buildCurrentListingsSnapshot(listingUrls, state) {
  return {
    recordedAt: new Date().toISOString(),
    total: listingUrls.length,
    listings: listingUrls.map((url, index) => {
      const id = listingIdFromUrl(url);
      const cached = state.listingCache?.[id]?.listing;
      const seen = state.seenListings?.[id];
      return {
        id,
        url,
        position: index + 1,
        title: cached?.title || seen?.title || null,
        listedAt: cached?.listedAt || seen?.listedAt || null,
        listedDateText: cached?.listedDateText || null,
      };
    }),
  };
}

function seedSeenListingsFromUrls(state, listingUrls, { seeded } = {}) {
  for (const url of listingUrls) {
    const id = listingIdFromUrl(url);
    if (state.seenListings[id]) continue;
    state.seenListings[id] = {
      url,
      firstSeenAt: new Date().toISOString(),
      ...(seeded ? { seeded: true } : {}),
    };
  }
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

function extractListedDateText(html) {
  const match = html.match(/<p[^>]*>(\d{1,2}-\d{1,2}-\d{4})<\/p>\s*<p[^>]*>\s*Op Funda\s*<\/p>/i);
  return match ? match[1] : '';
}

function normalizeListedDateText(value) {
  const text = cleanText(value || '');
  return /\d{1,2}-\d{1,2}-\d{4}/.test(text) ? text : '';
}

function parseDutchNumericDate(value) {
  const match = String(value || '').match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T12:00:00.000Z`;
}

function isRecentEnoughForNewNotification(config, listing) {
  const maxAgeDays = Number(config.maxNotificationListingAgeDays);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return true;
  if (!listing.listedAt) return true;
  return Date.now() - new Date(listing.listedAt).getTime() <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function hasInvalidListedDate(listing) {
  return /log in/i.test(String(listing?.listedDateText || ''));
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

function buildSummary({ title, description, features, priceText, pricePerM2 }) {
  const bullets = [];
  if (priceText) bullets.push(priceText);
  if (pricePerM2) bullets.push(`${formatEuro(pricePerM2)}/m2`);
  if (features.Wonen) bullets.push(features.Wonen);
  if (features['Aantal kamers']) bullets.push(features['Aantal kamers']);
  if (features.Energielabel) bullets.push(`energielabel ${cleanEnergyLabel(features.Energielabel)}`);
  if (features.Bouwjaar) bullets.push(`bouwjaar ${features.Bouwjaar}`);
  if (features.Aanvaarding) bullets.push(`aanvaarding ${features.Aanvaarding}`);

  const intro = bullets.length > 0 ? `${title}: ${bullets.join(', ')}.` : `${title}.`;
  const text = cleanText(description);
  return text ? `${intro}\n\n${truncate(text, 650)}` : intro;
}

function estimateReadiness({ description, features }) {
  const text = `${description} ${Object.values(features).join(' ')}`.toLowerCase();
  const positive = [
    'instapklaar',
    'turn-key',
    'turn key',
    'modern',
    'luxe',
    'netjes',
    'smaakvol',
    'gerenoveerd',
    'vernieuwd',
    'strak',
    'goed onderhouden',
    'zo te betrekken',
    'recent',
  ];
  const negative = [
    'klus',
    'opknap',
    'gedateerd',
    'renovatie',
    'moderniseren',
    'verouderd',
    'sloop',
    'casco',
    'achterstallig',
    'aandacht',
  ];

  let score = 55;
  const foundPositive = positive.filter((word) => text.includes(word));
  const foundNegative = negative.filter((word) => text.includes(word));
  score += foundPositive.length * 8;
  score -= foundNegative.length * 12;
  score = clamp(score, 10, 95);

  const reasonParts = [];
  if (foundPositive.length) reasonParts.push(`positief: ${foundPositive.slice(0, 4).join(', ')}`);
  if (foundNegative.length) reasonParts.push(`let op: ${foundNegative.slice(0, 4).join(', ')}`);
  if (!reasonParts.length) reasonParts.push('geen duidelijke instapklaar- of klus-signalen in de tekst');

  return { score, reason: reasonParts.join('; ') };
}

function withSearchParam(url, key, value) {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

async function telegramApi(config, method, body) {
  requireTelegramConfig(config);
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} fout: ${JSON.stringify(data)}`);
  return data;
}

function requireTelegramConfig(config) {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    throw new Error('telegram.enabled staat aan, maar botToken of chatId is leeg.');
  }
}

function openaiEnabled(config) {
  return Boolean(config.openai.enabled && config.openai.apiKey);
}

function parseJsonObject(text) {
  const parsed = parseJson(text);
  return parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed : null;
}

function parseJsonArray(text) {
  const parsed = parseJson(text);
  return Array.isArray(parsed) ? parsed : null;
}

function parseJson(text) {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const objectMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!objectMatch) return null;
    try {
      return JSON.parse(objectMatch[1]);
    } catch {
      return null;
    }
  }
}

function arrayOfText(value) {
  if (!Array.isArray(value)) return value ? [cleanText(value)] : [];
  return value.map((item) => cleanText(item)).filter(Boolean);
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

function bedroomsFromRoomsText(value) {
  const match = String(value || '').match(/(\d+)\s+slaapkamer/i);
  return match ? Number(match[1]) : null;
}

function cleanEnergyLabel(value) {
  const match = String(value || '').match(/\b(A\+{0,5}|B|C|D|E|F|G)\b/i);
  return match ? match[1].toUpperCase() : cleanText(value || '');
}

function formatEuro(value) {
  if (value == null || value === '') return '';
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(
    Number(value),
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function minutesAgo(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 60_000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function splitTelegramText(text) {
  const max = 3800;
  const parts = [];
  let remaining = text || '';
  while (remaining.length > max) {
    const cut = remaining.lastIndexOf('\n', max);
    const index = cut > 1000 ? cut : max;
    parts.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.length ? parts : [''];
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value || '';
  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function htmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function htmlLink(label, url) {
  return `<a href="${htmlEscape(url)}">${htmlEscape(label)}</a>`;
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

function boolFromEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(value.toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
