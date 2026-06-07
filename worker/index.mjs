const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; personal-funda-home-alert/0.2; +cloudflare-worker-personal-use)';

const FRESH_DETAIL_MS = 24 * 60 * 60 * 1000;
const FRESH_ANALYSIS_MS = 14 * 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return jsonResponse({
          ok: true,
          service: 'funda-home-alert',
          endpoints: ['/telegram', '/health', '/run'],
        });
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse(await getStatus(env));
      }

      if (request.method === 'POST' && url.pathname === '/telegram') {
        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(env, update));
        return jsonResponse({ ok: true });
      }

      if (request.method === 'POST' && url.pathname === '/run') {
        ctx.waitUntil(runScheduled(env, { source: 'manual-http' }));
        return jsonResponse({ ok: true, started: true });
      }

      return jsonResponse({ ok: false, error: 'Not found' }, 404);
    } catch (error) {
      console.error(error);
      return jsonResponse({ ok: false, error: error.message }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env, { source: 'cron' }));
  },
};

async function runScheduled(env, context) {
  const startedAt = nowIso();
  await setRunValue(env, 'last_run_started_at', startedAt);

  const summary = {
    source: context.source,
    newListings: 0,
    seenListings: 0,
    processedJobs: 0,
  };

  try {
    const checkResult = await checkForNewListings(env);
    summary.newListings = checkResult.newListings.length;
    summary.seenListings = checkResult.seenCount;

    await processJobs(env);
    summary.processedJobs = 1;

    await setRunValue(env, 'last_run_finished_at', nowIso());
    await setRunValue(env, 'last_run_summary', JSON.stringify(summary));
  } catch (error) {
    console.error(error);
    await setRunValue(env, 'last_run_error', `${nowIso()} ${error.stack || error.message}`);
    throw error;
  }
}

async function checkForNewListings(env) {
  const searchHtml = await fetchText(env.FUNDA_SEARCH_URL, env);
  const listingUrls = extractListingUrls(searchHtml);

  if (listingUrls.length === 0) {
    console.error(`Geen Funda-listings. responseLength=${searchHtml.length} sample=${searchHtml.slice(0, 500)}`);
    throw new Error('Geen Funda-listings gevonden. De pagina-structuur is mogelijk gewijzigd.');
  }

  const now = nowIso();
  const newListings = [];
  const listingCount = await getListingCount(env);
  const firstRun = listingCount === 0;

  for (const url of listingUrls) {
    const id = listingIdFromUrl(url);
    const existing = await getListing(env, id);

    if (existing) {
      await env.DB.prepare('UPDATE listings SET last_seen_at = ? WHERE id = ?').bind(now, id).run();
      continue;
    }

    const listing = await fetchListingDetails(url, env);
    await upsertListing(env, { ...listing, first_seen_at: now, last_seen_at: now });
    newListings.push(listing);
  }

  if (firstRun && !boolEnv(env, 'FIRST_RUN_NOTIFY', false)) {
    await setRunValue(env, 'initial_seed_at', now);
    await setRunValue(env, 'initial_seed_count', String(newListings.length));
    return { newListings: [], seenCount: listingUrls.length };
  }

  for (const listing of newListings.slice(0, numberEnv(env, 'MAX_NEW_LISTINGS_PER_RUN', 5))) {
    const analysis = await analyzeListing(env, listing, { mode: 'short' });
    await saveAnalysis(env, listing.id, analysis);
    await sendListingNotification(env, { ...listing, analysis });
  }

  return { newListings, seenCount: listingUrls.length };
}

async function handleTelegramUpdate(env, update) {
  if (update.message) {
    await handleTelegramMessage(env, update.message);
    return;
  }

  if (update.callback_query) {
    await handleTelegramCallback(env, update.callback_query);
  }
}

