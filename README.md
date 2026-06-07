# Funda Home Alert

Persoonlijke Funda-monitor voor jouw koopfilter rond Alkmaar. De bot meldt nieuwe woningen op Telegram, kan op verzoek de bovenste woning ophalen, en krijgt een uitgebreide `/top10` analyse met OpenAI.

## Huidige Filter

```text
Alkmaar + 30 km
Koop
Appartement
EUR 100.000 - 300.000
Minimaal 60 m2
Minimaal 1 slaapkamer
```

## Belangrijk

Gebruik dit persoonlijk en low-impact. We omzeilen geen login, captcha of beveiliging. De monitor checkt rustig op interval en haalt detailpagina's alleen op wanneer dat nodig is.

Secrets zoals Telegram token en OpenAI API key komen nooit in GitHub of in gewone code. Lokaal staan ze in `config.json` of `.env`; in Cloudflare worden ze Cloudflare secrets.

## Gekozen Richting

We zijn begonnen met Cloudflare, maar de eerste technische test liet iets belangrijks zien: Funda geeft Worker-verkeer een reCAPTCHA/Akamai tussenpagina ("Je bent bijna op de pagina die je zoekt"). Dat is geen gewone redirect die we netjes kunnen volgen.

Daarom wordt de praktische route nu:

- GitHub Actions doet de geplande Funda-check elke 5 minuten.
- GitHub bewaart de monitor-state in de repo.
- Telegram blijft het notificatiekanaal.
- Cloudflare blijft optioneel voor later als Telegram webhook/command-laag, maar niet als scraper-host.

Doel:

- Elke 5 minuten automatisch checken, ook als je laptop uit staat.
- Nieuwe woningen naar Telegram sturen met foto, samenvatting en actieknoppen.
- Telegram commands toevoegen voor analyse op verzoek.
- OpenAI gebruiken voor woninganalyse, inclusief interieur/foto-inschatting.
- Analyse cachen, zodat dezelfde woning niet telkens opnieuw tokens gebruikt.

Waarom niet puur Cloudflare:

- De lokale Worker-test kreeg geen Funda-resultaten maar een reCAPTCHA-pagina.
- De directe Funda search API gaf ook `403 Access Denied`.
- reCAPTCHA omzeilen doen we niet.

Fallback die nu actief is gemaakt:

- GitHub Actions elke 5 minuten.
- Simpeler om op te zetten.
- Waarschijnlijk beter voor gewone HTML-fetches dan Worker-verkeer.
- Minder ideaal voor directe Telegram-webhooks, maar goed voor nieuwe-woningmeldingen.

## Wat Je Op Het Cloudflare Scherm Moet Kiezen

Op het scherm "How would you like to start building?" kies je:

```text
Connect git repo or use template
```

Dat is de Workers Compute-route.

Niet kiezen:

- `Run serverless AI models globally`: dat is Cloudflare Workers AI; wij gebruiken OpenAI.
- `Set up object storage`: R2 hebben we nu niet nodig.
- `Images`, `Stream`, `Domain`: niet relevant voor deze bot.

Als Cloudflare daarna vraagt om een template, kies een eenvoudige Worker/Hello World/template. Als het te veel naar website hosting of Pages gaat, stop dan even en gebruik liever de Cloudflare Workers route via de dashboard/CLI.

Let op: omdat Funda Worker-verkeer blokkeert met reCAPTCHA, hoef je Cloudflare nu niet verder af te maken voor de scraper. We kunnen Cloudflare later alsnog gebruiken voor Telegram commands die GitHub Actions starten.

## Cloudflare Actieplan

Status: gepauzeerd voor scraping, omdat Funda Worker-verkeer reCAPTCHA geeft.

1. Cloudflare Worker-project maken.
2. De bestaande lokale Node-monitor omzetten naar Worker-compatible code.
3. State verplaatsen van `data/state.json` naar Cloudflare KV of D1.
4. Cron Trigger instellen op elke 5 minuten.
5. Telegram webhook instellen, zodat de bot direct op commands kan reageren.
6. Telegram secrets instellen in Cloudflare.
7. OpenAI API key als Cloudflare secret instellen.
8. Dry-run/test endpoint maken voor handmatig testen.
9. Eerste deploy uitvoeren.
10. Testmelding naar Telegram sturen.
11. Cron controleren in Cloudflare logs.
12. Lokale Windows Taakplanner uiteindelijk uitzetten als Cloudflare stabiel werkt.

## GitHub Actions Actieplan

Status: actief in `.github/workflows/funda-monitor.yml`.

