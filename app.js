// Servicebok – gränssnitt. Pratar med Python (pywebview, datorn) eller med webstore.js (mobil/webb).
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idOf = v => (v === '' || v == null || v === 'null') ? null : (/^\d+$/.test(String(v)) ? Number(v) : String(v));
const fmtKm = km => (km || km === 0) ? Number(km).toLocaleString('sv-SE') + ' km' : '–';

const S = { cars: [], car: null, entries: [], lists: {}, types: [], statuses: {}, config: {},
  editing: null, pending: [], connected: false, lastRead: null, exploreSgbd: null, lastResult: '', web: false, drive: {} };
const MUTATING = new Set(['save_car', 'delete_car', 'set_car_photo', 'choose_car_photo', 'save_entry', 'delete_entry',
  'add_attachment', 'delete_attachment', 'car_read', 'car_write', 'import_from_car', 'import_backup']);

let api;
async function call(name, ...args) {
  try {
    const r = await api[name](...args);
    if (r && r.error && r.ok === false) throw new Error(r.error);
    if (MUTATING.has(name)) scheduleSync();
    return r;
  } catch (e) {
    toast('⚠ ' + (e.message || e), 5000);
    throw e;
  }
}

function toast(text, ms = 2500) {
  const t = $('#toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}

function modal(title, html, okText = 'OK', cancel = true) {
  return new Promise(res => {
    $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html;
    $('#modalOk').textContent = okText; $('#modalCancel').hidden = !cancel;
    $('#modalCancel').textContent = typeof cancel === 'string' ? cancel : 'Avbryt';
    $('#modal').hidden = false;
    const done = v => { $('#modal').hidden = true; res(v); };
    $('#modalOk').onclick = () => done(true); $('#modalCancel').onclick = () => done(false);
  });
}

function readFileB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file);
  });
}

// ------------------------------------------------------------- navigering
function go(page) {
  if (page === 'entry' && !S.editing) newEntry();
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  if (page === 'home') renderHome();
  if (page === 'log') renderLog();
  if (page === 'car') renderCarForm();
  if (page === 'backup') renderDrive();
  if (page !== 'entry') S.editing = null;
}
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); go(g.dataset.goto); }
  const n = e.target.closest('#nav a'); if (n) go(n.dataset.page);
});

// --------------------------------------------------------------------- bil
function carImageHtml(car) {
  if (!car) return '';
  return car.photo_url ? `<img src="${car.photo_url}">`
    : `<div class="no-photo"><b>📷</b>Ingen bild än.<br><a href="#" data-goto="car">Hämta bild på riktig bil</a></div>`;
}