async function handleTelegramMessage(env, message) {
  const chatId = String(message.chat?.id || '');
  if (!isAllowedChat(env, chatId)) return;

  const text = (message.text || '').trim();
  const [commandRaw, ...rest] = text.split(/\s+/);
  const command = commandRaw.split('@')[0].toLowerCase();
  const arg = rest.join(' ');

  if (command === '/start') {
    await sendTelegramMessage(
      env,
      chatId,
      [
        'Funda Home Alert staat klaar.',
        '',
        'Commands:',
        '/status - laatste check',
        '/top - bovenste actuele woning',
        '/top10 - analyseer alle woningen en maak een top 10',
        '/analyse <id of link> - uitgebreide analyse van 1 woning',
      ].join('\n'),
    );
    return;
  }

  if (command === '/status') {
    await sendTelegramMessage(env, chatId, await formatStatus(env));
    return;
  }

  if (command === '/top') {
    await sendTopListing(env, chatId);
    return;
  }

  if (command === '/top10') {
    const job = await createTop10Job(env);
    await sendTelegramMessage(
      env,
      chatId,
      [
        'Top 10 analyse gestart.',
        `Job: ${job.id}`,
        '',
        'Ik haal alle woningen onder je filter op en verwerk ze in batches, zodat Cloudflare-limieten netjes blijven.',
        'Stuur later /status voor voortgang.',
      ].join('\n'),
    );
    return;
  }

  if (command === '/analyse' || command === '/deep') {
    await sendSingleAnalysis(env, chatId, arg, command === '/deep');
    return;
  }

  await sendTelegramMessage(env, chatId, 'Onbekend command. Probeer /status, /top, /top10 of /analyse <link>.');
}

async function handleTelegramCallback(env, callback) {
  const chatId = String(callback.message?.chat?.id || '');
  if (!isAllowedChat(env, chatId)) return;

  const [action, listingId] = String(callback.data || '').split(':');
  if (!listingId) return;

  if (action === 'interest' || action === 'ignore') {
    await env.DB.prepare('UPDATE listings SET decision = ?, decision_at = ? WHERE id = ?')
      .bind(action, nowIso(), listingId)
      .run();
    await answerCallbackQuery(env, callback.id, action === 'interest' ? 'Genoteerd als interessant.' : 'Genoteerd als niet interessant.');
    return;
  }

  if (action === 'analysis') {
    await answerCallbackQuery(env, callback.id, 'Analyse wordt opgehaald...');
    await sendSingleAnalysis(env, chatId, listingId, false);
  }
}

async function sendTopListing(env, chatId) {
  const searchHtml = await fetchText(env.FUNDA_SEARCH_URL, env);
  const [url] = extractListingUrls(searchHtml);

  if (!url) {
    await sendTelegramMessage(env, chatId, 'Geen woningen gevonden onder je filter.');
    return;
  }

  const listing = await fetchListingDetails(url, env);
  await upsertListing(env, { ...listing, first_seen_at: nowIso(), last_seen_at: nowIso() });
  await sendListingNotification(env, listing, chatId);
}

async function sendSingleAnalysis(env, chatId, input, deep) {
  const idOrUrl = input.trim();
  if (!idOrUrl) {
    await sendTelegramMessage(env, chatId, 'Stuur bijvoorbeeld: /analyse 44485295 of /analyse https://www.funda.nl/detail/...');
    return;
  }

  const listing = await resolveListing(env, idOrUrl);
  if (!listing) {
    await sendTelegramMessage(env, chatId, 'Ik kon deze woning niet vinden. Gebruik een Funda-link of listing-id.');
    return;
  }

  const analysis = await analyzeListing(env, listing, { mode: deep ? 'deep' : 'full' });
  await saveAnalysis(env, listing.id, analysis);
  await sendTelegramMessage(env, chatId, formatAnalysisMessage(listing, analysis), {
    reply_markup: listingKeyboard(listing),
  });
}