1. Project naar GitHub repo zetten.
2. GitHub secrets instellen:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `OPENAI_API_KEY`
3. Repository Actions aanzetten.
4. Workflow handmatig starten met `workflow_dispatch`.
5. Eerste run seadt `state/github-state.json` en meldt bestaande woningen niet.
6. Daarna draait GitHub elke 5 minuten.
7. Bij nieuwe woningen stuurt de workflow Telegram-meldingen.
8. De workflow verwerkt Telegram commands en inline knoppen via `getUpdates`.
9. Workflow commit de bijgewerkte state terug naar de repo.

Voordeel:

- Werkt ook als je laptop uit staat.
- Geen server nodig.
- Geen Cloudflare Worker reCAPTCHA-probleem voor de geplande scrape.

Nadeel:

- Telegram commands reageren niet instant; ze worden bij de volgende 5-minuten-run verwerkt.
- Lange acties zoals `/top10` tonen daarna een voortgangsbericht dat wordt bijgewerkt tijdens zoeken, details ophalen, ranken en versturen.
- Voor directe reacties kan Cloudflare later alsnog als webhooklaag worden gebruikt.

## Lokale Laptop Monitor

Status: ook actief naast GitHub.

De laptopvariant draait met `config.json` en `data/state.json`. Start hem handmatig met:

```powershell
npm run local
```

Of gebruik het startscript:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-local-monitor.ps1
```

Het script voorkomt dubbele lokale monitors en schrijft naar `logs/local-monitor.log`. Er staat ook een persoonlijke Windows Startup-koppeling klaar, zodat de monitor start wanneer je op deze laptop inlogt.

Belangrijke lokale instellingen:

- `notifyNoNewListings`: stuurt ook een Telegram-bericht als er niets nieuws is.
- `noNewNotificationMinutes`: voorkomt dat zulke “geen nieuwe woningen”-berichten vaker dan dit interval komen.
- `maxNotificationListingAgeDays`: voorkomt dat oude Funda-woningen als nieuwe match worden gemeld; onbekende woningen ouder dan deze grens worden alleen opgeslagen.

## Data Opslag

We gebruiken nu `state/github-state.json` als kleine state-file in GitHub.

Tabellen/gegevens die we nodig hebben:

- Gezien woningen.
- Laatste checktijd.
- Woningdetails per listing.
- Analyse-cache.
- Jouw beslissingen: interessant, niet interessant, later bekijken.
- Ranking-resultaten voor `/top10`.

Voor nu is GitHub-state simpel en voldoende. Cloudflare D1 kan later alsnog als database als de bot groter wordt.

## Telegram Commands

Beschikbare commands:

- `/start`: korte uitleg.
- `/help` of `/actions`: alle acties tonen.
- `/status`: laatste check en cache-status.
- `/top`: haalt de bovenste woning uit de actuele Funda-resultaten.
- `/top10`: haalt alle woningen onder jouw filter op en maakt een top 10.
- `/list`: toont de actuele woningen op de eerste Funda-pagina.
- `/stats`: marktstats van alle huidige filterresultaten.
- `/saved`: jouw gemarkeerde woningen.

Inline acties per woning:

- `Bekijk / reageer`
- `Interessant`
- `Twijfel`
- `Nee`
- `Analyse`
- `Stats`
- `Foto's`

Bij nieuwe woningen sturen we:

- Hoofdfoto.
- Titel/adres.
- Prijs.
- Prijs per m2.
- Belangrijkste stats.
- Korte OpenAI-analyse.
- Knoppen: `Bekijk / reageer`, `Interessant`, `Twijfel`, `Nee`, `Analyse`, `Stats`, `Foto's`.

## Top 10 Eisen

Bij `/top10` moet de bot alle woningen onder jouw zoekcriteria ophalen, niet alleen de eerste pagina.

Aanpak:

1. Alle zoekresultaatpagina's ophalen.
2. Alle woning-URL's verzamelen.
3. Per woning de detailpagina ophalen.
4. Alle beschikbare stats verzamelen.
5. Per woning een beperkte set representatieve foto's analyseren.
6. Woningen scoren.
7. Top 10 naar Telegram sturen.

Voor jouw filter waren er eerder ongeveer 135 resultaten. Dat betekent dat `/top10` waarschijnlijk meerdere pagina's en veel detailpagina's ophaalt. Daarom moet dit rustig, gecachet en niet bij elke 5-minuten-check automatisch gebeuren.

`/top10` is nu ingebouwd. Omdat GitHub Actions elke 5 minuten draait, wordt het command verwerkt bij de volgende run. Resultaten worden gecachet zodat dezelfde analyse niet onnodig vaak wordt gemaakt.

Tijdens `/top10` stuurt de bot een voortgangsbericht met:

