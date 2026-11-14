// Tolkar text som användaren själv har kopierat från t.ex. Biluppgifter.se, Transportstyrelsens
// fordonsuppgifter eller sms-svaret från 71640. Inga anrop görs – bara textanalys.
// Letar efter kända rubriker ("Senaste besiktning", "Antal ägare" …) och datum/tal intill dem.
(function (root) {
  'use strict';
  const MONTHS = { jan: 1, januari: 1, feb: 2, februari: 2, mar: 3, mars: 3, apr: 4, april: 4, maj: 5, jun: 6, juni: 6,
    jul: 7, juli: 7, aug: 8, augusti: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12 };
  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => (y >= 1950 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${pad(m)}-${pad(d)}` : null;

  // Alla datum i en textsträng, i ordning
  function dates(s) {
    const out = [];
    const re = /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[./](\d{1,2})(?:[./-]|\s)\s?(\d{4})|(\d{1,2})\s+([a-zåäö]{3,9})\.?\s+(\d{4})/gi;
    let m;
    while ((m = re.exec(s))) {
      let d = null;
      if (m[1]) d = iso(+m[1], +m[2], +m[3]);
      else if (m[4]) d = iso(+m[6], +m[5], +m[4]);
      else if (m[7] && MONTHS[m[8].toLowerCase()]) d = iso(+m[9], MONTHS[m[8].toLowerCase()], +m[7]);
      if (d) out.push(d);
    }
    return out;
  }
  // Mätarställning: "18 690 mil" -> 186900 km, "186 900 km" -> 186900
  function distance(s) {
    const m = /(\d{1,3}(?:[  .]\d{3})+|\d{3,7})\s*(mil|km)\b/i.exec(s);
    if (!m) return null;
    const n = parseInt(m[1].replace(/[  .]/g, ''), 10);
    return m[2].toLowerCase() === 'mil' ? n * 10 : n;
  }
  // Tar bort datum (även ihopskrivna, t.ex. "Besiktigad2025-11-28") och mätarställning ur en text
  const MONTH_NAMES = 'januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|okt|nov|dec';
  const DATE_ANY = new RegExp(String.raw`\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}(?:[./-]|\s)\s?\d{4}|\d{1,2}\s+[a-zåäö]{3,9}\.?\s+\d{4}|(?:${MONTH_NAMES})\.?\s+\d{4}`, 'gi');
  function cleanText(s) {
    return String(s || '').replace(DATE_ANY, ' ').replace(/(\d{1,3}(?:[  .]\d{3})+|\d{3,7})\s*(mil|km)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ').replace(/^[\s:–,.-]+|[\s:–,.-]+$/g, '').trim();
  }
  const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/;
  const integer = s => { const m = /\b(\d{1,3})\b/.exec(s); return m ? +m[1] : null; };
  const money = s => { const m = /(\d{1,3}(?:[  ]\d{3})*|\d+)\s*(?:kr|sek|:-)/i.exec(s); return m ? +m[1].replace(/[  ]/g, '') : null; };

  const FIELDS = [
    // [fält, rubrik-regex, typ]
    ['next_range', /besiktningsperiod|kan besiktigas|period för besiktning/i, 'range'],
    ['inspection_valid_until', /besikt\w*\s+senast|senast\s+besikt\w*\s+(?:den|före|innan)|nästa\s+(?:kontroll)?besiktning|besiktning\s+senast|giltig\s+(?:till|t\.o\.m)|ska\s+besiktigas/i, 'date_last'],
    ['latest_inspection', /senaste\s+(?:kontroll)?besiktning|senast\s+besikt(?:igad|ad)|besiktigad\s+(?:den|senast)?|besiktningsdatum|datum\s+för\s+(?:senaste\s+)?besiktning/i, 'date'],
    ['meter', /mätarställning|miltal|mätare|vägmätare/i, 'distance'],
    ['number_of_owners', /antal\s+(?:tidigare\s+)?ägare|ägare\s*\(antal\)|antal\s+brukare/i, 'int'],
    ['latest_owner_change', /senaste\s+ägarbyte|ägarbyte|ägare\s+sedan|förvärvsdatum|förvärvad/i, 'date'],
    ['first_registered', /i\s+trafik\s+första\s+gången|första\s+registrering|först\s+registrerad|registrerad\s+första|första\s+gången\s+i\s+trafik/i, 'date'],
    ['first_on_swedish_roads', /i\s+trafik\s+i\s+sverige|första\s+gången\s+i\s+sverige|i\s+sverige\s+sedan/i, 'date'],
    ['tax', /fordonsskatt|årsskatt|skatt\s*\(år\)|skatt\s+per\s+år/i, 'money'],
    ['status', /^(?:fordons)?status\b/i, 'text'],
    ['vin', /chassinummer|chassinr|chassi-?nr|vin-?nummer|\bvin\b|identifieringsnummer/i, 'vin'],
    ['model_year', /modellår/i, 'year'],
    ['vehicle_year', /fordonsår|tillverkningsår/i, 'year'],
    ['color', /^(?:färg|kulör)(?![a-zåäö])/i, 'text'],
    ['paint_code', /färgkod|lackkod|färgnummer/i, 'paintcode'],
    ['make', /^(?:märke|fabrikat)(?![a-zåäö])/i, 'text'],
    ['model_name', /^(?:modell|modellbeteckning|handelsbeteckning)(?![a-zåäö])/i, 'text'],
    ['fuel', /^(?:drivmedel|bränsle(?:typ)?)(?![a-zåäö])/i, 'text'],
    ['power_hp', /^(?:effekt|motoreffekt|hästkrafter)(?![a-zåäö])/i, 'hp'],
    ['gearbox', /^(?:växellåda|transmission)(?![a-zåäö])/i, 'text'],
    ['body_type', /^(?:kaross(?:eri)?|karosstyp|chassityp)(?![a-zåäö])/i, 'text'],
  ];

  // Text efter rubriken på samma rad (för sms där allt står på en rad), annars nästa rad
  function valueNear(lines, i, re) {
    const m = re.exec(lines[i]);
    const rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:–-]+/, '').trim();
    return rest || (lines[i + 1] || '');
  }

  // ---- Strukturerad historik --------------------------------------------------------
  const TITLES = [
    ['besiktning', /^besiktigad/i], ['ägarbyte', /^ägarbyte/i], ['trafikstatus', /^trafikstatus/i],
    ['annons', /^annons/i], ['förregistrerad', /^förregistrerad/i], ['registrerad', /^registrerad/i],
    ['tillverkad', /^tillverkad/i], ['avställd', /^avställd/i], ['påställd', /^påställd/i],
    ['avregistrerad', /^avregistrerad/i], ['import', /^import(erad)?\b/i], ['skrotad', /^skrotad/i],
  ];
  const TITLE_RE = /^(besiktigad|ägarbyte|trafikstatus|annons|förregistrerad|registrerad|tillverkad|avställd|påställd|avregistrerad|importerad|import|skrotad)/i;
  const MONTH_YEAR = new RegExp(String.raw`(${MONTH_NAMES})\.?\s+(\d{4})\b`, 'i');
  function monthYear(s) {
    const m = MONTH_YEAR.exec(s || ''); const mo = m && MONTHS[m[1].toLowerCase()];
    return mo ? `${m[2]}-${pad(mo)}-01` : null;
  }
  const TITLE_EXACT = /^(besiktigad|ägarbyte|trafikstatus|annons|förregistrerad|registrerad|tillverkad|avställd|påställd|avregistrerad|importerad|import|skrotad)$/i;
  const isTitle = s => TITLE_EXACT.test(cleanText(s));
  // Riktig beskrivning: innehåller ord och mer bokstäver än siffror (inte diagramaxlar som "20 00017 50015 …")
  const looksLikeText = s => /[a-zåäö]{3}/i.test(s) && s.replace(/[^a-zåäö]/gi, '').length > s.replace(/\D/g, '').length;
  const isDateOnly = s => !!s && cleanText(s).length === 0 && (dates(s).length > 0 || !!monthYear(s));

  function describe(kind, desc) {
    const ev = {};
    const r = /\b(ej\s+godkänd|underkänd|godkänd\s+med\s+anmärkning|godkänd|körförbud)\b/i.exec(desc || '');
    if (r && kind === 'besiktning') ev.result = r[1].toLowerCase().replace(/\s+/g, ' ');
    const station = /\bhos\s+(.+?)\.?\s*$/i.exec(desc || '');
    if (station) ev.station = station[1].trim();
    const btype = /\b(kontrollbesiktning|efterkontroll|registreringsbesiktning|mopedbesiktning|typgodkännande)\b/i.exec(desc || '');
    if (btype) ev.inspection_type = btype[1].toLowerCase();
    const price = /\bför\s+(\d{1,3}(?:[  ]\d{3})+|\d+)\s*kr/i.exec(desc || '');
    if (price) ev.price = +price[1].replace(/[  ]/g, '');
    if (kind === 'trafikstatus') ev.kind = /avställ/i.test(desc) ? 'avställd' : /påställ|får användas/i.test(desc) ? 'påställd' : 'trafikstatus';
    return ev;
  }

  function parseEvents(lines) {
    const events = [], used = new Set();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!TITLE_RE.test(line) || used.has(i)) continue;
      const kindEntry = TITLES.find(([, re]) => re.test(line)); if (!kindEntry) continue;
      const titleText = cleanText(line);
      // Rubriken ska vara exakt ett känt ord, ev. med datum ihopskrivet ("Besiktigad2025-12-27").
      // Då hoppas löptext ("Registrerad för trafik i Sverige.") och diagramtext ("Registrerad0 mil") över.
      if (!isTitle(line)) continue;
      let date = dates(line)[0] || (kindEntry[0] === 'tillverkad' ? monthYear(line) : null);
      let desc = '';
      // Leta datum och beskrivning på de närmaste raderna (ordningen varierar beroende på hur sidan kopieras)
      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        if (isTitle(lines[j])) break;
        if (!date && isDateOnly(lines[j])) { date = dates(lines[j])[0] || monthYear(lines[j]); used.add(j); continue; }
        if (!desc && !isDateOnly(lines[j]) && looksLikeText(lines[j])) {
          desc = lines[j]; used.add(j);
          if (!date) { const d = dates(desc)[0]; if (d && cleanText(desc).length < 4) date = d; }
          continue;
        }
        if (date && desc) break;
      }
      if (!date) continue;
      used.add(i);
      const extra = describe(kindEntry[0], desc);
      const ev = { date, kind: extra.kind || kindEntry[0], title: titleText || kindEntry[0], text: desc.replace(/\s{2,}/g, ' ').slice(0, 160),
        meter: distance(desc) };
      delete extra.kind;
      if (kindEntry[0] === 'tillverkad' && !dates(line + ' ' + desc).length) ev.approx_month = true;
      events.push(Object.assign(ev, extra));
    }
    return events.sort((a, b) => b.date.localeCompare(a.date));
  }

  function summarize(events) {
    const insp = events.filter(e => e.kind === 'besiktning' && e.result);
    const owners = events.filter(e => e.kind === 'ägarbyte');
    const s = {
      inspections_count: insp.length,
      inspections_failed: insp.filter(e => /ej godkänd|underkänd|körförbud/.test(e.result)).length,
      owner_changes: owners.length,
      latest_owner_change: owners[0]?.date,
      latest_station: insp[0]?.station,
      latest_result: insp[0]?.result,
    };
    const made = events.find(e => e.kind === 'tillverkad'); if (made) s.manufactured = made.date.slice(0, 7);
    const reg = events.filter(e => e.kind === 'registrerad').pop(); if (reg) s.first_on_swedish_roads = reg.date;
    const ads = events.filter(e => e.kind === 'annons' && e.price); if (ads.length) s.last_ad = { date: ads[0].date, price: ads[0].price, meter: ads[0].meter };
    const ts = events.find(e => e.kind === 'påställd' || e.kind === 'avställd'); if (ts) s.status = ts.kind === 'påställd' ? 'I trafik' : 'Avställd';
    Object.keys(s).forEach(k => s[k] == null && delete s[k]);
    return s;
  }

  function parse(raw) {
    const text = String(raw || '').replace(/ /g, ' ').replace(/\t/g, '  ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');   // länkar i markdown-form: [Besikta](https://…) -> Besikta
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const info = {}, found = [];
    for (const [field, re, type] of FIELDS) {
      for (let i = 0; i < lines.length && info[field] == null; i++) {
        if (!re.test(lines[i])) continue;
        const near = valueNear(lines, i, re);
        let v = null;
        if (type === 'date') v = dates(near)[0] || null;
        else if (type === 'date_last') { const ds = dates(near); v = ds.length ? ds[ds.length - 1] : null; }
        else if (type === 'range') { const ds = dates(near + ' ' + (lines[i + 2] || '')); v = ds.length >= 2 ? [ds[0], ds[1]] : null; }
        else if (type === 'distance') v = distance(near);
        else if (type === 'int') v = integer(near);
        else if (type === 'money') v = money(near);
        else if (type === 'text') v = near.split(/\s{2,}|[.,;]/)[0].trim().slice(0, 40) || null;
        else if (type === 'vin') { const m = VIN_RE.exec(near.toUpperCase()); v = m ? m[1] : null; }
        else if (type === 'paintcode') { const m = /\b([A-Z]?\d{2,3}|[A-Z]\d{2}|[A-Z]{2}\d)\b/.exec(near.toUpperCase()); v = m ? m[1].replace(/^0(?=\d{3}$)/, '') : null; }
        else if (type === 'hp') {
          const hp = /(\d{2,4})\s*(?:hk|hp|hästkrafter)\b/i.exec(near), kw = /(\d{2,4})\s*kw\b/i.exec(near);
          v = hp ? +hp[1] : kw ? Math.round(+kw[1] * 1.36) : null;
          if (kw) info.power_kw = +kw[1];
        }
        else if (type === 'year') { const m = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(near); v = m ? +m[1] : null; }
        if (v != null) { info[field] = v; found.push(field); }
      }
    }
    if (info.next_range) {
      info.next_inspection_from = info.next_range[0]; info.next_inspection_to = info.next_range[1];
      if (!info.inspection_valid_until) info.inspection_valid_until = info.next_range[1];
      delete info.next_range;
    }
    if (!info.status) {
      const m = /\b(I trafik|Avställd|Avregistrerad|Aldrig i trafik)\b/i.exec(text);
      if (m) info.status = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    }
    if (!info.vin) {   // VIN utan rubrik: 17 tecken med både bokstäver och siffror, utan I/O/Q
      const m = [...text.toUpperCase().matchAll(new RegExp(VIN_RE.source, 'g'))].map(x => x[1]).find(x => /[A-Z]/.test(x) && /\d{5}/.test(x));
      if (m) { info.vin = m; found.push('vin'); }
    }
    const plate = /\b([A-ZÅÄÖ]{3})\s?(\d{2}[A-Z0-9])\b/.exec(text);
    if (plate) info.regnr = plate[1] + plate[2];

    // 1) Strukturerad historik (Biluppgifter): rubrikrad + datum (ibland ihopskrivet) + beskrivningsrad
    const structured = parseEvents(lines);
    if (structured.length >= 2) {
      info.history = structured;
      Object.assign(info, summarize(structured));
      // Historiken är säkrare än rubrikerna (t.ex. kan "mätarställning" annars hittas i en annons)
      const li = structured.find(e => e.kind === 'besiktning' && e.result);
      if (li) { info.latest_inspection = li.date; if (li.meter) info.meter = li.meter; }
      else if (found.includes('meter') && structured.some(e => e.kind === 'annons')) delete info.meter;
      return { info, found: found.concat(info.status && !found.includes('status') ? ['status'] : []), lines: lines.length };
    }

    // 2) Reserv: rader med datum + nyckelord
    const KINDS = [['besiktning', /besikt/i], ['ägarbyte', /ägarbyte|ny ägare|förvärv/i], ['avställd', /avställ/i],
      ['påställd', /påställ|i trafik/i], ['avregistrerad', /avregistr/i], ['import', /import/i]];
    const history = [], byKey = {};
    const today = new Date().toISOString().slice(0, 10);
    const notHistory = new RegExp(FIELDS.filter(f => ['next_range', 'inspection_valid_until'].includes(f[0])).map(f => f[1].source).join('|'), 'i');
    lines.forEach((line, i) => {
      const ds = dates(line).filter(d => d <= today);
      const ctx = ds.length ? line : '';
      if (!ds.length || notHistory.test(line) || notHistory.test(lines[i - 1] || '') && ctx.replace(/[\d\s./–-]/g, '').length < 8) return;
      const k = KINDS.find(([, re]) => re.test(ctx) || (ctx.replace(/[\d\s./-]/g, '').length < 3 && re.test(lines[i - 1] || '')));
      if (!k) return;
      const key = ds[0] + k[0], ev = { date: ds[0], kind: k[0], text: cleanText(line).slice(0, 120), meter: distance(line) };
      const old = byKey[key];
      if (!old) { byKey[key] = ev; history.push(ev); }
      else if ((ev.meter && !old.meter) || ev.text.length > old.text.length) Object.assign(old, { text: ev.text, meter: ev.meter || old.meter });
    });
    if (history.length) info.history = history.sort((a, b) => b.date.localeCompare(a.date));
    return { info, found: found.concat(info.status && !found.includes('status') ? ['status'] : []), lines: lines.length };
  }

  const api = { parse, dates, distance, cleanText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PasteParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