async function createTop10Job(env) {
  const job = {
    id: crypto.randomUUID(),
    type: 'top10',
    status: 'running',
    payload_json: JSON.stringify({
      phase: 'collect_urls',
      urls: [],
      detailIndex: 0,
      analysisIndex: 0,
    }),
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  await env.DB.prepare(
    'INSERT INTO jobs (id, type, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(job.id, job.type, job.status, job.payload_json, job.created_at, job.updated_at)
    .run();

  return job;
}

async function processJobs(env) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at ASC LIMIT 1")
    .first();

  if (!job) return;

  if (job.type === 'top10') {
    await processTop10Job(env, job);
  }
}

async function processTop10Job(env, job) {
  const payload = JSON.parse(job.payload_json);

  try {
    if (payload.phase === 'collect_urls') {
      payload.urls = await fetchAllListingUrls(env);
      payload.phase = 'fetch_details';
      payload.detailIndex = 0;
      await updateJobPayload(env, job.id, payload);
      await sendTelegramMessage(env, env.TELEGRAM_CHAT_ID, `Top10 job: ${payload.urls.length} woningen gevonden. Details worden in batches opgehaald.`);
      return;
    }

    if (payload.phase === 'fetch_details') {
      const batchSize = numberEnv(env, 'TOP10_DETAIL_BATCH_SIZE', 30);
      const batch = payload.urls.slice(payload.detailIndex, payload.detailIndex + batchSize);

      for (const url of batch) {
        const listing = await fetchListingDetails(url, env);
        await upsertListing(env, { ...listing, first_seen_at: nowIso(), last_seen_at: nowIso() });
      }

      payload.detailIndex += batch.length;
      if (payload.detailIndex >= payload.urls.length) {
        payload.phase = 'analyze';
        payload.analysisIndex = 0;
      }

      await updateJobPayload(env, job.id, payload);
      return;
    }

    if (payload.phase === 'analyze') {
      const batchSize = numberEnv(env, 'TOP10_ANALYSIS_BATCH_SIZE', 8);
      const candidates = await getTop10Candidates(env);
      const batch = candidates.slice(payload.analysisIndex, payload.analysisIndex + batchSize);

      for (const listing of batch) {
        const hydrated = normalizeListingRow(listing);
        const existingFresh = hydrated.analysis_json && hydrated.last_analysis_at && Date.now() - Date.parse(hydrated.last_analysis_at) < FRESH_ANALYSIS_MS;
        if (!existingFresh) {
          const analysis = await analyzeListing(env, hydrated, { mode: 'ranking' });
          await saveAnalysis(env, hydrated.id, analysis);
        }
      }

      payload.analysisIndex += batch.length;
      if (payload.analysisIndex >= candidates.length) {
        payload.phase = 'done';
        await finishTop10Job(env, job.id, payload);
        return;
      }

      await updateJobPayload(env, job.id, payload);
    }
  } catch (error) {
    await failJob(env, job.id, error);
    await sendTelegramMessage(env, env.TELEGRAM_CHAT_ID, `Top10 job fout: ${error.message}`);
  }
}

async function fetchAllListingUrls(env) {
  const urls = [];
  let page = 1;

  for (;;) {
    const pageUrl = addPageToSearchUrl(env.FUNDA_SEARCH_URL, page);
    const html = await fetchText(pageUrl, env);
    const pageUrls = extractListingUrls(html);
    const before = urls.length;

    for (const url of pageUrls) {
      if (!urls.includes(url)) urls.push(url);
    }

    if (pageUrls.length === 0 || urls.length === before || page >= 25) break;
    page += 1;
  }

  return urls;
}

async function finishTop10Job(env, jobId, payload) {
  const top10 = await getRankedTop10(env);
  const message = formatTop10Message(top10.map(normalizeListingRow));

  await env.DB.prepare("UPDATE jobs SET status = 'done', payload_json = ?, updated_at = ?, finished_at = ? WHERE id = ?")
    .bind(JSON.stringify(payload), nowIso(), nowIso(), jobId)
    .run();

  await sendTelegramMessage(env, env.TELEGRAM_CHAT_ID, message);
}

async function getTop10Candidates(env) {
  const rows = await env.DB.prepare(
    `SELECT * FROM listings
     WHERE living_area_m2 IS NOT NULL AND price IS NOT NULL
     ORDER BY
       CASE WHEN price_per_m2 IS NULL THEN 999999 ELSE price_per_m2 END ASC,
       living_area_m2 DESC
     LIMIT 40`,
  ).all();

  return rows.results || [];
}

async function getRankedTop10(env) {
  const rows = await env.DB.prepare(
    `SELECT * FROM listings
     ORDER BY
       CASE WHEN ranking_score IS NULL THEN 0 ELSE ranking_score END DESC,
       CASE WHEN price_per_m2 IS NULL THEN 999999 ELSE price_per_m2 END ASC
     LIMIT 10`,
  ).all();

  return rows.results || [];
}

async function resolveListing(env, idOrUrl) {
  const url = idOrUrl.startsWith('http') ? normalizeFundaUrl(idOrUrl) : null;
  const id = url ? listingIdFromUrl(url) : idOrUrl.match(/\d+/)?.[0];
  if (!id) return null;

  const existing = await getListing(env, id);
  const stale = !existing?.last_detail_fetch_at || Date.now() - Date.parse(existing.last_detail_fetch_at) > FRESH_DETAIL_MS;
  if (existing && !stale) return normalizeListingRow(existing);

  const detailUrl = url || existing?.url;
  if (!detailUrl) return null;

  const listing = await fetchListingDetails(detailUrl, env);
  await upsertListing(env, { ...listing, first_seen_at: existing?.first_seen_at || nowIso(), last_seen_at: nowIso() });
  return listing;
}

async function fetchListingDetails(url, env) {
  const html = await fetchText(url, env);
  const jsonLd = extractListingJsonLd(html);
  const features = extractFeatures(html);
  const photos = extractPhotos(jsonLd).slice(0, numberEnv(env, 'TOP10_PHOTOS_PER_HOME', 4));

  const description = cleanText(extractMetaContent(html, 'description') || jsonLd?.description || features.Omschrijving || '');
  const street = jsonLd?.address?.streetAddress || jsonLd?.name || titleFromUrl(url);
  const city = jsonLd?.address?.addressLocality || '';
  const title = [street, city].filter(Boolean).join(', ');
  const price = numberFromValue(jsonLd?.offers?.price) || euroNumber(features.Vraagprijs);
  const livingArea = m2Number(features.Wonen);
  const pricePerM2 = euroNumber(features['Vraagprijs per m²']) || (price && livingArea ? Math.round(price / livingArea) : null);
  const bedrooms = bedroomNumber(features['Aantal kamers']);

  return {
    id: listingIdFromUrl(url),
    url: normalizeFundaUrl(url),
    title,
    address: street,
    city,
    price,
    price_text: features.Vraagprijs || formatEuro(price),
    price_per_m2: pricePerM2,
    living_area_m2: livingArea,
    rooms: features['Aantal kamers'] || '',
    bedrooms,
    energy_label: cleanEnergyLabel(features.Energielabel),
    build_year: numberFromValue(features.Bouwjaar),
    acceptance: features.Aanvaarding || '',
    apartment_type: features['Soort appartement'] || '',
    outdoor_space: features['Gebouwgebonden buitenruimte'] || features.Balkon || '',
    storage: features['Externe bergruimte'] || features.Berging || '',
    service_costs: features['Bijdrage VvE'] || features.Servicekosten || '',
    description,
    summary: buildSummary({ title, description, features, price, livingArea, pricePerM2 }),
    photos,
    features,
    last_detail_fetch_at: nowIso(),
  };
}

async function analyzeListing(env, listing, options) {
  if (!env.OPENAI_API_KEY) {
    return fallbackAnalysis(listing);
  }

  const photos = (listing.photos || []).slice(0, options.mode === 'deep' ? 8 : numberEnv(env, 'TOP10_PHOTOS_PER_HOME', 4));
  const inputContent = [
    {
      type: 'input_text',
      text: buildAnalysisPrompt(listing, options),
    },
    ...photos.map((photo) => ({
      type: 'input_image',
      image_url: photo,
      detail: 'low',
    })),
  ];

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-5.4-mini',
      input: [
        {
          role: 'system',
          content:
            'Je bent een kritische aankoopassistent voor Nederlandse appartementen. Antwoord in strikt JSON volgens het schema. Beoordeel interieurstaat voorzichtig op basis van zichtbare foto’s en zeg het als iets onzeker is.',
        },
        {
          role: 'user',
          content: inputContent,
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'home_analysis',
          strict: true,
          schema: analysisSchema(),
        },
      },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const text = data.output_text || extractOutputText(data);
  return JSON.parse(text);
}

function buildAnalysisPrompt(listing, options) {
  return [
    'Maak een woninganalyse voor deze Funda-woning.',
    '',
    `Analysemodus: ${options.mode}`,
    '',
    'Gebruikersvoorkeuren:',
    '- Instapklaar is belangrijk.',
    '- Binnenkant moet netjes zijn.',
    '- Vermijd woningen die zichtbaar veel kluswerk nodig hebben.',
    '- Lege woning is acceptabel.',
    '- Mooi ingericht en goed afgewerkt is extra positief.',
    '- Prijs/kwaliteit blijft belangrijk.',
    '',
    'Woningdata:',
    JSON.stringify(publicListingData(listing), null, 2),
    '',
    'Geef scores van 0 tot 100. Wees streng bij verouderde keuken, badkamer, vloeren, muren of zichtbare rommel/achterstallig onderhoud. Geef onzekerheden expliciet aan.',
  ].join('\n');
}

function analysisSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'summary',
      'pros',
      'cons',
      'red_flags',
      'ready_score',
      'interior_score',
      'renovation_risk_score',
      'value_score',
      'ranking_score',
      'photo_observations',
      'recommendation',
    ],
    properties: {
      summary: { type: 'string' },
      pros: { type: 'array', items: { type: 'string' } },
      cons: { type: 'array', items: { type: 'string' } },
      red_flags: { type: 'array', items: { type: 'string' } },
      ready_score: { type: 'integer' },
      interior_score: { type: 'integer' },
      renovation_risk_score: { type: 'integer' },
      value_score: { type: 'integer' },
      ranking_score: { type: 'integer' },
      photo_observations: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string', enum: ['top_candidate', 'worth_viewing', 'maybe', 'skip'] },
    },
  };
}

