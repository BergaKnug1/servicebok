// Webb-/mobil-backend för Servicebok. Samma metodnamn som Python-API:t i app.py,
// men data lagras i webbläsarens IndexedDB och synkas mot Google Drive.
// Synkformatet och reglerna för sammanslagning är identiska med logbook.py/drive_sync.py.
(function () {
  'use strict';
  const V = window.VIN_DATA;
  const CFG = window.SERVICEBOK_CONFIG || {};
  const STORES = ['cars', 'entries', 'attachments', 'snapshots'];
  const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const CAR_FIELDS = ['name', 'vin', 'chassis', 'model', 'body', 'year', 'paint_code', 'paint_name', 'paint_hex', 'profile', 'mileage', 'regnr', 'next_inspection'];
  const ENTRY_FIELDS = ['date', 'km', 'types', 'performed_by', 'parts', 'cost', 'notes', 'car_status', 'source'];
  const nowUtc = () => new Date().toISOString();
  const nowLocal = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 19); };
  const newUid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const extOf = n => { const m = /\.[a-z0-9]{1,6}$/i.exec(n || ''); return m ? m[0].toLowerCase() : ''; };

  // ------------------------------------------------------------ IndexedDB
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('servicebok', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        STORES.forEach(s => d.createObjectStore(s, { keyPath: 'uid' }));
        d.createObjectStore('files'); d.createObjectStore('meta');
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function op(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out; const r = fn(s);
      if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const all = s => op(s, 'readonly', st => st.getAll());
  const get = (s, k) => op(s, 'readonly', st => st.get(k));
  const put = (s, v, k) => op(s, 'readwrite', st => k === undefined ? st.put(v) : st.put(v, k));
  const del = (s, k) => op(s, 'readwrite', st => st.delete(k));
  const meta = async (k, v) => v === undefined ? get('meta', k) : put('meta', v, k);

  // ------------------------------------------------------------ filer
  const urlCache = {};
  async function fileUrl(uid, ext, lazy = true) {
    if (urlCache[uid]) return urlCache[uid];
    let blob = await get('files', uid);
    if (!blob && lazy && driveTokenValid()) {
      try { blob = await driveFetchFile(uid, ext); if (blob) await put('files', blob, uid); } catch (e) { console.warn(e); }
    }
    if (!blob) return null;
    return (urlCache[uid] = URL.createObjectURL(blob));
  }
  function dropUrl(uid) { if (urlCache[uid]) { URL.revokeObjectURL(urlCache[uid]); delete urlCache[uid]; } }
  async function removeFile(uid) { dropUrl(uid); await del('files', uid); }
  function b64ToBlob(b64, type) {
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || 'application/octet-stream' });
  }
  const mimeOf = name => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.heic': 'image/heic' })[extOf(name)] || 'application/octet-stream';

  async function shrinkImage(blob, max = 2000) {
    if (!/^image\/(jpeg|png|webp)/.test(blob.type) || !window.createImageBitmap) return blob;
    try {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (k === 1 && blob.size < 1.5e6) return blob;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || blob), 'image/jpeg', 0.85));
    } catch { return blob; }
  }

  // ------------------------------------------------------------ vy-objekt
  async function viewCar(c) {
    const entries = (await all('entries')).filter(e => e.car_uid === c.uid && !e.deleted);
    const kms = entries.map(e => e.km).filter(k => k != null);
    return { ...c, id: c.uid, photo: c.photo_uid, photo_url: c.photo_uid ? await fileUrl(c.photo_uid, '.jpg') : null,
      max_logged_km: kms.length ? Math.max(...kms) : null };
  }
  async function viewEntry(e) {
    const atts = (await all('attachments')).filter(a => a.entry_uid === e.uid && !a.deleted)
      .sort((a, b) => (a.added || '').localeCompare(b.added || ''));
    const have = new Set(await op('files', 'readonly', s => s.getAllKeys()));
    return { ...e, id: e.uid, car_id: e.car_uid, types: e.types || [],
      attachments: atts.map(a => ({ ...a, id: a.uid, entry_id: a.entry_uid, stored: a.uid + (a.ext || ''),
        is_image: IMAGE_EXT.includes(a.ext || extOf(a.filename)), missing: !have.has(a.uid) })) };
  }
  let changed = () => {};

  // ------------------------------------------------------------ VIN (som vin.py)
  const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const TRANSLIT = (() => { const t = {}; for (let i = 0; i < 10; i++) t[i] = i;
    'ABCDEFGH'.split('').forEach((c, i) => t[c] = i + 1); 'JKLMN'.split('').forEach((c, i) => t[c] = i + 1);
    t.P = 7; t.R = 9; 'STUVWXYZ'.split('').forEach((c, i) => t[c] = i + 2); return t; })();
  const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  function checkDigitOk(v) {
    let s = 0; for (let i = 0; i < 17; i++) { const x = TRANSLIT[v[i]]; if (x === undefined) return false; s += x * WEIGHTS[i]; }
    const r = s % 11; return v[8] === (r === 10 ? 'X' : String(r));
  }
  function modelYear(c) {
    const i = YEAR_CODES.indexOf(c); if (i < 0) return null;
    let y = 1980 + i; const lim = new Date().getFullYear() + 1; while (y + 30 <= lim) y += 30; return y;
  }
  async function decodeVin(vin) {
    vin = (vin || '').trim().toUpperCase().replace(/\s/g, '');
    const res = { vin, valid: false, warnings: [] };
    if (vin.length === 7) { res.warnings.push('Bara kort-VIN (7 tecken). Ange hela VIN för avkodning.'); res.serial = vin; return res; }
    if (vin.length !== 17 || /[IOQ]/.test(vin)) { res.warnings.push('Ett VIN har 17 tecken och saknar I, O och Q.'); return res; }
    Object.assign(res, { valid: true, wmi: vin.slice(0, 3), manufacturer: V.wmi[vin.slice(0, 3)] || 'Okänd tillverkare',
      type_key: vin.slice(3, 7), year: modelYear(vin[9]), serial: vin.slice(-7) });
    if (vin[9] === '0') res.warnings.push('Årsmodell kodas inte i europeiska BMW-VIN (pos 10 = 0) – ange den själv.');
    if (!checkDigitOk(vin)) res.warnings.push('Kontrollsiffran (pos 9) stämmer inte. Kontrollera att VIN är rätt inskrivet.');
    if (!V.wmi[res.wmi]) res.warnings.push('Inte ett känt BMW/MINI-VIN – loggboken fungerar ändå.');
    const known = ((await meta('typekeys')) || {})[res.type_key];
    if (known) { Object.entries(known).forEach(([k, v]) => { if (v != null && v !== '') res[k] = v; }); res.source = 'inlärd typnyckel'; }
    const ch = V.chassis[res.chassis];
    if (ch) Object.assign(res, { chassis_desc: ch[0], profile: ch[2], body: res.body || ch[1] });
    return res;
  }
  // Kommer ihåg vad en typnyckel betyder (som TypeKeys.learn i vin.py)
  async function learnTypeKey(car, extra = {}) {
    const d = await decodeVin(car.vin || '');
    if (!d.valid) return;
    const add = { chassis: car.chassis && car.chassis !== 'Annan' ? car.chassis : null, model: car.model, ...extra };
    Object.keys(add).forEach(k => (add[k] == null || add[k] === '') && delete add[k]);
    if (!Object.keys(add).length) return;
    const tk = (await meta('typekeys')) || {}; tk[d.type_key] = { ...(tk[d.type_key] || {}), ...add };
    await meta('typekeys', tk);
  }
  // Fält i "Min bil" som saknas men finns i registeruppgifterna (som car_updates_from_registry i vin.py)
  const BODY_WORDS = [['touring', ['herrgårdsvagn', 'kombi', 'touring', 'stationsvagn']], ['hatch', ['halvkombi', 'hatchback']],
    ['coupe', ['kupé', 'coupé', 'coupe', 'cabriolet', 'cab']], ['suv', ['suv', 'terräng', 'crossover']], ['sedan', ['sedan']]];
  const bodyFromText = t => { t = (t || '').toLowerCase(); const b = BODY_WORDS.find(([, ws]) => ws.some(w => t.includes(w))); return b ? b[0] : null; };
  function carUpdatesFromRegistry(car, info) {
    const upd = {};
    if (!car.vin && info.vin) upd.vin = info.vin;
    if (!car.regnr && info.regnr) upd.regnr = info.regnr;
    const model = info.model_name || info.model, defModel = (V.chassis[car.chassis] || [''])[0];
    if (model && (!car.model || car.model === defModel)) upd.model = model;
    const year = info.model_year || info.vehicle_year;
    if (!car.year && year) upd.year = +year;
    if (!car.paint_code) {
      const code = String(info.paint_code || '').toUpperCase().replace(/^0+/, '') || null;
      if (code && V.paints[code]) Object.assign(upd, { paint_code: code, paint_name: V.paints[code][0], paint_hex: V.paints[code][1] });
      else if (code) Object.assign(upd, { paint_code: code, paint_name: car.paint_name || info.color || null });
      else if (!car.paint_name && info.color) upd.paint_name = info.color;
    }
    const body = bodyFromText(info.body_type);
    if (body && !car.chassis && [null, undefined, '', 'sedan'].includes(car.body)) upd.body = body;
    return upd;
  }
  async function applyRegistry(c, info) {
    const filled = carUpdatesFromRegistry(c, info);
    const rec = { ...c, ...filled, vehicle_info: info, updated: nowUtc() };
    if (info.inspection_valid_until) rec.next_inspection = info.inspection_valid_until;
    if (info.meter && info.meter > (c.mileage || 0)) rec.mileage = info.meter;
    await put('cars', rec);
    await learnTypeKey(rec, { fuel: info.fuel, power_hp: info.power_hp, gearbox: info.gearbox, body: bodyFromText(info.body_type) });
    changed();
    return { ...(await viewCar(rec)), filled: Object.keys(filled).filter(k => k !== 'paint_hex').sort() };
  }

  // ------------------------------------------------------------ bilfoton (som car_photos.py)
  async function commonsSearch(q) {
    const p = new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6',
      gsrsearch: q + ' filetype:bitmap', gsrlimit: '12', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '1200' });
    const j = await (await fetch('https://commons.wikimedia.org/w/api.php?' + p)).json();
    const strip = s => (s || '').replace(/<[^>]+>/g, '').trim();
    return Object.values(j.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0))
      .map(p => { const ii = (p.imageinfo || [{}])[0], m = ii.extmetadata || {};
        return ii.thumburl && { title: p.title.replace(/^File:/, ''), thumb: ii.thumburl, page: ii.descriptionurl,
          artist: strip(m.Artist?.value) || 'Okänd fotograf', license: m.LicenseShortName?.value || '' }; })
      .filter(Boolean);
  }

  // ------------------------------------------------------------ registeruppgifter (som vehicle_data.py)
  const STATUS = { 1: 'Avställd', 2: 'I trafik', 3: 'Avregistrerad', 4: 'Aldrig i trafik' };
  const dOnly = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const first = (o, ...ks) => { for (const k of ks) if (o[k] != null && o[k] !== '') return o[k]; return null; };
  function parseHistory(h) {
    const out = [];
    const walk = (node, kind) => {
      if (node && typeof node === 'object' && !Array.isArray(node) && 'data' in node && Object.keys(node).length <= 2) return walk(node.data, kind);
      if (Array.isArray(node)) { node.forEach(i => walk(i, kind)); return; }
      if (!node || typeof node !== 'object') return;
      let date = dOnly(first(node, 'date', 'inspection_date', 'event_date', 'changed_at', 'created_at', 'registered_at') || '');
      if (!date) date = Object.values(node).map(dOnly).find(Boolean) || null;
      if (date) {
        let text = first(node, 'description', 'text', 'type_text', 'event', 'type', 'result', 'status');
        if (typeof text === 'number' && kind && kind.includes('status')) text = STATUS[text] || text;
        out.push({ date, kind: kind || '', text: text == null ? '' : String(text), meter: first(node, 'meter', 'mileage', 'odometer') });
      }
      Object.entries(node).forEach(([k, v]) => { if (v && typeof v === 'object') walk(v, k); });
    };
    walk(h);
    const seen = new Set();
    return out.sort((a, b) => b.date.localeCompare(a.date)).filter(e => { const k = e.date + e.kind + e.text; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  function normalizeVehicle(resp) {
    const d = resp.data || {}, pk = n => (d[n] && d[n].data) || {};
    const basic = pk('basic'), insp = pk('inspection'), st = pk('status'), rng = insp.next_inspection_range || [];
    return { source: 'Biluppgifter.se', fetched_at: nowLocal(), regnr: d.attributes?.regno, vin: d.attributes?.vin,
      make: basic.make, model: basic.model, color: basic.color, vehicle_year: basic.vehicle_year, model_year: basic.model_year,
      status: STATUS[st.status] || st.status, latest_inspection: dOnly(insp.latest_inspection || ''),
      inspection_valid_until: dOnly(insp.inspection_valid_until || ''), next_inspection_from: dOnly(rng[0] || ''),
      next_inspection_to: dOnly(rng[1] || ''), meter: insp.meter, number_of_owners: st.number_of_owners,
      latest_owner_change: dOnly(st.latest_owner_change || ''), first_registered: dOnly(st.first_registered || ''),
      first_on_swedish_roads: dOnly(st.first_on_swedish_roads || ''), imported: st.imported, leasing: st.leasing,
      tax: st.tax, tax_month: st.tax_month, history: parseHistory(d.history) };
  }
  function inspectionEntries(info) {
    const out = (info.history || []).filter(h => /besikt|inspection/i.test(`${h.kind} ${h.text}`)
        && !/typgodkänn/i.test(`${h.kind} ${h.text}`) && h.inspection_type !== 'typgodkännande')
      .map(h => ({ date: h.date, km: h.meter, text: h.text, station: h.station, result: h.result }));
    if (info.latest_inspection && !out.some(e => e.date === info.latest_inspection))
      out.push({ date: info.latest_inspection, km: info.meter, text: 'Senaste besiktning' });
    return out;
  }

  // ============================================================ SYNK
  async function exportState() {
    const [cars, entries, attachments, snapshots] = await Promise.all(STORES.map(all));
    return { format: 'servicebok', version: 1, cars, entries, attachments, snapshots };
  }
  function signature(s) {
    if (!s) return '{}';
    const o = {};
    ['cars', 'entries', 'attachments'].forEach(t => {
      o[t] = Object.fromEntries((s[t] || []).map(r => [r.uid, r.updated || null]).sort((a, b) => a[0] < b[0] ? -1 : 1));
    });
    o.snapshots = (s.snapshots || []).map(r => r.uid).sort();
    return JSON.stringify(o);
  }
  const pick = (r, keys) => Object.fromEntries(keys.map(k => [k, r[k] ?? null]));
  const SYNC_CAR = [...CAR_FIELDS, 'photo_uid', 'photo_credit', 'created', 'vehicle_info'];
  const SYNC_ENTRY = [...ENTRY_FIELDS, 'created'];

  // fetchFile(uid, ext) -> Blob|null. eager=true hämtar alla saknade filer direkt (zip-import).
  async function mergeState(state, fetchFile, eager) {
    if (!state || state.format !== 'servicebok') throw new Error('Okänt filformat – inte en servicebok-fil');
    const st = { cars: 0, entries: 0, attachments: 0, snapshots: 0, files: 0 };
    const newer = (l, r) => !l || (l.updated || '') < (r.updated || '');
    for (const c of state.cars || []) {
      const l = await get('cars', c.uid); if (!newer(l, c)) continue;
      if (l && l.photo_uid && l.photo_uid !== c.photo_uid) await removeFile(l.photo_uid);
      await put('cars', { uid: c.uid, updated: c.updated, deleted: !!c.deleted, ...pick(c, SYNC_CAR) }); st.cars++;
    }
    const carIds = new Set((await all('cars')).map(c => c.uid));
    for (const e of state.entries || []) {
      if (!carIds.has(e.car_uid)) continue;
      const l = await get('entries', e.uid); if (!newer(l, e)) continue;
      await put('entries', { uid: e.uid, updated: e.updated, deleted: !!e.deleted, car_uid: e.car_uid, ...pick(e, SYNC_ENTRY), types: e.types || [] });
      st.entries++;
    }
    const entryIds = new Set((await all('entries')).map(e => e.uid));
    for (const a of state.attachments || []) {
      if (!entryIds.has(a.entry_uid)) continue;
      const l = await get('attachments', a.uid); if (!newer(l, a)) continue;
      if (a.deleted) await removeFile(a.uid);
      await put('attachments', { uid: a.uid, updated: a.updated, deleted: !!a.deleted, entry_uid: a.entry_uid,
        filename: a.filename, mime: a.mime, ext: a.ext || extOf(a.filename), added: a.added });
      st.attachments++;
    }
    const snapIds = new Set((await all('snapshots')).map(s => s.uid));
    for (const s of state.snapshots || []) {
      if (snapIds.has(s.uid) || !carIds.has(s.car_uid)) continue;
      await put('snapshots', { uid: s.uid, car_uid: s.car_uid, taken_at: s.taken_at, data: s.data || {} }); st.snapshots++;
    }
    // Filer: bilfoton alltid, bilagor bara vid eager (annars hämtas de när de visas)
    const have = new Set(await op('files', 'readonly', s => s.getAllKeys()));
    const want = [];
    (await all('cars')).forEach(c => { if (!c.deleted && c.photo_uid) want.push([c.photo_uid, '.jpg']); });
    if (eager) (await all('attachments')).forEach(a => { if (!a.deleted) want.push([a.uid, a.ext]); });
    for (const [uid, ext] of want) {
      if (have.has(uid)) continue;
      const b = await fetchFile(uid, ext);
      if (b) { await put('files', b, uid); st.files++; }
    }
    return st;
  }
  async function localFileUids() {
    const out = {};
    (await all('attachments')).forEach(a => { if (!a.deleted) out[a.uid] = a.ext || extOf(a.filename); });
    (await all('cars')).forEach(c => { if (!c.deleted && c.photo_uid) out[c.photo_uid] = '.jpg'; });
    return out;
  }

  // ------------------------------------------------------------ Google Drive (OAuth via omdirigering)
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  let driveIds = null, attList = null;

  const clientId = async () => (await meta('google_web_client_id')) || CFG.googleWebClientId || '';
  function token() { try { return JSON.parse(localStorage.sbToken || 'null'); } catch { return null; } }
  function driveTokenValid() { const t = token(); return !!(t && t.exp > Date.now() + 60e3); }
  const redirectUri = () => location.origin + location.pathname;

  async function driveLogin() {
    const id = await clientId();
    if (!id) throw new Error('Google webbklient-ID saknas. Fyll i det under Bilinställningar → Google Drive.');
    const state = newUid(); sessionStorage.sbOAuthState = state;
    const p = new URLSearchParams({ client_id: id, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE,
      include_granted_scopes: 'true', state });
    if (!localStorage.sbDriveConnected) p.set('prompt', 'consent');
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
    return new Promise(() => {}); // sidan lämnas
  }
  // Körs vid start: tar emot token från Googles omdirigering
  function handleRedirect() {
    if (!location.hash.includes('access_token')) return false;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (h.get('state') !== sessionStorage.sbOAuthState) { console.warn('OAuth state matchar inte'); return false; }
    localStorage.sbToken = JSON.stringify({ t: h.get('access_token'), exp: Date.now() + (Number(h.get('expires_in')) || 3600) * 1000 });
    localStorage.sbDriveConnected = '1';
    return true;
  }
  async function gfetch(url, opt = {}) {
    if (!driveTokenValid()) throw Object.assign(new Error('Inloggningen till Google har gått ut – tryck Synka nu.'), { needLogin: true });
    const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + token().t } });
    if (r.status === 401) { localStorage.removeItem('sbToken'); throw Object.assign(new Error('Inloggningen till Google har gått ut – tryck Synka nu.'), { needLogin: true }); }
    if (!r.ok) throw new Error(`Google Drive svarade ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }
  async function dFind(name, parent, folder) {
    const q = [`name = '${name}'`, 'trashed = false', `mimeType ${folder ? '=' : '!='} '${FOLDER}'`];
    if (parent) q.push(`'${parent}' in parents`);
    const p = new URLSearchParams({ q: q.join(' and '), fields: 'files(id)', spaces: 'drive', orderBy: 'createdTime' });
    const j = await (await gfetch(`${API}/files?${p}`)).json();
    return j.files?.[0]?.id || null;
  }
  async function dMkdir(name, parent) {
    const r = await gfetch(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }) });
    return (await r.json()).id;
  }
  async function dFolders() {
    if (!driveIds) {
      const root = await dFind('Servicebok', null, true) || await dMkdir('Servicebok', null);
      const att = await dFind('bilagor', root, true) || await dMkdir('bilagor', root);
      driveIds = { root, att };
    }
    return driveIds;
  }
  async function dList(folder) {
    const out = {}; let pageToken;
    do {
      const p = new URLSearchParams({ q: `'${folder}' in parents and trashed = false`, fields: 'nextPageToken, files(id, name)', pageSize: '1000' });
      if (pageToken) p.set('pageToken', pageToken);
      const j = await (await gfetch(`${API}/files?${p}`)).json();
      (j.files || []).forEach(f => out[f.name] = f.id); pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }
  const dDownload = async id => (await gfetch(`${API}/files/${id}?alt=media`)).blob();
  const dVersion = async id => (await (await gfetch(`${API}/files/${id}?fields=version`)).json()).version;
  async function dUpload(name, parent, blob, mime, fileId) {
    const b = 'servicebok_boundary_7f3a';
    const metaJson = JSON.stringify(fileId ? { name } : { name, parents: [parent] });
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`]);
    const url = `${UPLOAD}/files${fileId ? '/' + fileId : ''}?uploadType=multipart&fields=id,version`;
    return (await gfetch(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body })).json();
  }
  function uidMap(files) { const m = {}; Object.entries(files).forEach(([n, id]) => { m[n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : n] = id; }); return m; }
  async function driveFetchFile(uid, ext) {
    const { att } = await dFolders();
    if (!attList) attList = await dList(att);
    const id = attList[uid + (ext || '')] || uidMap(attList)[uid];
    return id ? dDownload(id) : null;
  }

  let syncing = null;
  async function driveSync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const { root, att } = await dFolders();
      const st = { uploaded_files: 0, uploaded_state: false };
      for (let attempt = 0; attempt < 3; attempt++) {
        const fid = await dFind('servicebok.json', root, false);
        let remote = null, ver = null;
        if (fid) { ver = await dVersion(fid); remote = JSON.parse(await (await dDownload(fid)).text()); }
        attList = await dList(att); const byUid = uidMap(attList);
        const fetchFile = async (uid, ext) => { const id = attList[uid + (ext || '')] || byUid[uid]; return id ? dDownload(id) : null; };
        if (remote) Object.assign(st, await mergeState(remote, fetchFile, false));
        for (const [uid, ext] of Object.entries(await localFileUids())) {
          if (byUid[uid]) continue;
          const blob = await get('files', uid);
          if (blob) { await dUpload(uid + ext, att, blob, 'application/octet-stream'); st.uploaded_files++; }
        }
        const local = await exportState();
        if (signature(local) !== signature(remote)) {
          if (fid && (await dVersion(fid)) !== ver) continue;
          await dUpload('servicebok.json', root, new Blob([JSON.stringify(local)], { type: 'application/json' }), 'application/json', fid);
          st.uploaded_state = true;
        }
        const when = new Date().toLocaleString('sv-SE').slice(0, 16);
        await meta('last_sync', when);
        return { ok: true, stats: st, last_sync: when };
      }
      throw new Error('Synken krockade flera gånger i rad med en annan enhet. Försök igen.');
    })();
    try { return await syncing; } finally { syncing = null; }
  }

  // ------------------------------------------------------------ utskrift (PDF)
  // Alla händelser i datumordning: serviceposter + fordonsregistret (samma regler som build_timeline i pdf_export.py)
  const REG_TITLES = { besiktning: 'Besiktning', ägarbyte: 'Ägarbyte', påställd: 'Påställd', avställd: 'Avställd', annons: 'Annons',
    registrerad: 'Registrerad', förregistrerad: 'Förregistrerad', tillverkad: 'Tillverkad', avregistrerad: 'Avregistrerad',
    import: 'Import', skrotad: 'Skrotad' };
  function timeline(car, entries) {
    const rows = [], inspDates = new Set(entries.filter(e => (e.types || []).includes('Besiktning')).map(e => e.date));
    for (const e of entries) {
      const types = e.types || [], isInsp = types.length === 1 && types[0] === 'Besiktning';
      let desc = isInsp ? (e.notes || 'Besiktning') : types.join(', ');
      if (!isInsp && e.notes) desc += ` – ${e.notes}`;
      rows.push({ date: e.date, km: e.km, event: isInsp ? 'Besiktning' : 'Service', desc, by: /^Besiktning \(från/.test(e.performed_by || '') ? '' : (e.performed_by || ''),
        cost: e.cost != null ? `${Math.round(e.cost)} kr` : '' });
    }
    for (const h of car.vehicle_info?.history || []) {
      if (h.title && !/^[a-zåäö]+$/i.test(h.title)) continue;
      if (h.kind === 'besiktning' && inspDates.has(h.date)) continue;
      let desc = h.text || '';
      if (h.result && !desc.toLowerCase().startsWith(h.result)) desc = `${h.result[0].toUpperCase() + h.result.slice(1)} – ${desc}`;
      rows.push({ date: h.approx_month ? h.date.slice(0, 7) : h.date, km: h.meter, event: REG_TITLES[h.kind] || h.title || h.kind,
        desc, by: h.station || '', cost: '', registry: true });
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.km || 0) - (b.km || 0));
  }

  async function printBook(car, entries) {
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const km = k => k != null && k !== '' ? Number(k).toLocaleString('sv-SE') + ' km' : '–';
    entries = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.km || 0) - (b.km || 0));
    const rows = timeline(car, entries);
    let html = `<h1>Servicebok – ${esc(car.name)}</h1><p>${esc([car.regnr, car.model, car.chassis, car.vin].filter(Boolean).join(' · '))}<br>
      Mätarställning: ${km(car.mileage)}${car.next_inspection ? ` · Nästa besiktning senast ${esc(car.next_inspection)}` : ''} · Utskriven ${new Date().toISOString().slice(0, 10)}</p>
      <h2>Alla händelser</h2><p style="font-size:9pt;color:#666">Äldst först. * = från fordonsregistret (Biluppgifter/Transportstyrelsen).</p>
      <table><tr><th>Datum</th><th>Km</th><th>Händelse</th><th>Beskrivning</th><th>Utfört av / plats</th><th>Kostnad</th></tr>
      ${rows.map(r => `<tr><td>${esc(r.date)}</td><td>${r.km ? km(r.km) : ''}</td><td>${esc(r.event)}${r.registry ? ' *' : ''}</td><td>${esc(r.desc)}</td><td>${esc(r.by)}</td><td>${esc(r.cost)}</td></tr>`).join('')}</table>`;
    for (const e of entries) {
      html += `<section class="pb"><h2>${esc(e.date)} · ${km(e.km)}</h2><p><b>Åtgärder:</b> ${esc(e.types.join(', '))}</p>
        ${e.parts ? `<p><b>Delar:</b> ${esc(e.parts)}</p>` : ''}${e.notes ? `<p><b>Anteckningar:</b> ${esc(e.notes)}</p>` : ''}`;
      for (const a of e.attachments) {
        const u = a.is_image ? await fileUrl(a.uid, a.ext) : null;
        html += u ? `<figure><img src="${u}"><figcaption>${esc(a.filename)}</figcaption></figure>` : `<p>📎 ${esc(a.filename)}</p>`;
      }
      html += '</section>';
    }
    let pv = document.getElementById('printView');
    if (!pv) { pv = document.createElement('div'); pv.id = 'printView'; document.body.appendChild(pv); }
    pv.innerHTML = html;
    await Promise.all([...pv.querySelectorAll('img')].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
    document.body.classList.add('printing');
    window.print();
    setTimeout(() => document.body.classList.remove('printing'), 500);
  }

  // ------------------------------------------------------------ nedladdning / delning
  async function saveBlob(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [file], title: filename }); return filename; } catch (e) { if (e.name === 'AbortError') return null; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return filename;
  }
  function pickFile(accept) {
    return new Promise(res => {
      const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
      i.onchange = () => res(i.files[0] || null); i.click();
    });
  }

  // ============================================================ API
  const api = {
    async init() {
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      return { platform: 'web', lists: V.lists, service_types: V.service_types, statuses: V.statuses,
        config: { google_web_client_id: await clientId(), biluppgifter_api_key: (await meta('biluppgifter_api_key')) || '' },
        last_backup: await meta('last_backup') };
    },
    async save_config(cfg) {
      if ('google_web_client_id' in cfg) await meta('google_web_client_id', (cfg.google_web_client_id || '').trim());
      if ('biluppgifter_api_key' in cfg) await meta('biluppgifter_api_key', (cfg.biluppgifter_api_key || '').trim());
      return { google_web_client_id: await clientId(), biluppgifter_api_key: (await meta('biluppgifter_api_key')) || '' };
    },
    async fetch_vehicle_data(id) {
      const c = await get('cars', id), key = await meta('biluppgifter_api_key');
      if (!c.regnr) return { ok: false, error: 'Fyll i registreringsnummer under Bil först.' };
      if (!key) return { ok: false, error: 'API-nyckel till Biluppgifter saknas (Bil → Fordonsdata).' };
      let r;
      try {
        r = await fetch(`https://api.biluppgifter.se/api/v1/vehicle/regno/${encodeURIComponent(c.regnr)}?include=basic,inspection,status,history`,
          { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
      } catch (e) {
        return { ok: false, error: 'Biluppgifter gick inte att nå från mobilen (tjänsten kan blockera webbläsare). Hämta på datorn i stället – uppgifterna synkas hit.' };
      }
      if (!r.ok) return { ok: false, error: ({ 401: 'API-nyckeln godtogs inte.', 404: `Hittade inget fordon med ${c.regnr}.`, 429: 'Kvoten är slut för perioden.' })[r.status] || `Biluppgifter svarade ${r.status}` };
      const info = normalizeVehicle(await r.json());
      if (info.vin && c.vin && info.vin.slice(-7) !== c.vin.slice(-7)) info.warning = `VIN i registret (${info.vin}) skiljer sig från bilens sparade VIN (${c.vin}).`;
      return applyRegistry(c, info);
    },
    async set_vehicle_info(id, info) {
      const c = await get('cars', id);
      return applyRegistry(c, info);
    },
    async import_inspections(id) {
      const c = await get('cars', id);
      const have = new Set((await api.list_entries(id)).filter(e => e.types.includes('Besiktning')).map(e => e.date));
      let n = 0;
      for (const i of inspectionEntries(c.vehicle_info || {})) {
        if (have.has(i.date)) continue;
        await api.save_entry({ car_id: id, date: i.date, km: i.km, types: ['Besiktning'], performed_by: i.station || 'Besiktning (från fordonsregistret)',
          notes: i.text || '', car_status: 'ej_aktuellt', source: 'register' });
        n++;
      }
      return { imported: n };
    },
    // bilar
    async list_cars() {
      const cars = (await all('cars')).filter(c => !c.deleted).sort((a, b) => (a.created || '').localeCompare(b.created || ''));
      return Promise.all(cars.map(viewCar));
    },
    async save_car(car) {
      const vals = pick(car, CAR_FIELDS);
      if (vals.vin) vals.vin = vals.vin.trim().toUpperCase();
      if (vals.regnr) vals.regnr = vals.regnr.replace(/[\s-]/g, '').toUpperCase();
      if (!vals.name) vals.name = vals.model || 'Min bil';
      const old = car.id ? await get('cars', car.id) : null;
      const rec = old ? { ...old, ...vals, updated: nowUtc() }
        : { uid: newUid(), deleted: false, photo_uid: null, photo_credit: null, created: nowLocal(), ...vals, updated: nowUtc() };
      await put('cars', rec); await learnTypeKey(rec); changed();
      return viewCar(rec);
    },
    async delete_car(id) {
      const now = nowUtc();
      for (const e of (await all('entries')).filter(e => e.car_uid === id && !e.deleted)) await api.delete_entry(e.uid);
      const c = await get('cars', id); if (c.photo_uid) await removeFile(c.photo_uid);
      await put('cars', { ...c, deleted: true, updated: now }); changed(); return { ok: true };
    },
    decode_vin: decodeVin,
    async set_car_photo(id, filename, b64) {
      const c = await get('cars', id);
      if (c.photo_uid) await removeFile(c.photo_uid);
      let uid = null;
      if (b64) { uid = newUid(); await put('files', await shrinkImage(b64ToBlob(b64, mimeOf(filename)), 1600), uid); }
      await put('cars', { ...c, photo_uid: uid, photo_credit: null, updated: nowUtc() }); changed();
      return viewCar(await get('cars', id));
    },
    async find_car_photos(id) {
      const c = await get('cars', id), desc = (V.chassis[c.chassis] || [''])[0], qs = [];
      if (c.chassis && c.chassis !== 'Annan') { if (desc.includes('Touring')) qs.push(`BMW ${c.chassis} Touring`); qs.push(`BMW ${c.chassis}`); }
      if (c.model) qs.push(/bmw/i.test(c.model) ? c.model : `BMW ${c.model}`);
      const seen = new Set(), res = [];
      for (const q of qs) { for (const r of await commonsSearch(q)) if (!seen.has(r.title)) { seen.add(r.title); res.push(r); } if (res.length >= 12) break; }
      if (!res.length) return { ok: false, error: 'Hittade inga bilder. Välj chassi eller fyll i modell.' };
      return { photos: res.slice(0, 16) };
    },
    async choose_car_photo(id, photo) {
      const blob = await (await fetch(photo.thumb)).blob();
      const c = await get('cars', id); if (c.photo_uid) await removeFile(c.photo_uid);
      const uid = newUid(); await put('files', blob, uid);
      await put('cars', { ...c, photo_uid: uid, photo_credit: `Foto: ${photo.artist}, ${photo.license} – Wikimedia Commons`, updated: nowUtc() });
      changed(); return viewCar(await get('cars', id));
    },
    // poster
    async list_entries(carId) {
      const list = (await all('entries')).filter(e => e.car_uid === carId && !e.deleted)
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.km || 0) - (a.km || 0));
      return Promise.all(list.map(viewEntry));
    },
    async get_entry(id) { return viewEntry(await get('entries', id)); },
    async save_entry(entry) {
      const vals = pick(entry, ENTRY_FIELDS);
      if (!vals.date) return { ok: false, error: 'Datum saknas' };
      vals.km = vals.km === '' || vals.km == null ? null : parseInt(vals.km, 10);
      vals.cost = vals.cost === '' || vals.cost == null ? null : parseFloat(vals.cost);
      vals.types = vals.types || []; vals.car_status = vals.car_status || 'ej_skriven'; vals.source = vals.source || 'egen';
      const old = entry.id ? await get('entries', entry.id) : null;
      const rec = old ? { ...old, ...vals, updated: nowUtc() }
        : { uid: newUid(), deleted: false, car_uid: entry.car_id, created: nowLocal(), ...vals, updated: nowUtc() };
      await put('entries', rec);
      const car = await get('cars', rec.car_uid);
      if (rec.km && rec.km > (car.mileage || 0)) await put('cars', { ...car, mileage: rec.km, updated: nowUtc() });
      changed(); return viewEntry(rec);
    },
    async delete_entry(id) {
      const now = nowUtc();
      for (const a of (await all('attachments')).filter(a => a.entry_uid === id && !a.deleted)) {
        await removeFile(a.uid); await put('attachments', { ...a, deleted: true, updated: now });
      }
      await put('entries', { ...(await get('entries', id)), deleted: true, updated: now }); changed(); return { ok: true };
    },
    // bilagor
    async add_attachment(entryId, filename, b64) {
      let blob = b64ToBlob(b64, mimeOf(filename));
      const small = await shrinkImage(blob);
      if (small !== blob) { blob = small; filename = filename.replace(/\.[^.]+$/, '') + '.jpg'; }
      const rec = { uid: newUid(), deleted: false, entry_uid: entryId, filename, mime: blob.type || mimeOf(filename),
        ext: extOf(filename), added: nowLocal(), updated: nowUtc() };
      await put('files', blob, rec.uid); await put('attachments', rec); changed();
      return rec;
    },
    async delete_attachment(id) {
      await removeFile(id); await put('attachments', { ...(await get('attachments', id)), deleted: true, updated: nowUtc() });
      changed(); return { ok: true };
    },
    async attachment_url(id) { const a = await get('attachments', id); return fileUrl(id, a?.ext); },
    async thumb(id) { return api.attachment_url(id); },
    async open_attachment(id) {
      const u = await api.attachment_url(id);
      if (!u) return { ok: false, error: 'Filen finns inte i telefonen än. Synka med Google Drive först.' };
      window.open(u, '_blank'); return { ok: true };
    },
    async latest_snapshot(carId) {
      const s = (await all('snapshots')).filter(s => s.car_uid === carId).sort((a, b) => (b.taken_at || '').localeCompare(a.taken_at || ''))[0];
      return s ? { ...s.data, taken_at: s.taken_at } : null;
    },
    async car_status() { return { connected: false, mock: false }; },
    // backup
    async backup_zip() {
      const zip = new JSZip(); const state = await exportState();
      zip.file('servicebok.json', JSON.stringify(state));
      let missing = 0;
      for (const [uid, ext] of Object.entries(await localFileUids())) {
        let blob = await get('files', uid);
        if (!blob && driveTokenValid()) { try { blob = await driveFetchFile(uid, ext); } catch { } }
        if (blob) zip.file(`filer/${uid}${ext}`, blob); else missing++;
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const name = await saveBlob(blob, `servicebok_backup_${new Date().toISOString().slice(0, 10)}.zip`);
      if (name) await meta('last_backup', new Date().toISOString());
      return { path: name, missing };
    },
    async import_backup() {
      const f = await pickFile('.zip,application/zip');
      if (!f) return { stats: null };
      const zip = await JSZip.loadAsync(f);
      const js = zip.file('servicebok.json');
      if (!js) return { ok: false, error: 'Filen saknar servicebok.json. Gör en ny backup på datorn och prova igen.' };
      const files = {}; zip.folder('filer').forEach((p, e) => { if (!e.dir) files[p.replace(/\.[^.]+$/, '')] = e; });
      const stats = await mergeState(JSON.parse(await js.async('string')),
        async uid => files[uid] ? new Blob([await files[uid].async('arraybuffer')], { type: mimeOf(files[uid].name) }) : null, true);
      changed(); return { stats };
    },
    async export_pdf(carId) {
      const car = await viewCar(await get('cars', carId));
      const entries = (await api.list_entries(carId)).reverse();
      await printBook(car, entries); return { path: 'utskrift' };
    },
    async open_data_dir() { return { ok: false, error: 'Finns bara på datorn' }; },
    // Google Drive
    async drive_status() {
      return { configured: !!(await clientId()), connected: !!localStorage.sbDriveConnected,
        token_valid: driveTokenValid(), last_sync: await meta('last_sync') };
    },
    async drive_connect() { await driveLogin(); },
    async drive_disconnect() { localStorage.removeItem('sbToken'); localStorage.removeItem('sbDriveConnected'); driveIds = attList = null; return { ok: true }; },
    async drive_sync() {
      if (!driveTokenValid()) { await driveLogin(); }
      try { return await driveSync(); }
      catch (e) { if (e.needLogin) await driveLogin(); throw e; }
    },
    async drive_sync_silent() {   // bara om token fortfarande gäller (ingen omdirigering)
      if (!localStorage.sbDriveConnected || !driveTokenValid() || !navigator.onLine) return { ok: false, skipped: true };
      return driveSync();
    },
  };

  // Fel ska se ut som från Python: {ok:false, error}
  const wrapped = {};
  Object.entries(api).forEach(([k, fn]) => {
    wrapped[k] = async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); return { ok: false, error: e.message || String(e) }; } };
  });
  wrapped._onChange = fn => { changed = fn; };
  wrapped._justLoggedIn = handleRedirect();
  window.WEBSTORE = wrapped;
  window.WEBSTORE_INTERNAL = { mergeState, exportState, signature, normalizeVehicle };   // för tester
})();