async function loadCars(selectId) {
  S.cars = await call('list_cars');
  if (!S.cars.length) {
    S.car = await api.save_car({ name: S.web ? 'Min bil' : 'Min BMW', chassis: S.web ? '' : 'F11', body: S.web ? 'sedan' : 'touring',
      profile: S.web ? null : 'f-cas4' });
    S.cars = [S.car];
  }
  const id = selectId || (S.car && S.car.id) || idOf(localStorage.carId) || S.cars[0].id;
  S.car = S.cars.find(c => c.id === id) || S.cars[0];
  localStorage.carId = S.car.id;
  $('#carSelect').innerHTML = S.cars.map(c => `<option value="${c.id}" ${c.id === S.car.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  S.entries = await call('list_entries', S.car.id);
}
$('#carSelect').onchange = async e => { await loadCars(idOf(e.target.value)); S.lastRead = null; go('home'); };

async function renderHome() {
  const c = S.car; if (!c) return;
  $('#heroImg').innerHTML = carImageHtml(c);
  $('#heroCredit').textContent = c.photo_url ? (c.photo_credit || '') : '';
  $('#heroName').textContent = c.name;
  $('#heroModel').textContent = [c.model, c.chassis && `(${c.chassis})`].filter(Boolean).join(' ');
  const facts = [['VIN', c.vin], ['Årsmodell', c.year], ['Färg', [c.paint_code, c.paint_name].filter(Boolean).join(' ')],
    ['Mätarställning', fmtKm(c.mileage)], ['Antal servicer', S.entries.length]];
  $('#heroFacts').innerHTML = facts.filter(f => f[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');

  const snap = S.lastRead || (await call('latest_snapshot', c.id));
  const cbs = snap && snap.cbs || [];
  $('#cbsList').innerHTML = cbs.length ? cbs.map(x => {
    const p = x.percent ?? 0, col = p < 15 ? 'var(--bad)' : p < 40 ? 'var(--warn)' : 'var(--ok)';
    const extra = [x.km && fmtKm(x.km), x.date].filter(Boolean).join(' · ');
    return `<div class="cbs-row"><span>${esc(x.type)}</span><div class="bar"><div style="width:${p}%;background:${col}"></div></div><small>${esc(extra || p + ' %')}</small></div>`;
  }).join('') + `<small class="muted">Läst ${esc(snap.read_at || snap.taken_at || '')}</small>`
    : (S.web ? `<div class="empty">Ingen CBS-data än. Den läses från bilen i datorprogrammet och synkas hit.</div>`
      : `<div class="empty">Ingen CBS-data än. Anslut bilen under <a href="#" data-goto="live">Bilen live</a>.</div>`);
  backupReminder();

  $('#timeline').innerHTML = S.entries.slice(0, 6).map(e =>
    `<li data-id="${e.id}"><b>${esc(e.date)} · ${fmtKm(e.km)}</b><span class="muted">${esc(e.types.join(', ') || e.notes || '')}</span></li>`).join('')
    || '<div class="empty">Inga servicer än.</div>';
  $$('#timeline li').forEach(li => li.onclick = () => editEntry(idOf(li.dataset.id)));
}

// ----------------------------------------------------------- servicebok
const STATUS_BADGE = { ej_skriven: 'warn', skriven: 'ok', importerad: 'info', ej_aktuellt: 'off' };
function renderLog() {
  const q = $('#logSearch').value.trim().toLowerCase();
  const list = S.entries.filter(e => !q || JSON.stringify([e.date, e.km, e.types, e.notes, e.parts, e.performed_by]).toLowerCase().includes(q));
  $('#logList').innerHTML = list.map(e => `
    <div class="card entry" data-id="${e.id}">
      <div><div class="date">${esc(e.date)}</div><div class="km">${fmtKm(e.km)}</div></div>
      <div>
        <div class="chips">${e.types.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>
        ${e.notes ? `<div class="muted" style="margin-top:6px">${esc(e.notes)}</div>` : ''}
        <div class="mini-thumbs" data-thumbs="${e.id}">${e.attachments.length ? '' : ''}</div>
      </div>
      <div style="text-align:right">
        <span class="badge ${STATUS_BADGE[e.car_status] || 'off'}">${esc(S.statuses[e.car_status] || e.car_status)}</span>
        ${e.cost != null ? `<div style="margin-top:6px;font-weight:600">${Number(e.cost).toLocaleString('sv-SE')} kr</div>` : ''}
        ${e.attachments.length ? `<div class="muted" style="margin-top:4px">📎 ${e.attachments.length}</div>` : ''}
      </div>
    </div>`).join('') || '<div class="empty card">Inga poster. Klicka på <b>Ny service</b> för att lägga till din första.</div>';
  $$('#logList .entry').forEach(el => el.onclick = () => editEntry(idOf(el.dataset.id)));
  list.forEach(async e => {
    const imgs = e.attachments.filter(a => a.is_image).slice(0, 4);
    if (!imgs.length) return;
    const box = document.querySelector(`[data-thumbs="${e.id}"]`);
    for (const a of imgs) { const u = await api.thumb(a.id); if (u && box) box.insertAdjacentHTML('beforeend', `<img src="${u}">`); }
  });
}
$('#logSearch').oninput = renderLog;

// --------------------------------------------------------- ny/redigera
function fillEntryForm(e) {
  const f = $('#entryForm');
  f.date.value = e.date || new Date().toISOString().slice(0, 10);
  f.km.value = e.km ?? ''; f.performed_by.value = e.performed_by || '';
  f.parts.value = e.parts || ''; f.notes.value = e.notes || ''; f.cost.value = e.cost ?? '';
  f.car_status.innerHTML = Object.entries(S.statuses).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  f.car_status.value = e.car_status || 'ej_skriven';
  $('#typeChips').innerHTML = S.types.map(t => `<span class="chip ${e.types?.includes(t) ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</span>`).join('');
  $$('#typeChips .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
  $('#entryTitle').textContent = e.id ? `Service ${e.date}` : 'Ny service';
  $('#entryDelete').hidden = !e.id;
  renderAttachments();
}
function newEntry() {
  S.editing = { types: [], performed_by: 'Egen service', km: S.car?.mileage || '' };
  S.pending = []; fillEntryForm(S.editing);
}
async function editEntry(id) {
  S.editing = await call('get_entry', id); S.pending = [];
  fillEntryForm(S.editing);
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-entry'));
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === 'entry'));
}

async function renderAttachments() {
  const box = $('#attList'); box.innerHTML = '';
  const saved = S.editing?.attachments || [];
  const icon = n => /\.pdf$/i.test(n) ? '📄' : '📎';
  for (const a of saved) {
    const el = document.createElement('div'); el.className = 'thumb';
    el.innerHTML = `<div class="pic">${icon(a.filename)}</div><div class="name" title="${esc(a.filename)}">${esc(a.filename)}</div><button type="button" class="x">✕</button>`;
    box.appendChild(el);
    if (a.is_image) api.thumb(a.id).then(u => { if (u) el.querySelector('.pic').innerHTML = `<img src="${u}">`; });
    el.querySelector('.pic').onclick = async () => {
      if (a.is_image) { const u = await call('attachment_url', a.id); $('#viewerImg').src = u; $('#viewer').hidden = false; }
      else call('open_attachment', a.id);
    };
    el.querySelector('.x').onclick = async () => {
      if (!await modal('Ta bort bilaga?', `<p>${esc(a.filename)} tas bort permanent från servicebokens mapp.</p>`, 'Ta bort')) return;
      await call('delete_attachment', a.id);
      S.editing.attachments = S.editing.attachments.filter(x => x.id !== a.id); renderAttachments();
    };
  }
  S.pending.forEach((p, i) => {
    const el = document.createElement('div'); el.className = 'thumb';
    const isImg = /^image\//.test(p.type);
    el.innerHTML = `<div class="pic">${isImg ? `<img src="data:${p.type};base64,${p.b64}">` : icon(p.name)}</div><div class="name">${esc(p.name)} <i class="muted">(ej sparad)</i></div><button type="button" class="x">✕</button>`;
    el.querySelector('.x').onclick = () => { S.pending.splice(i, 1); renderAttachments(); };
    box.appendChild(el);
  });
}
async function addFiles(files) {
  for (const f of files) {
    if (f.size > 40 * 1024 * 1024) { toast(`${f.name} är större än 40 MB och hoppas över`); continue; }
    S.pending.push({ name: f.name, type: f.type, b64: await readFileB64(f) });
  }
  renderAttachments();
}
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
$('#pickFiles').onclick = () => $('#fileInput').click();
$('#pickFiles2').onclick = () => $('#fileInput').click();
$('#btnCamera').onclick = () => $('#cameraInput').click();
$('#cameraInput').onchange = e => { addFiles([...e.target.files].map((f, i) => f.name && f.name !== 'image.jpg' ? f
  : new File([f], `kvitto_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}${i ? '_' + i : ''}.jpg`, { type: f.type })));
  e.target.value = ''; };
$('#fileInput').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
$('#viewer').onclick = () => { $('#viewer').hidden = true; };

$('#entryForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const entry = { ...S.editing, car_id: S.car.id, date: f.date.value, km: f.km.value, performed_by: f.performed_by.value,
    parts: f.parts.value, notes: f.notes.value, cost: f.cost.value, car_status: f.car_status.value,
    types: $$('#typeChips .chip.on').map(c => c.dataset.t) };
  delete entry.attachments;
  if (!entry.types.length && !entry.notes) { toast('Välj minst en åtgärd eller skriv en anteckning'); return; }
  if (S.car.mileage && entry.km && Number(entry.km) < S.car.max_logged_km && !entry.id) {
    if (!await modal('Lägre mätarställning', `<p>${fmtKm(entry.km)} är lägre än den senaste loggade (${fmtKm(S.car.max_logged_km)}). Spara ändå?</p>`, 'Spara')) return;
  }
  const saved = await call('save_entry', entry);
  for (const p of S.pending) await call('add_attachment', saved.id, p.name, p.b64);
  S.pending = []; S.editing = null;
  await loadCars(S.car.id);
  toast('✓ Sparad'); go('log');
};
$('#entryDelete').onclick = async () => {
  const e = S.editing;
  if (!await modal('Ta bort service?', `<p>Posten ${esc(e.date)} och dess ${e.attachments.length} bilagor tas bort permanent från loggboken. Ta en backup först om du är osäker.</p>`, 'Ta bort')) return;
  await call('delete_entry', e.id); S.editing = null; await loadCars(S.car.id); go('log');
};