function fallbackAnalysis(listing) {
  const valueScore = listing.price_per_m2 ? Math.max(0, Math.min(100, Math.round(100 - (listing.price_per_m2 - 3000) / 40))) : 50;
  const energyScore = energyLabelScore(listing.energy_label);
  const readyScore = listing.description?.match(/instapklaar|netjes|modern|verzorgd|gerenoveerd/i) ? 70 : 50;
  const rankingScore = Math.round(valueScore * 0.35 + energyScore * 0.2 + readyScore * 0.45);

  return {
    summary: 'Basisanalyse zonder OpenAI: score op prijs per m2, energielabel en tekstsignalen.',
    pros: ['Automatisch gescoord op beschikbare woningdata.'],
    cons: ['Geen fotoanalyse beschikbaar zonder OpenAI API key.'],
    red_flags: [],
    ready_score: readyScore,
    interior_score: readyScore,
    renovation_risk_score: 50,
    value_score: valueScore,
    ranking_score: rankingScore,
    photo_observations: [],
    recommendation: rankingScore >= 75 ? 'worth_viewing' : 'maybe',
  };
}

async function saveAnalysis(env, listingId, analysis) {
  await env.DB.prepare(
    `UPDATE listings
     SET analysis_json = ?, last_analysis_at = ?, ranking_score = ?, interior_score = ?, ready_score = ?, value_score = ?
     WHERE id = ?`,
  )
    .bind(
      JSON.stringify(analysis),
      nowIso(),
      analysis.ranking_score ?? null,
      analysis.interior_score ?? null,
      analysis.ready_score ?? null,
      analysis.value_score ?? null,
      listingId,
    )
    .run();
}