- zoekpagina's ophalen;
- woningdetails ophalen;
- ranken met OpenAI of lokale score;
- top 10 versturen.

## Stats Voor Ranking

We willen per woning zoveel mogelijk verzamelen:

- Vraagprijs.
- Prijs per m2.
- Woonoppervlak.
- Kamers en slaapkamers.
- Energielabel.
- Bouwjaar.
- Aanvaarding.
- Type appartement.
- Buitenruimte.
- Berging.
- VvE/servicekosten als beschikbaar.
- Verdieping/lift als beschikbaar.
- Makelaar.
- Wijk/buurt.
- Publicatiedatum.
- Beschrijving.
- Foto's.

## OpenAI Analyse

OpenAI wordt gebruikt voor:

- Samenvatting in normale taal.
- Pluspunten.
- Minpunten.
- Red flags.
- Instapklaar-score.
- Renovatie-risico.
- Interieurstaat op basis van foto's.
- Keuken/badkamer/vloer/muren inschatting.
- Inschatting of het "veel werk" is.
- Vergelijking met andere woningen in dezelfde filter.
- Eindscore voor jouw voorkeuren.

Jouw voorkeuren:

- Instapklaar heeft prioriteit.
- Binnenkant moet netjes zijn.
- Geen woning die zichtbaar veel kluswerk nodig heeft.
- Lege woning is acceptabel.
- Mooi ingericht en goed afgewerkt is extra positief.
- Prijs/kwaliteit blijft belangrijk.

We sturen niet alle foto's naar Telegram. Voor `/top10` sturen we hooguit 1 foto per woning, of alleen foto's bij de top 3. Voor analyse kan de bot intern wel meerdere foto's bekijken.

## Scoremodel

Voorstel voor ranking:

- 30% instapklaar/interieurstaat.
- 20% prijs per m2 en value-for-money.
- 15% woonoppervlak en indeling.
- 10% energielabel.
- 10% bouwjaar/onderhoudsrisico.
- 10% locatie binnen jouw zoekgebied.
- 5% buitenruimte/extra voorzieningen.

Dit kunnen we later aanpassen als je merkt dat de top 10 niet voelt als jouw smaak.

## Kostenverwachting

Cloudflare:

- Waarschijnlijk gratis op jouw schaal.
- Worker Cron elke 5 minuten is maar ongeveer 288 checks per dag.
- D1/KV-gebruik blijft waarschijnlijk laag.
- Betaald Workers-plan is pas nodig als we tegen limieten aanlopen.

OpenAI:

- We analyseren niet alles continu.
- Nieuwe woningen krijgen korte analyse.
- `/top10` doet uitgebreide analyse op verzoek.
- Resultaten worden gecachet.
- Zo blijven je gratis daily credits bruikbaar.

GitHub fallback:

- Simpel en mogelijk gratis.
- Minder geschikt voor directe Telegram webhooks.
- Wel geschikt voor "elke 5 minuten checken en meldingen sturen".

## Lokale Laptop

De lokale versie blijft handig voor testen.

Nadelen van laptop als host:

- Werkt niet als laptop uit staat.
- Slaapstand breekt monitoring.
- Batterij slijt sneller als hij altijd aan de lader hangt.
- Windows updates kunnen hem onderbreken.

Als je hem toch lokaal wilt draaien:

- Slaapstand uit.
- Scherm mag uit.
- Battery charge limit op 60-80% als je laptop dat ondersteunt.
- Goede ventilatie.
- Originele lader gebruiken.
- Monitor starten bij Windows-opstart.

## Bestaande Lokale Versie

Lokaal bestaat nu:

- `src/funda-monitor.mjs`: huidige monitor.
- `config.json`: lokale config met jouw filter.
- `run-funda-monitor.cmd`: start de continue lokale monitor.
- `fetch-top.cmd`: haalt de bovenste actuele woning op en stuurt die naar Telegram als Telegram is ingeschakeld.
- Windows taak `FundaHomeAlert`: fallback-check elke 10 minuten.

Als Cloudflare live is en betrouwbaar werkt, kan de lokale Windows-taak uit.

## Eerstvolgende Acties

1. GitHub repo maken of kiezen.
2. Projectbestanden naar GitHub krijgen.
3. GitHub secrets instellen.
4. Workflow handmatig starten.
5. Controleren dat `state/github-state.json` wordt aangemaakt/gecommit.
6. Controleren dat de 5-minuten schedule actief is.
7. Daarna OpenAI-analyse uitbreiden.
8. Daarna `/top10` als handmatige workflow of Cloudflare-trigger bouwen.
9. Lokale fallback uitschakelen zodra GitHub stabiel draait.