// ---------------------------------------------------------- bilen live
function setConn(on, mock) {
  S.connected = on;
  const b = $('#connBadge');
  b.className = 'badge desktop-only ' + (on ? (mock ? 'info' : 'ok') : 'off');
  b.textContent = on ? (mock ? 'Demoläge' : 'Ansluten (ENET)') : 'Ej ansluten';
  $('#btnRead').disabled = !on;
}
async function connect(mock) {
  $('#liveMsg').className = 'msg'; $('#liveMsg').textContent = 'Ansluter…';
  try {
    const r = await call('car_connect', mock);
    setConn(true, r.mock);
    $('#liveMsg').className = 'msg ok';
    $('#liveMsg').textContent = r.mock ? 'Demoläge: en låtsad F11 svarar. Inget skrivs till någon riktig bil.' : 'Ansluten.';
  } catch (e) { $('#liveMsg').className = 'msg err'; $('#liveMsg').textContent = e.message; setConn(false); }
}
$('#btnConnect').onclick = () => connect(false);
$('#btnDemo').onclick = () => connect(true);
$('#btnDisconnect').onclick = async () => { await call('car_disconnect'); setConn(false); $('#liveMsg').textContent = ''; };
$('#btnRead').onclick = readCar;

async function readCar() {
  $('#liveMsg').className = 'msg'; $('#liveMsg').textContent = 'Läser bilen…';
  const r = await call('car_read', S.car.id);
  S.lastRead = r.data;
  $('#liveMsg').className = 'msg ok'; $('#liveMsg').textContent = 'Läsning klar och sparad som ögonblicksbild.';
  await loadCars(S.car.id);
  renderLive(r);
}