async function getStatus(env) {
  const rows = await env.DB.prepare('SELECT COUNT(*) AS count FROM listings').first();
  const runningJob = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY created_at ASC LIMIT 1").first();
  return {
    ok: true,
    listings: rows?.count || 0,
    lastRunStartedAt: await getRunValue(env, 'last_run_started_at'),
    lastRunFinishedAt: await getRunValue(env, 'last_run_finished_at'),
    lastRunSummary: await getRunValue(env, 'last_run_summary'),
    runningJob: runningJob ? summarizeJob(runningJob) : null,
  };
}

async function formatStatus(env) {
  const status = await getStatus(env);
  const lines = [
    'Funda monitor status',
    '',
    `Bekende woningen: ${status.listings}`,
    `Laatste start: ${status.lastRunStartedAt || 'nog niet'}`,
    `Laatste klaar: ${status.lastRunFinishedAt || 'nog niet'}`,
  ];

  if (status.runningJob) {
    lines.push('', `Lopende job: ${status.runningJob.type}`, `Fase: ${status.runningJob.phase}`);
    if (status.runningJob.progress) lines.push(`Voortgang: ${status.runningJob.progress}`);
  }

  return lines.join('\n');
}

function summarizeJob(job) {
  const payload = JSON.parse(job.payload_json);
  const total = payload.urls?.length || 0;
  const index = payload.phase === 'analyze' ? payload.analysisIndex : payload.detailIndex;
  return {
    id: job.id,
    type: job.type,
    phase: payload.phase,
    progress: total ? `${index || 0}/${total}` : '',
  };
}