function histRow(h) { return `<td>${esc(h.date)}</td><td>${fmtKm(h.km)}</td><td>${esc((h.types || []).join(', '))}</td>`; }

function renderLive(r) {
  const d = r.data, cmp = r.compare;
  const errs = Object.entries(d.errors || {});
  let html = '';
  if (!d.verified) html += `<div class="card alert"><b>Profilen är inte verifierad.</b> Jobbnamnen för ${esc(d.profile)} är kandidater. Läsning provas, men skrivning är avstängd tills du har kontrollerat jobben under <a href="#" data-goto="explore">Utforska</a>.${d.mock ? ' (Demoläget kan skriva till den låtsade bilen.)' : ''}</div>`;
  if (r.notes?.length) html += `<div class="card alert">${r.notes.map(esc).join('<br>')}</div>`;
  html += `<div class="grid2"><div class="card"><h2>Bilen</h2><table>
    <tr><th>VIN</th><td>${esc(d.vin || '–')}</td></tr>
    <tr><th>Mätarställning</th><td>${fmtKm(d.mileage)}</td></tr>
    <tr><th>Chassi (FA)</th><td>${esc(d.fa?.chassis || '–')}</td></tr>
    <tr><th>Färgkod (FA)</th><td>${esc(d.fa?.paint_code || '–')}</td></tr>
    <tr><th>Produktion</th><td>${esc(d.fa?.production || '–')}</td></tr></table>
    ${errs.length ? `<details style="margin-top:10px"><summary class="muted">${errs.length} saker kunde inte läsas</summary><pre class="pre">${errs.map(([k, v]) => k + ': ' + v).map(esc).join('\n')}</pre></details>` : ''}
    </div>
    <div class="card"><h2>Servicehistorik i bilen (${d.history.length})</h2>
    <table><tr><th>Datum</th><th>Km</th><th>Åtgärder</th></tr>${d.history.map(h => `<tr>${histRow(h)}</tr>`).join('') || '<tr><td colspan=3 class="muted">Ingen historik kunde läsas</td></tr>'}</table></div></div>`;

  if (cmp.disappeared_since_last.length) html += `<div class="card alert bad"><h2>⚠ Poster har försvunnit ur bilen sedan förra läsningen</h2>
    <table>${cmp.disappeared_since_last.map(h => `<tr>${histRow(h)}</tr>`).join('')}</table>
    <p class="muted">De finns kvar i ögonblicksbilderna. Om de också finns i loggboken kan du skriva tillbaka dem nedan.</p></div>`;
  html += `<div class="card"><h2>I loggboken men saknas i bilen (${cmp.missing_in_car.length})</h2>
    <table>${cmp.missing_in_car.map(e => `<tr>${histRow(e)}<td><span class="badge ${STATUS_BADGE[e.car_status]}">${esc(S.statuses[e.car_status])}</span></td>
    <td style="text-align:right"><button class="primary small" data-write="${e.id}">Skriv till bilen</button></td></tr>`).join('') || '<tr><td class="muted">Allt i loggboken finns i bilen 👍</td></tr>'}</table></div>`;
  html += `<div class="card"><h2>I bilen men saknas i loggboken (${cmp.only_in_car.length})</h2>
    <table>${cmp.only_in_car.map((h, i) => `<tr>${histRow(h)}<td style="text-align:right"><button class="ghost small" data-import="${i}">Importera</button></td></tr>`).join('') || '<tr><td class="muted">Inget att importera</td></tr>'}</table></div>`;
  $('#liveResult').innerHTML = html;
  $$('[data-write]').forEach(b => b.onclick = () => writeEntry(idOf(b.dataset.write)));
  $$('[data-import]').forEach(b => b.onclick = async () => {
    await call('import_from_car', S.car.id, cmp.only_in_car[Number(b.dataset.import)]);
    toast('✓ Importerad till loggboken'); await loadCars(S.car.id); readCar();
  });
}

async function writeEntry(entryId) {
  const pv = await call('car_write_preview', S.car.id, entryId);
  const ok = await modal('Skriv service till bilen', `
    <p>Följande skickas till styrenheten${pv.mock ? ' <b>(demoläge, ingen riktig bil)</b>' : ''}:</p>
    <table><tr><th>SGBD</th><td><code>${esc(pv.sgbd)}</code></td></tr><tr><th>Jobb</th><td><code>${esc(pv.job)}</code></td></tr>
    <tr><th>Argument</th><td><code>${esc(pv.args)}</code></td></tr></table>
    <p class="muted">Innan skrivningen läses och sparas bilens nuvarande historik som backup. Efteråt läses den in igen för kontroll.
    Skriv bara in service som faktiskt har utförts. Ha batteriladdare ansluten och tändningen på.</p>`, 'Skriv till bilen');
  if (!ok) return;
  const r = await call('car_write', S.car.id, entryId);
  toast(r.verified ? '✓ Skriven och kontrollerad i bilen' : '⚠ Skriven, men hittades inte vid omläsning', 5000);
  await loadCars(S.car.id); readCar();
}

// ------------------------------------------------------------ utforska
$('#btnSgbd').onclick = async () => {
  if (!S.connected) { toast('Anslut först under Bilen live'); return; }
  const r = await call('explore_sgbd', $('#sgbdPattern').value.split(/\s+/).filter(Boolean));
  $('#sgbdList').innerHTML = r.files.map(f => `<button class="ghost small" data-sgbd="${esc(f.replace(/\.(prg|grp)$/i, ''))}">${esc(f)}</button>`).join('') || '<span class="muted">Inga filer matchade</span>';
  $$('[data-sgbd]').forEach(b => b.onclick = () => loadJobs(b.dataset.sgbd));
};
async function loadJobs(sgbd) {
  S.exploreSgbd = sgbd; $('#jobSgbd').textContent = sgbd;
  const r = await call('explore_jobs', sgbd); S.jobs = r.jobs; renderJobs();
}
function renderJobs() {
  let re; try { re = new RegExp($('#jobFilter').value || '.', 'i'); } catch { re = /./; }
  const jobs = (S.jobs || []).filter(j => re.test(j.name));
  $('#jobList').innerHTML = jobs.map(j => `<div class="${j.read ? '' : 'write'}" data-job="${esc(j.name)}" title="${j.read ? 'Läsjobb – klicka för att köra' : 'Skriv/styrjobb – kan inte köras här'}">${j.read ? '▶' : '🔒'} ${esc(j.name)}</div>`).join('') || '<span class="muted">Inga jobb</span>';
  $$('[data-job]').forEach(el => el.onclick = () => runJob(el.dataset.job));
}
$('#jobFilter').oninput = renderJobs;
async function runJob(job) {
  $('#resTitle').textContent = `${S.exploreSgbd} / ${job}`;
  $('#jobResult').textContent = 'Kör…';
  try {
    const r = await call('explore_run', S.exploreSgbd, job, $('#jobArgs').value);
    S.lastResult = r.text; $('#jobResult').textContent = r.text;
  } catch (e) { $('#jobResult').textContent = e.message; }
}
$('#btnSaveRes').onclick = async () => {
  if (!S.lastResult) return;
  const r = await call('save_research', $('#resTitle').textContent, S.lastResult);
  toast('Sparad: ' + r.path);
};