async function upsertListing(env, listing) {
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO listings (
      id, url, title, address, city, price, price_text, price_per_m2, living_area_m2,
      rooms, bedrooms, energy_label, build_year, acceptance, apartment_type,
      outdoor_space, storage, service_costs, description, summary, photos_json,
      features_json, first_seen_at, last_seen_at, last_detail_fetch_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      title = excluded.title,
      address = excluded.address,
      city = excluded.city,
      price = excluded.price,
      price_text = excluded.price_text,
      price_per_m2 = excluded.price_per_m2,
      living_area_m2 = excluded.living_area_m2,
      rooms = excluded.rooms,
      bedrooms = excluded.bedrooms,
      energy_label = excluded.energy_label,
      build_year = excluded.build_year,
      acceptance = excluded.acceptance,
      apartment_type = excluded.apartment_type,
      outdoor_space = excluded.outdoor_space,
      storage = excluded.storage,
      service_costs = excluded.service_costs,
      description = excluded.description,
      summary = excluded.summary,
      photos_json = excluded.photos_json,
      features_json = excluded.features_json,
      last_seen_at = excluded.last_seen_at,
      last_detail_fetch_at = excluded.last_detail_fetch_at`,
  )
    .bind(
      listing.id,
      listing.url,
      listing.title || '',
      listing.address || '',
      listing.city || '',
      listing.price ?? null,
      listing.price_text || '',
      listing.price_per_m2 ?? null,
      listing.living_area_m2 ?? null,
      listing.rooms || '',
      listing.bedrooms ?? null,
      listing.energy_label || '',
      listing.build_year ?? null,
      listing.acceptance || '',
      listing.apartment_type || '',
      listing.outdoor_space || '',
      listing.storage || '',
      listing.service_costs || '',
      listing.description || '',
      listing.summary || '',
      JSON.stringify(listing.photos || []),
      JSON.stringify(listing.features || {}),
      listing.first_seen_at || now,
      listing.last_seen_at || now,
      listing.last_detail_fetch_at || now,
    )
    .run();
}

async function getListing(env, id) {
  return env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
}

async function getListingCount(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM listings').first();
  return row?.count || 0;
}

function normalizeListingRow(row) {
  return {
    ...row,
    photos: safeJson(row.photos_json, []),
    features: safeJson(row.features_json, {}),
    analysis: safeJson(row.analysis_json, null),
  };
}

async function updateJobPayload(env, jobId, payload) {
  await env.DB.prepare('UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(payload), nowIso(), jobId)
    .run();
}

async function failJob(env, jobId, error) {
  await env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ?")
    .bind(error.stack || error.message, nowIso(), nowIso(), jobId)
    .run();
}

async function getRunValue(env, key) {
  const row = await env.DB.prepare('SELECT value FROM runs WHERE key = ?').bind(key).first();
  return row?.value || '';
}

async function setRunValue(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO runs (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, nowIso())
    .run();
}

async function sendListingNotification(env, listing, chatId = env.TELEGRAM_CHAT_ID) {
  const text = formatListingMessage(listing);
  const keyboard = listingKeyboard(listing);

  if (listing.photos?.[0]) {
    await sendTelegramPhoto(env, chatId, listing.photos[0], truncate(text, 950), keyboard);
    return;
  }

  await sendTelegramMessage(env, chatId, text, { reply_markup: keyboard });
}

function listingKeyboard(listing) {
  return {
    inline_keyboard: [
      [{ text: 'Bekijk / reageer', url: listing.url }],
      [
        { text: 'Interessant', callback_data: `interest:${listing.id}` },
        { text: 'Niet interessant', callback_data: `ignore:${listing.id}` },
        { text: 'Analyse', callback_data: `analysis:${listing.id}` },
      ],
    ],
  };
}

function formatListingMessage(listing) {
  const analysis = listing.analysis || safeJson(listing.analysis_json, null);
  const lines = [
    `Nieuwe Funda-match: ${listing.title}`,
    listing.price_text || formatEuro(listing.price),
    listing.price_per_m2 ? `Prijs per m2: ${formatEuro(listing.price_per_m2)}` : '',
    listing.living_area_m2 ? `Wonen: ${listing.living_area_m2} m2` : '',
    listing.rooms ? `Kamers: ${listing.rooms}` : '',
    listing.energy_label ? `Energielabel: ${listing.energy_label}` : '',
    listing.build_year ? `Bouwjaar: ${listing.build_year}` : '',
    '',
    listing.summary || '',
  ];

  if (analysis) {
    lines.push(
      '',
      `Score: ${analysis.ranking_score}/100`,
      `Instapklaar: ${analysis.ready_score}/100`,
      analysis.summary,
    );
  }

  lines.push('', listing.url);
  return lines.filter(Boolean).join('\n');
}

function formatAnalysisMessage(listing, analysis) {
  return [
    `Analyse: ${listing.title}`,
    '',
    `Totaalscore: ${analysis.ranking_score}/100`,
    `Instapklaar: ${analysis.ready_score}/100`,
    `Interieur: ${analysis.interior_score}/100`,
    `Renovatierisico: ${analysis.renovation_risk_score}/100`,
    `Waarde: ${analysis.value_score}/100`,
    '',
    analysis.summary,
    '',
    `Plus: ${analysis.pros.join('; ') || '-'}`,
    `Min: ${analysis.cons.join('; ') || '-'}`,
    `Red flags: ${analysis.red_flags.join('; ') || '-'}`,
    '',
    listing.url,
  ].join('\n');
}

function formatTop10Message(listings) {
  const lines = ['Top 10 onder jouw filter', ''];
  listings.forEach((listing, index) => {
    const analysis = safeJson(listing.analysis_json, null) || listing.analysis;
    lines.push(
      `${index + 1}. ${listing.title}`,
      `${listing.price_text || formatEuro(listing.price)} | ${listing.price_per_m2 ? `${formatEuro(listing.price_per_m2)}/m2` : '?/m2'} | score ${analysis?.ranking_score || listing.ranking_score || '?'}/100`,
      `${analysis?.summary || listing.summary || ''}`,
      listing.url,
      '',
    );
  });
  return truncate(lines.join('\n'), 3900);
}

async function sendTelegramMessage(env, chatId, text, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  await telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text: truncate(text, 3900),
    disable_web_page_preview: false,
    ...extra,
  });
}

async function sendTelegramPhoto(env, chatId, photo, caption, replyMarkup) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  await telegramApi(env, 'sendPhoto', {
    chat_id: chatId,
    photo,
    caption: truncate(caption, 1000),
    reply_markup: replyMarkup,
  });
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await telegramApi(env, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function telegramApi(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
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

function isAllowedChat(env, chatId) {
  return !env.TELEGRAM_CHAT_ID || String(env.TELEGRAM_CHAT_ID) === String(chatId);
}

async function fetchText(url, env) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      'User-Agent': env.USER_AGENT || DEFAULT_USER_AGENT,
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
      console.warn(`JSON-LD van zoekpagina niet leesbaar: ${error.message}`);
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

function extractPhotos(jsonLd) {
  const photos = [];
  if (jsonLd?.image) photos.push(jsonLd.image);
  for (const photo of jsonLd?.photo || []) {
    if (typeof photo === 'string') photos.push(photo);
    if (photo?.contentUrl) photos.push(photo.contentUrl);
  }
  return [...new Set(photos)];
}

function extractFeatures(html) {
  const labels = [
    'Vraagprijs',
    'Vraagprijs per m²',
    'Wonen',
    'Aantal kamers',
    'Energielabel',
    'Bouwjaar',
    'Aanvaarding',
    'Soort appartement',
    'Gebouwgebonden buitenruimte',
    'Externe bergruimte',
    'Bijdrage VvE',
    'Servicekosten',
    'Balkon',
    'Berging',
  ];
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

function buildSummary({ title, description, price, livingArea, pricePerM2, features }) {
  const facts = [];
  if (price) facts.push(formatEuro(price));
  if (pricePerM2) facts.push(`${formatEuro(pricePerM2)}/m2`);
  if (livingArea) facts.push(`${livingArea} m2`);
  if (features['Aantal kamers']) facts.push(features['Aantal kamers']);
  if (features.Energielabel) facts.push(`energielabel ${cleanEnergyLabel(features.Energielabel)}`);
  if (features.Bouwjaar) facts.push(`bouwjaar ${features.Bouwjaar}`);

  const intro = facts.length ? `${title}: ${facts.join(', ')}.` : `${title}.`;
  return description ? `${intro}\n\n${truncate(description, 600)}` : intro;
}

function publicListingData(listing) {
  return {
    title: listing.title,
    url: listing.url,
    price: listing.price,
    price_text: listing.price_text,
    price_per_m2: listing.price_per_m2,
    living_area_m2: listing.living_area_m2,
    rooms: listing.rooms,
    bedrooms: listing.bedrooms,
    energy_label: listing.energy_label,
    build_year: listing.build_year,
    acceptance: listing.acceptance,
    apartment_type: listing.apartment_type,
    outdoor_space: listing.outdoor_space,
    storage: listing.storage,
    service_costs: listing.service_costs,
    description: truncate(listing.description || '', 1600),
  };
}

function addPageToSearchUrl(searchUrl, page) {
  const url = new URL(searchUrl);
  if (page <= 1) {
    url.searchParams.delete('search_result');
    return url.toString();
  }
  url.searchParams.set('search_result', String(page));
  return url.toString();
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

function extractOutputText(data) {
  const texts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text') texts.push(content.text);
    }
  }
  return texts.join('');
}

function numberEnv(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(env, key, fallback) {
  const value = env[key];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'ja', 'on'].includes(String(value).toLowerCase());
}

function numberFromValue(value) {
  if (value == null || value === '') return null;
  const match = String(value).replace(/\./g, '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function euroNumber(value) {
  return numberFromValue(value);
}

function m2Number(value) {
  return numberFromValue(value);
}

function bedroomNumber(value) {
  const match = String(value || '').match(/\((\d+)\s+slaapkamer/);
  return match ? Number(match[1]) : null;
}

function cleanEnergyLabel(value) {
  const match = String(value || '').match(/\b(A\+{0,5}|B|C|D|E|F|G)\b/i);
  return match ? match[1].toUpperCase() : cleanText(value || '');
}

function energyLabelScore(label) {
  const scores = { A: 90, B: 78, C: 66, D: 52, E: 40, F: 28, G: 15 };
  const clean = cleanEnergyLabel(label).replace(/\+/g, '');
  return scores[clean] || 50;
}

function formatEuro(value) {
  if (value == null || value === '') return '';
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(Number(value));
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

function safeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