// ---------------------------------------------------------- backup
$('#btnBackup').onclick = async () => {
  const r = await call('backup_zip'); if (r.path) { $('#backupMsg').className = 'msg ok'; $('#backupMsg').textContent = '✓ ' + r.path; }
};
$('#btnPdf').onclick = async () => {
  const r = await call('export_pdf', S.car.id); if (r.path) { $('#pdfMsg').className = 'msg ok'; $('#pdfMsg').textContent = '✓ ' + r.path; }
};
$('#btnOpenData').onclick = () => call('open_data_dir');
$('#btnImport').onclick = async () => {
  const r = await call('import_backup'); if (!r.stats) return;
  const s = r.stats;
  $('#backupMsg').className = 'msg ok';
  $('#backupMsg').textContent = `✓ Importerat: ${s.cars} bilar, ${s.entries} poster, ${s.attachments} bilagor, ${s.files} filer (bara nyare versioner tas in).`;
  await loadCars(S.car?.id); renderHome();
};

// ---------------------------------------------------------- google drive
async function renderDrive() {
  const d = S.drive = await api.drive_status() || {};
  const b = $('#syncBadge');
  b.hidden = !d.connected;
  b.className = 'badge ' + (d.error ? 'warn' : 'ok');
  b.textContent = d.error ? '☁ Ej synkad' : '☁ Synkad';
  b.title = d.last_sync ? 'Senast synkad ' + d.last_sync : '';
  $('#btnDriveConnect').hidden = !!d.connected;
  $('#btnDriveSync').hidden = $('#btnDriveDisconnect').hidden = !d.connected;
  let txt = !d.configured ? 'Inte inställt ännu – fyll i Google-inställningarna nedan (se README).'
    : d.connected ? `Inloggad. ${d.last_sync ? 'Senast synkad ' + d.last_sync + '.' : 'Inte synkad än.'}` : 'Inte inloggad.';
  if (S.web && d.connected && !d.token_valid) txt += ' Tryck Synka nu för att logga in igen (Google kräver det varje timme).';
  if (S.web && !d.connected) txt += ' Tips: på iPhone kan Safari radera webbappars data efter flera veckor utan användning – Drive-synk eller backup skyddar mot det.';
  $('#driveStatus').textContent = txt;
  const g = $('#googleForm');
  g.google_web_client_id.value = S.config.google_web_client_id || '';
  g.google_client_id.value = S.config.google_client_id || '';
  g.google_client_secret.value = S.config.google_client_secret || '';
}
let syncTimer = null, syncBusy = false;
function scheduleSync(delay = 4000) {
  if (!S.drive?.connected) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync(false), delay);
}
async function runSync(manual) {
  if (syncBusy) return; syncBusy = true;
  const b = $('#syncBadge'); b.hidden = false; b.className = 'badge info'; b.textContent = '☁ Synkar…';
  try {
    const r = manual ? await api.drive_sync() : await (S.web ? api.drive_sync_silent() : api.drive_sync());
    if (r && r.skipped) { await renderDrive(); return; }
    if (r && r.ok === false) throw new Error(r.error);
    S.drive.error = null;
    const s = r.stats || {};
    if ((s.cars || s.entries || s.attachments || s.snapshots || s.files) && !$('#page-entry').classList.contains('active')) {
      await loadCars(S.car?.id); const p = $('.page.active').id.replace('page-', ''); if (p !== 'live') go(p);
    }
    if (manual) toast('✓ Synkad med Google Drive');
  } catch (e) {
    S.drive.error = e.message;
    if (manual) toast('⚠ ' + e.message, 6000);
  } finally {
    syncBusy = false; await renderDrive();
    if (S.drive.error) { b.className = 'badge warn'; b.textContent = '☁ Ej synkad'; b.title = S.drive.error; }
  }
}
$('#btnDriveConnect').onclick = async () => {
  if (!S.web) toast('Ett webbläsarfönster öppnas för inloggning hos Google…', 6000);
  const r = await call('drive_connect'); if (r) { toast('✓ Inloggad och synkad'); await loadCars(S.car?.id); go('backup'); }
  await renderDrive();
};
$('#btnDriveSync').onclick = () => runSync(true);
$('#syncBadge').onclick = () => runSync(true);
$('#btnDriveDisconnect').onclick = async () => {
  if (!await modal('Logga ut från Google Drive?', '<p>Serviceboken finns kvar både här och i Drive, men synkas inte längre från den här enheten.</p>', 'Logga ut')) return;
  await call('drive_disconnect'); await renderDrive();
};
$('#googleForm').onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  const cfg = { google_web_client_id: f.google_web_client_id.value };
  if (!S.web) Object.assign(cfg, { google_client_id: f.google_client_id.value, google_client_secret: f.google_client_secret.value });
  S.config = { ...S.config, ...(await call('save_config', cfg)) }; toast('✓ Google-inställningar sparade'); renderDrive();
};
window.addEventListener('online', () => scheduleSync(1000));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(500); });

function backupReminder() {
  if (!S.web || S.drive?.connected || !S.entries.length) return;
  const last = S.lastBackup ? new Date(S.lastBackup) : null;
  if (!last || Date.now() - last > 30 * 864e5) {
    if (sessionStorage.sbRemind) return; sessionStorage.sbRemind = 1;
    toast('💾 Det var länge sedan du tog backup. Slå på Google Drive-synk eller gör en backup under Synk & backup.', 7000);
  }
}

// ------------------------------------------------------- bilinställningar
function opt(v, t, sel) { return `<option value="${esc(v ?? '')}" ${String(sel ?? '') === String(v ?? '') ? 'selected' : ''}>${esc(t)}</option>`; }
function renderCarForm(car = S.car) {
  const f = $('#carForm'), L = S.lists;
  $('#carTitle').textContent = car.id ? car.name : 'Ny bil';
  f.name.value = car.name || ''; f.vin.value = car.vin || ''; f.model.value = car.model || '';
  f.year.value = car.year || ''; f.mileage.value = car.mileage || '';
  f.chassis.innerHTML = opt('', '– välj –', car.chassis) + L.chassis.map(c => opt(c.code, `${c.code} · ${c.desc}`, car.chassis)).join('');
  f.paint_code.innerHTML = opt('', 'Egen kulör', car.paint_code) + L.paints.map(p => opt(p.code, `${p.code} · ${p.name}`, car.paint_code)).join('');
  f.dataset.body = car.body || 'sedan';
  f.profile.innerHTML = L.profiles.map(p => opt(p.id, p.name, car.profile)).join('');
  $('#vinInfo').textContent = '';
  f.dataset.id = car.id || '';
  updatePreview();
  const cf = $('#cfgForm'); cf.ediabas_dir.value = S.config.ediabas_dir || ''; cf.python32.value = S.config.python32 || '';
}
function formCar() {
  const f = $('#carForm');
  const p = S.lists.paints.find(x => x.code === f.paint_code.value);
  return { id: idOf(f.dataset.id), name: f.name.value, vin: f.vin.value, chassis: f.chassis.value,
    model: f.model.value, year: Number(f.year.value) || null, body: f.dataset.body, paint_code: f.paint_code.value || null,
    paint_name: p ? p.name : null, paint_hex: p ? p.hex : null, profile: f.profile.value || null, mileage: Number(f.mileage.value) || null };
}
function updatePreview() {
  const cur = S.cars.find(x => x.id === formCar().id);
  $('#carPreview').innerHTML = carImageHtml(cur || {});
  $('#photoCredit').textContent = cur?.photo_url ? (cur.photo_credit || '') : '';
}
$('#carForm').chassis.onchange = e => {
  const c = S.lists.chassis.find(x => x.code === e.target.value); if (!c) return;
  const f = $('#carForm'); f.dataset.body = c.body; f.profile.value = c.profile ?? '';
  if (!f.model.value && c.code !== 'Annan') f.model.value = c.desc;
};
$('#btnDecode').onclick = async () => {
  const f = $('#carForm'), d = await call('decode_vin', f.vin.value);
  const info = d.valid ? [`${d.manufacturer}`, d.year && `årsmodell ${d.year}`, `typnyckel ${d.type_key}`, d.chassis && `chassi ${d.chassis} (${d.source})`].filter(Boolean).join(' · ') : '';
  $('#vinInfo').className = 'msg ' + (d.valid ? 'ok' : 'err');
  $('#vinInfo').innerHTML = esc(info) + (d.warnings.length ? '<br>' + d.warnings.map(esc).join('<br>') : '') +
    (d.valid && !d.chassis ? '<br><span class="muted">Chassit går inte att läsa ur VIN. Välj det nedan, så kommer programmet ihåg typnyckeln. Med bilen ansluten läses det automatiskt.</span>' : '');
  if (d.year) f.year.value = d.year;
  if (d.chassis) { f.chassis.value = d.chassis; f.chassis.onchange({ target: f.chassis }); if (d.model) f.model.value = d.model; }
};
$('#carForm').onsubmit = async e => {
  e.preventDefault();
  const saved = await call('save_car', formCar());
  await loadCars(saved.id); renderCarForm(); toast('✓ Bilen sparad');
};
$('#btnNewCar').onclick = () => renderCarForm({ body: 'sedan', paint_hex: '#3a4a5c', profile: null });
$('#btnDeleteCar').onclick = async () => {
  const c = formCar(); if (!c.id) return;
  if (S.cars.length < 2) { toast('Det måste finnas minst en bil'); return; }
  if (!await modal('Ta bort bil?', `<p><b>${esc(c.name)}</b> med alla servicer och bilagor tas bort permanent. Ta en backup först.</p>`, 'Ta bort')) return;
  await call('delete_car', c.id); S.car = null; await loadCars(); go('home');
};
$('#btnFindPhoto').onclick = async () => {
  const id = formCar().id; if (!id) { toast('Spara bilen först'); return; }
  await call('save_car', formCar());
  $('#photoResults').innerHTML = '<span class="muted">Söker bilder på Wikimedia Commons…</span>';
  try {
    const r = await call('find_car_photos', id);
    $('#photoResults').innerHTML = r.photos.map((p, i) => `<img src="${p.thumb}" data-i="${i}" title="${esc(p.title)} – ${esc(p.artist)} · ${esc(p.license)}">`).join('')
      + '<small class="muted" style="grid-column:1/-1">Klicka på en bild för att välja den. Bilderna är fritt licensierade från Wikimedia Commons.</small>';
    $$('#photoResults img').forEach(img => img.onclick = async () => {
      img.style.opacity = .4;
      await call('choose_car_photo', id, r.photos[Number(img.dataset.i)]);
      $('#photoResults').innerHTML = ''; await loadCars(id); renderCarForm(); toast('✓ Bild vald');
    });
  } catch (e) { $('#photoResults').innerHTML = ''; }
};
$('#btnPhoto').onclick = () => $('#photoInput').click();
$('#photoInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; const id = formCar().id;
  if (!id) { toast('Spara bilen först'); return; }
  await call('set_car_photo', id, f.name, await readFileB64(f)); e.target.value = '';
  await loadCars(id); renderCarForm(); toast('✓ Foto sparat');
};
$('#btnPhotoRemove').onclick = async () => {
  const id = formCar().id; if (!id) return;
  await call('set_car_photo', id, '', null); await loadCars(id); renderCarForm();
};
$('#cfgForm').onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  S.config = { ...S.config, ...(await call('save_config', { ediabas_dir: f.ediabas_dir.value, python32: f.python32.value })) }; toast('✓ Inställningar sparade');
};

// ---------------------------------------------------------------- tema
function applyTheme(t) { document.documentElement.classList.toggle('dark', t === 'dark'); localStorage.theme = t; }
$('#themeBtn').onclick = () => applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
applyTheme(localStorage.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ---------------------------------------------------------------- start
async function firstRunWeb() {
  // Ny telefon: hämta från Drive först, så att det inte blir en dubblettbil
  const cars = await api.list_cars();
  if (cars.length || S.drive.connected) return;
  const fromDrive = await modal('Välkommen till Servicebok',
    `<p>Har du redan en servicebok på datorn? Logga in på Google Drive så hämtas allt hit.</p>
     <p class="muted">Du kan också börja från början och koppla Drive senare under Synk & backup.</p>`, 'Hämta från Google Drive', 'Börja från början');
  if (fromDrive) {
    if (!S.config.google_web_client_id) { toast('Fyll först i Google webbklient-ID under Synk & backup'); return; }
    await api.drive_connect();
  }
}

let started = false;
async function start(backend) {
  if (started) return; started = true;
  api = backend;
  const init = await call('init');
  S.web = init.platform === 'web';
  document.body.classList.toggle('web', S.web);
  Object.assign(S, { lists: init.lists, types: init.service_types, statuses: init.statuses, config: init.config,
    lastBackup: init.last_backup });
  await renderDrive();
  if (S.web) {
    if (api._justLoggedIn) await runSync(false);
    else await firstRunWeb();
  }
  await loadCars();
  const st = await api.car_status(); setConn(st.connected, st.mock);
  go(api._justLoggedIn ? 'backup' : 'home');
  if (!S.web && S.drive.connected) runSync(false);
  else if (S.web && !api._justLoggedIn) scheduleSync(800);
  if (S.web && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Datorn: pywebview injicerar sitt API och skickar 'pywebviewready'. Annars: webb-/mobilläge.
window.addEventListener('pywebviewready', () => start(window.pywebview.api));
if (window.pywebview && window.pywebview.api && window.pywebview.api.init) start(window.pywebview.api);
setTimeout(() => { if (!started && !(window.pywebview && window.pywebview.api && window.pywebview.api.init)) start(window.WEBSTORE); },
  window.pywebview ? 5000 : 400);
