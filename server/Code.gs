/**
 * ГУМИ АВТОПАРК — сървърна част (Google Apps Script)
 *
 * Как се пуска:
 *  1. Създай нова Google таблица „Гуми Автопарк“ → Разширения → Apps Script.
 *  2. Изтрий всичко в Code.gs и постави този код. Запази.
 *  3. Избери функцията setup горе и натисни „Изпълни“ (разреши достъпа).
 *     В „Дневник на изпълнението“ ще видиш колко коли е намерил в пътната книжка и потребителя/паролата на администратора.
 *  4. Внедряване → Ново внедряване → Тип: Уеб приложение
 *     Изпълни като: Аз · Достъп: Всеки → Внедряване. Копирай адреса (завършва на /exec).
 *
 * Колите идват от пътната книжка (само четене). Тук се пазят гумите, рейсовете, историята и цените.
 */

const CFG_DEFAULTS = {
  ROAD_BOOK_ID: '1l_Xju6J_VVxXmePDyFSNDCE8BOYYVAVb29_YwJw46TA',   // таблицата на пътната книжка
  ROAD_BOOK_SHEET: 'Автомобили',                                    // листът с колите
  ROT_KM: 10000                                                      // ротация на гумите на всеки … км
};
const TZ = 'Europe/Sofia';

// листове в тази таблица и колоните им
const SH = {
  cfg: ['Настройки', ['Ключ', 'Стойност']],
  users: ['Потребители', ['Потребител', 'Име', 'Роля', 'Активен', 'Парола', 'Сол', 'Токен']],
  cars: ['Коли', ['Номер', 'Ръчна', 'Модел', 'Шофьор', 'Размер', 'Сервиз', 'Всесезонни', 'На колата', 'Км при смяна', 'Км ръчно', 'Премахната', 'Вид кола']],
  sets: ['Комплекти', ['Номер', 'Вид', 'Размер', 'Марка', 'DOT', 'Протектор', 'Джанти', 'Изминати км', 'Ротация при км', 'ПЛ', 'ПД', 'ЗЛ', 'ЗД']],
  free: ['Свободни', ['ID', 'Вид', 'Размер', 'Марка', 'DOT', 'Протектор', 'Джанти', 'Изминати км', 'Ротация при км', 'Гуми', 'От кола', 'Дата', 'Бележка']],
  trips: ['Рейсове', ['ID', 'Дата', 'Бус', 'Сервиз', 'Номер', 'Стъпка']],
  hist: ['История', ['ID', 'Дата', 'Номер', 'Вид', 'Текст', 'Сервиз', 'Км', 'Сума', 'Бележка']],
  svc: ['Сервизи', ['Сервиз', 'Монтаж и демонтаж €', 'Смяна с джанти €']],
  svcp: ['Цени по размер', ['Сервиз', 'Вид кола', 'Диаметър', 'Монтаж и демонтаж €', 'Смяна с джанти €']],
  bus: ['Бусове', ['Бус']],
  extra: ['Допълнителни услуги', ['Услуга']]
};
const TEXT_COLS = ['Номер', 'От кола', 'ID', 'Токен', 'Потребител', 'Парола', 'Сол', 'Дата', 'Премахната', 'DOT', 'Размер'];

const SETN = { summer: 'Летни', winter: 'Зимни', all: 'Всесезонни' };
const KIND = { 'Летни': 'summer', 'Зимни': 'winter', 'Всесезонни': 'all' };
const NEWD = { summer: 8, winter: 9, all: 8.5 };
const POS = ['ПЛ', 'ПД', 'ЗЛ', 'ЗД'];
const TST = { ok: 'Годна', worn: 'За смяна', scrap: 'Брак' };
const TSTK = { 'Годна': 'ok', 'За смяна': 'worn', 'Брак': 'scrap' };
const HTYPE = { change: 'Смяна', rotate: 'Ротация', scrap: 'Брак', buy: 'Покупка', repair: 'Ремонт', other: 'Друго', store: 'Склад' };
const HTYPEK = Object.keys(HTYPE).reduce((o, k) => { o[HTYPE[k]] = k; return o; }, {});
const BASE = { norims: 'Монтаж и демонтаж', rims: 'Смяна на гуми с джанти' };
const VTN = { car: 'Лека', suv: 'Джип', van: 'Бус' };
const VTK = { 'Лека': 'car', 'Лека кола': 'car', 'Джип': 'suv', 'Бус': 'van' };
const DIAMS = ['13', '14', '15', '16', '17', '18', '19', '20', '21', '22'];
const LAT = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };

let DB = null, TARGET = 'winter', ROAD_INFO = '', ROAD_DIAG = {};
const SERVER_VERSION = '8';
let RAW = null, RAW_DIRTY = false;   // копие на листовете в паметта на Google (кеш), за да не се чете таблицата при всяко действие
const SHEETS = {};

/* ---------- помощни ---------- */
const todayStr = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
const nid = () => Utilities.getUuid().replace(/-/g, '').slice(0, 10);
const numv = x => { const n = parseFloat(String(x == null ? '' : x).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const yes_ = v => v === true || /^(да|yes|true|1|x|✓)$/i.test(String(v == null ? '' : v).trim());
const kmFmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' км';
const eur = n => Number(n || 0).toFixed(2) + ' €';
const dstr_ = v => v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v == null ? '' : v).trim();
function normPlate_(p) { return String(p == null ? '' : p).toUpperCase().replace(/[\s\-.]/g, '').replace(/[ABCEHKMOPTXY]/g, ch => LAT[ch]); }
function fmtPlate_(id) { const m = String(id).match(/^([^\d]+)(\d+)([^\d]*)$/); return m ? [m[1], m[2], m[3]].filter(Boolean).join(' ') : String(id); }
function targetSeason_() { const m = +todayStr().slice(5, 7); return (m >= 9 || m <= 2) ? 'winter' : 'summer'; }
// DOT: годината (2022) или 4-те цифри от гумата (2322 = 23-та седмица на 2022)
function dotYear_(x) {
  const d = String(x == null ? '' : x).replace(/\D/g, '');
  if (!d) return '';
  const y = +todayStr().slice(0, 4);
  if (d.length === 4 && +d >= 1990 && +d <= y) return d;
  if (d.length === 4 || d.length === 3) { const yy = 2000 + +d.slice(-2); if (yy <= y + 1) return String(yy); }
  if (d.length === 2) return String(2000 + +d);
  throw new Error('DOT: напиши годината (напр. 2022) или 4-те цифри от гумата (напр. 2322)');
}
function token_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }

const kinds = c => c.allSeason ? ['all'] : ['winter', 'summer'];
const other = s => s === 'summer' ? 'winter' : 'summer';
const carById = id => DB.cars.find(c => c.id === id);
const tripOf = id => DB.trips.find(t => t.items.some(x => x.carId === id && x.step < 3));
const itemOf = id => { const t = tripOf(id); return t ? t.items.find(x => x.carId === id) : null; };
const have = s => s ? s.tires.filter(t => t !== 'scrap').length : 0;
const kmOf = (c, k) => { const s = c.sets[k]; if (!s) return 0; return (s.kmRun || 0) + (c.mounted === k ? Math.max(0, (c.odo || c.km) - c.km) : 0); };
function toFree(c, k, note) {
  const s = c.sets[k]; if (!s || !have(s)) return;
  DB.free.push({ id: nid(), k, size: s.size || c.size, brand: s.brand, dot: s.dot, tread: s.tread, rims: !!s.rims, kmRun: kmOf(c, k), rotAt: s.rotAt || 0, tires: s.tires.filter(t => t !== 'scrap'), from: c.plate, date: todayStr(), note });
}
function hist_(c, o) { DB.history.push(Object.assign({ id: nid(), carId: c.id, date: todayStr(), type: 'other', text: '', service: '', km: '', cost: '', note: '' }, o)); }

/* ---------- кеш: данните стоят в паметта на Google до 6 часа ---------- */
const CACHE_TTL = 21600, CHUNK = 30000;
function cacheLoad_() {
  try {
    const c = CacheService.getScriptCache(), n = +c.get('raw_n');
    if (!n) return null;
    const keys = []; for (let i = 0; i < n; i++) keys.push('raw_' + i);
    const m = c.getAll(keys); let str = '';
    for (let i = 0; i < keys.length; i++) { if (m[keys[i]] == null) return null; str += m[keys[i]]; }
    return JSON.parse(str);
  } catch (e) { return null; }
}
function cacheSave_() {
  try {
    const str = JSON.stringify(RAW), parts = {}; let i = 0;
    for (let p = 0; p < str.length; p += CHUNK) parts['raw_' + (i++)] = str.slice(p, p + CHUNK);
    parts.raw_n = String(i);
    CacheService.getScriptCache().putAll(parts, CACHE_TTL);
  } catch (e) { cacheDrop_(); }
}
function cacheDrop_() { try { CacheService.getScriptCache().removeAll(['raw_n', 'road']); } catch (e) {} }
// ръчна промяна в таблицата → кешът се изчиства и следващото отваряне чете таблицата наново
function onEdit() { cacheDrop_(); }

/* ---------- листове ---------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(key) {
  if (SHEETS[key]) return SHEETS[key];
  const name = SH[key][0], head = SH[key][1];
  let sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#c6f432');
    sh.setFrozenRows(1);
  } else {   // нова колона в по-нова версия: дописва заглавието само ако старите колони са същите
    const n = sh.getLastColumn();
    if (n && n < head.length && sh.getRange(1, 1, 1, n).getValues()[0].every((h, i) => String(h).trim() === head[i]))
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#c6f432');
  }
  return (SHEETS[key] = sh);
}
function read_(key) {
  if (RAW && RAW[key]) return RAW[key];
  const sh = sheet_(key), head = SH[key][1], n = sh.getLastRow();
  const rows = n < 2 ? [] : sh.getRange(2, 1, n - 1, head.length).getValues()
    .filter(r => r.some(x => x !== '' && x !== null))
    .map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] instanceof Date ? dstr_(r[i]) : r[i]; }); return o; });
  if (RAW) { RAW[key] = rows; RAW_DIRTY = true; }
  return rows;
}
// записва само данните: един запис, без изтриване отделно (празните редове отдолу се попълват с празно)
function write_(key, rows) {
  const sh = sheet_(key), head = SH[key][1];
  const oldN = RAW && RAW[key] ? RAW[key].length : Math.max(0, sh.getLastRow() - 1);
  const total = Math.max(oldN, rows.length);
  const fmt = RAW ? (RAW.__fmt = RAW.__fmt || {}) : {};
  if (rows.length > (fmt[key] || 0)) {
    const upTo = rows.length + 300;
    head.forEach((h, i) => { if (TEXT_COLS.indexOf(h) >= 0) sh.getRange(2, i + 1, upTo, 1).setNumberFormat('@'); });
    fmt[key] = upTo;
  }
  if (total) {
    const vals = rows.map(o => head.map(h => o[h] == null ? '' : o[h]));
    while (vals.length < total) vals.push(head.map(() => ''));
    sh.getRange(2, 1, total, head.length).setValues(vals);
  }
  if (RAW) { RAW[key] = rows.map(o => { const x = {}; head.forEach(h => { x[h] = o[h] == null ? '' : o[h]; }); return x; }); RAW_DIRTY = true; }
}
function cfg_() {
  const o = Object.assign({}, CFG_DEFAULTS);
  read_('cfg').forEach(r => { if (r['Ключ']) o[String(r['Ключ']).trim()] = r['Стойност']; });
  return o;
}

/* ---------- пътната книжка (само четене) ---------- */
function roadCars_(cfg, fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const c = cache.get('road'); if (c) { const o = JSON.parse(c); ROAD_DIAG = o.diag || {}; return o.list || []; } }
  let sh;
  try { sh = SpreadsheetApp.openById(String(cfg.ROAD_BOOK_ID).trim()).getSheetByName(String(cfg.ROAD_BOOK_SHEET).trim()); }
  catch (e) { throw new Error('Не мога да отворя пътната книжка. Провери ROAD_BOOK_ID в лист „Настройки“ и дали акаунтът има достъп до нея.'); }
  if (!sh) throw new Error('В пътната книжка няма лист „' + cfg.ROAD_BOOK_SHEET + '“. Провери ROAD_BOOK_SHEET в лист „Настройки“.');
  const v = sh.getDataRange().getValues();
  const head = v[0].map(h => String(h).toLowerCase().trim());
  const col = keys => { for (let i = 0; i < keys.length; i++) { const j = head.findIndex(h => h.indexOf(keys[i]) >= 0); if (j >= 0) return j; } return -1; };
  // колоната с номерата: от всички колони с „рег“ или „номер“ в заглавието избираме тази с най-много различни номера
  const plateLike = x => { const n = normPlate_(x); return n.length >= 4 && /\d/.test(n) && /[^\d]/.test(n); };
  let iP = -1, bestN = 0;
  head.forEach((h, j) => {
    if (!/рег|номер|№/.test(h)) return;
    const set = {}; for (let r = 1; r < v.length; r++) if (plateLike(v[r][j])) set[normPlate_(v[r][j])] = 1;
    const n = Object.keys(set).length; if (n > bestN) { bestN = n; iP = j; }
  });
  const iB = col(['марка']), iM = col(['модел']), iD = col(['шофьор', 'водач']), iK = col(['километраж', 'пробег']);
  let iA = col(['активен', 'активна']);

  if (iP < 0) throw new Error('В пътната книжка не намерих колона с регистрационни номера.');
  ROAD_INFO = 'номер: колона ' + String.fromCharCode(65 + iP) + ' „' + v[0][iP] + '“ (' + bestN + ' номера)' + (iK >= 0 ? ', км: колона ' + String.fromCharCode(65 + iK) : ', без колона за км') + (iA >= 0 ? ', скрити са само колите с „не“ в колона ' + String.fromCharCode(65 + iA) : '');
  const by = {};
  for (let r = 1; r < v.length; r++) {
    const row = v[r], id = normPlate_(row[iP]);
    if (!id || !plateLike(row[iP])) continue;
    const act = iA < 0 ? '' : row[iA];
    // скрива се само ако изрично пише „не“ / „неактивна“; отметките (TRUE/FALSE) и празното не се броят
    if (typeof act === 'string' && /^(не|no|неактивен|неактивна|спряна|продадена)$/i.test(act.trim())) continue;
    const brand = iB < 0 ? '' : String(row[iB]).trim(), model = iM < 0 ? '' : String(row[iM]).trim();
    const rec = { id, model: (brand + ' ' + model).trim(), driver: iD < 0 ? '' : String(row[iD]).trim(), km: iK < 0 ? 0 : numv(row[iK]) };
    const prev = by[id];
    if (!prev) by[id] = rec;
    else {   // повтарящ се номер: пазим реда с повече км, а празните полета ги допълваме
      const best = rec.km > prev.km ? rec : prev, rest = best === rec ? prev : rec;
      if (!best.driver) best.driver = rest.driver;
      if (!best.model) best.model = rest.model;
      by[id] = best;
    }
  }
  const list = Object.keys(by).map(k => by[k]);
  // проверка: какво е прочетено (показва се на администратора в таб „Коли“)
  const av = {};
  if (iA >= 0) v.slice(1).forEach(r => { if (!normPlate_(r[iP])) return; const k = r[iA] === '' || r[iA] == null ? '(празно)' : String(r[iA]); av[k] = (av[k] || 0) + 1; });
  ROAD_DIAG = { sheet: sh.getName(), rows: v.length - 1, withPlate: v.slice(1).filter(r => plateLike(r[iP])).length, cars: list.length,
    plateCol: String.fromCharCode(65 + iP) + ' „' + v[0][iP] + '“', kmCol: iK >= 0 ? String.fromCharCode(65 + iK) : '', activeCol: iA >= 0 ? String.fromCharCode(65 + iA) : '', activeVals: av };
  cache.put('road', JSON.stringify({ list, diag: ROAD_DIAG }), 7200);
  return list;
}

/* ---------- зареждане и запис ---------- */
function rowToSet_(r) {
  return { size: String(r['Размер'] || '').trim(), brand: String(r['Марка'] || '').trim() || '—', dot: String(r['DOT'] || '').trim(), tread: numv(r['Протектор']),
    rims: yes_(r['Джанти']), kmRun: numv(r['Изминати км']), rotAt: numv(r['Ротация при км']), tires: POS.map(p => TSTK[String(r[p] || '').trim()] || 'ok') };
}
function makeCar_(id, r, sets, rc, services) {
  const all = yes_(r['Всесезонни']), st = {};
  (all ? ['all'] : ['winter', 'summer']).forEach(k => { st[k] = sets && sets[k] ? sets[k] : null; });
  const km = numv(r['Км при смяна']), man = numv(r['Км ръчно']), road = rc ? rc.km : 0;
  const odo = Math.max(road, man, km);
  return {
    id, plate: fmtPlate_(id), manual: !rc,
    model: rc ? (rc.model || r['Модел'] || '—') : (String(r['Модел'] || '') || '—'),
    driver: rc ? (rc.driver || '—') : (String(r['Шофьор'] || '') || '—'),
    size: String(r['Размер'] || '').trim(), service: services.indexOf(r['Сервиз']) >= 0 ? r['Сервиз'] : (services[0] || ''),
    allSeason: all, mounted: all ? 'all' : (KIND[r['На колата']] === 'winter' ? 'winter' : 'summer'),
    km: km || odo, odo, roadKm: road, manOdo: man, sets: st, vtype: VTK[String(r['Вид кола'] || '').trim()] || ''
  };
}
function load_(fresh) {
  const cfg = cfg_();
  TARGET = targetSeason_();
  const road = roadCars_(cfg, fresh);
  if (!road.length) throw new Error('Не намерих нито една активна кола в пътната книжка.');
  const svcRows = read_('svc');
  const services = svcRows.map(r => String(r['Сервиз']).trim()).filter(Boolean);
  const prices = {};
  svcRows.forEach(r => { const n = String(r['Сервиз']).trim(); if (n) prices[n] = { norims: numv(r['Монтаж и демонтаж €']), rims: numv(r['Смяна с джанти €']), grid: {} }; });
  read_('svcp').forEach(r => {
    const P = prices[String(r['Сервиз']).trim()], t = VTK[String(r['Вид кола']).trim()], d = String(r['Диаметър']).replace(/\D/g, '');
    if (P && t && d) ((P.grid[t] = P.grid[t] || {})[d] = { norims: numv(r['Монтаж и демонтаж €']), rims: numv(r['Смяна с джанти €']) });
  });
  const D = {
    cars: [], services, prices, removedRows: [], removedNow: [], target: TARGET, rotKm: numv(cfg.ROT_KM) || 10000,
    buses: read_('bus').map(r => String(r['Бус']).trim()).filter(Boolean),
    extras: read_('extra').map(r => String(r['Услуга']).trim()).filter(Boolean)
  };
  const carRows = read_('cars'), rowBy = {}, setsBy = {}, seen = {};
  carRows.forEach(r => { const id = normPlate_(r['Номер']); if (id) rowBy[id] = r; });
  read_('sets').forEach(r => { const id = normPlate_(r['Номер']), k = KIND[r['Вид']]; if (id && k) (setsBy[id] = setsBy[id] || {})[k] = rowToSet_(r); });
  road.forEach(rc => { seen[rc.id] = 1; D.cars.push(makeCar_(rc.id, rowBy[rc.id] || {}, setsBy[rc.id], rc, services)); });
  carRows.forEach(r => {
    const id = normPlate_(r['Номер']);
    if (!id || seen[id]) return;
    seen[id] = 1;
    if (r['Премахната']) { D.removedRows.push(r); return; }
    const c = makeCar_(id, r, setsBy[id], null, services);
    if (yes_(r['Ръчна'])) D.cars.push(c); else D.removedNow.push(c);   // беше в пътната книжка, вече я няма там
  });
  D.free = read_('free').map(r => ({
    id: String(r['ID']), k: KIND[r['Вид']] || 'summer', size: String(r['Размер'] || '').trim(), brand: String(r['Марка'] || '') || '—', dot: String(r['DOT'] || ''),
    tread: numv(r['Протектор']), rims: yes_(r['Джанти']), kmRun: numv(r['Изминати км']), rotAt: numv(r['Ротация при км']),
    tires: String(r['Гуми'] || '').split(',').map(x => TSTK[x.trim()]).filter(Boolean), from: String(r['От кола'] || ''), date: dstr_(r['Дата']), note: String(r['Бележка'] || '')
  })).filter(f => f.tires.length);
  D.history = read_('hist').map(r => ({
    id: String(r['ID']), date: dstr_(r['Дата']), carId: normPlate_(r['Номер']), type: HTYPEK[r['Вид']] || 'other', text: String(r['Текст'] || ''),
    service: String(r['Сервиз'] || ''), km: r['Км'] === '' ? '' : numv(r['Км']), cost: r['Сума'] === '' ? '' : numv(r['Сума']), note: String(r['Бележка'] || '')
  }));
  const tmap = {}, ids = {};
  D.cars.forEach(c => { ids[c.id] = 1; });
  D.trips = [];
  read_('trips').forEach(r => {
    const id = String(r['ID']), carId = normPlate_(r['Номер']);
    if (!ids[carId]) return;
    let t = tmap[id];
    if (!t) { t = tmap[id] = { id, date: dstr_(r['Дата']), bus: String(r['Бус']), service: String(r['Сервиз']), items: [] }; D.trips.push(t); }
    t.items.push({ carId, step: numv(r['Стъпка']) });
  });
  return D;
}
function carRow_(c, removed) {
  return { 'Номер': c.plate, 'Ръчна': c.manual ? 'да' : '', 'Модел': c.model, 'Шофьор': c.driver, 'Размер': c.size, 'Сервиз': c.service,
    'Всесезонни': c.allSeason ? 'да' : '', 'На колата': SETN[c.mounted], 'Км при смяна': c.km || '', 'Км ръчно': c.manOdo || '', 'Премахната': removed || '', 'Вид кола': VTN[c.vtype] || '' };
}
function rowsAll_(D) {
  const sets = [];
  D.cars.forEach(c => Object.keys(c.sets).forEach(k => {
    const s = c.sets[k]; if (!s) return;
    const o = { 'Номер': c.plate, 'Вид': SETN[k], 'Размер': s.size || c.size, 'Марка': s.brand, 'DOT': s.dot, 'Протектор': s.tread, 'Джанти': s.rims ? 'да' : 'не',
      'Изминати км': Math.round(s.kmRun || 0), 'Ротация при км': Math.round(s.rotAt || 0) };
    POS.forEach((p, i) => { o[p] = TST[s.tires[i]]; });
    sets.push(o);
  }));
  const plateOf = id => { const c = D.cars.find(x => x.id === id); return c ? c.plate : fmtPlate_(id); };
  const trips = [];
  const old = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);   // приключени рейсове по-стари от 90 дни не се пазят
  D.trips.filter(t => t.items.length && !(t.items.every(x => x.step === 3) && t.date < old))
    .forEach(t => t.items.forEach(it => trips.push({ 'ID': t.id, 'Дата': t.date, 'Бус': t.bus, 'Сервиз': t.service, 'Номер': plateOf(it.carId), 'Стъпка': it.step })));
  const out = {
    cars: D.cars.map(c => carRow_(c)).concat(D.removedRows),
    sets,
    free: D.free.map(f => ({ 'ID': f.id, 'Вид': SETN[f.k], 'Размер': f.size, 'Марка': f.brand, 'DOT': f.dot, 'Протектор': f.tread, 'Джанти': f.rims ? 'да' : 'не',
      'Изминати км': Math.round(f.kmRun || 0), 'Ротация при км': Math.round(f.rotAt || 0), 'Гуми': f.tires.map(t => TST[t]).join(', '), 'От кола': f.from, 'Дата': f.date, 'Бележка': f.note })),
    trips,
    hist: D.history.map(h => ({ 'ID': h.id, 'Дата': h.date, 'Номер': plateOf(h.carId), 'Вид': HTYPE[h.type] || 'Друго', 'Текст': h.text, 'Сервиз': h.service, 'Км': h.km, 'Сума': h.cost, 'Бележка': h.note || '' })),
    svc: D.services.map(n => ({ 'Сервиз': n, 'Монтаж и демонтаж €': (D.prices[n] || {}).norims || 0, 'Смяна с джанти €': (D.prices[n] || {}).rims || 0 })),
    svcp: gridRows_(D),
    bus: D.buses.map(b => ({ 'Бус': b })),
    extra: D.extras.map(x => ({ 'Услуга': x }))
  };
  const json = {};
  Object.keys(out).forEach(k => { json[k] = JSON.stringify(out[k]); });
  return json;
}
function gridRows_(D) {
  const out = [];
  D.services.forEach(n => { const g = (D.prices[n] || {}).grid || {};
    ['car', 'suv', 'van'].forEach(t => DIAMS.forEach(d => { const x = (g[t] || {})[d];
      if (x && (x.norims || x.rims)) out.push({ 'Сервиз': n, 'Вид кола': VTN[t], 'Диаметър': 'R' + d, 'Монтаж и демонтаж €': x.norims || '', 'Смяна с джанти €': x.rims || '' }); })); });
  return out;
}
function cleanGrid_(g) {
  const out = {};
  ['car', 'suv', 'van'].forEach(t => DIAMS.forEach(d => { const x = ((g || {})[t] || {})[d]; if (!x) return;
    const o = { norims: numv(x.norims), rims: numv(x.rims) }; if (o.norims || o.rims) (out[t] = out[t] || {})[d] = o; }));
  return out;
}
// коли, които вече ги няма в пътната книжка: гумите им отиват в свободни
function processRemoved_() {
  DB.removedNow.forEach(c => {
    DB.cars.push(c);   // временно, за да се запише историята с правилния номер
    kinds(c).forEach(k => toFree(c, k, 'Колата не е активна в пътната книжка'));
    hist_(c, { text: 'Колата вече я няма в пътната книжка — гумите ѝ са в свободни' });
    DB.trips.forEach(t => { t.items = t.items.filter(x => x.carId !== c.id); });
    DB.cars = DB.cars.filter(x => x !== c);
    DB.removedRows.push(carRow_(c, todayStr()));
  });
  DB.removedNow = [];
}
function public_() {
  const D = DB;
  return { cars: D.cars, history: D.history, trips: D.trips, services: D.services, buses: D.buses, extras: D.extras, prices: D.prices, free: D.free, target: D.target, rotKm: D.rotKm, today: todayStr(), version: SERVER_VERSION, road: ROAD_DIAG };
}

/* ---------- потребители и вход ---------- */
const ROLEN = { admin: 'Администратор', staff: 'Служител', driver: 'Шофьор' };
const roleK_ = v => /админ|admin/i.test(String(v)) ? 'admin' : /служ|staff/i.test(String(v)) ? 'staff' : 'driver';
function authErr_(m) { const e = new Error(m); e.auth = true; return e; }
function hash_(salt, pass) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pass, Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}
// чете листа по заглавията му, така че и старият вид (само с токен) работи
function usersList_() {
  if (RAW && RAW.__users) return JSON.parse(JSON.stringify(RAW.__users));
  const v = sheet_('users').getDataRange().getValues();
  if (v.length < 2) return [];
  const H = v[0].map(h => String(h).trim()), g = (r, h) => { const i = H.indexOf(h); return i < 0 ? '' : r[i]; };
  const L = v.slice(1).filter(r => r.some(x => x !== '' && x != null)).map(r => ({
    username: String(g(r, 'Потребител') || '').trim(), name: String(g(r, 'Име') || ''), role: roleK_(g(r, 'Роля')),
    active: !/^(не|no|false)$/i.test(String(g(r, 'Активен')).trim()), hash: String(g(r, 'Парола') || ''), salt: String(g(r, 'Сол') || ''), token: String(g(r, 'Токен') || '')
  }));
  if (RAW) { RAW.__users = JSON.parse(JSON.stringify(L)); RAW_DIRTY = true; }
  return L;
}
function usersWrite_(L) {
  const head = SH.users[1];
  sheet_('users').getRange(1, 1, 1, head.length).setValues([head]);
  write_('users', L.map(u => ({ 'Потребител': u.username, 'Име': u.name, 'Роля': ROLEN[u.role], 'Активен': u.active ? 'да' : 'не', 'Парола': u.hash, 'Сол': u.salt, 'Токен': u.token })));
  cacheDrop_(); RAW = null;   // потребителите се сменят рядко: следващото отваряне чете таблицата наново
}
const userOut_ = u => ({ id: u.token, username: u.username, name: u.name, role: u.role, active: u.active, hasPass: !!u.hash });
function auth_(t) {
  const u = t ? usersList_().find(x => x.token && x.token === String(t).trim()) : null;
  if (!u || !u.active) throw authErr_('Влез отново с потребителско име и парола.');
  return u;
}
function setPass_(u, pass) {
  if (String(pass || '').length < 4) throw new Error('Паролата трябва да е поне 4 знака');
  u.salt = token_(); u.hash = hash_(u.salt, String(pass)); u.token = token_();
}
function login_(d) {
  const name = String(d.username || '').trim().toLowerCase();
  const u = usersList_().find(x => x.username && x.username.toLowerCase() === name);
  if (!u || !u.active || !u.hash || hash_(u.salt, String(d.password || '')) !== u.hash) { Utilities.sleep(800); throw new Error('Грешно потребителско име или парола'); }
  return { token: u.token };
}
const DRIVER_OK = { advance: 1, change: 1 };
const STAFF_NO = { saveSettings: 1, setPrices: 1 };

/* ---------- действия ---------- */
const ACT = {
  advance(b) {
    const t = DB.trips.find(x => x.id === b.tripId); if (!t) throw new Error('Няма такъв рейс');
    const it = t.items.find(x => x.carId === b.carId); if (!it) throw new Error('Колата не е в рейса');
    if (it.step === 1) throw new Error('За смяната попълни формата');
    if (it.step < 3) it.step++;
    if (it.step === 3) hist_(carById(it.carId), { type: 'store', text: SETN[other(TARGET)] + ' прибрани в склада' });
    return true;
  },
  change(b) {
    const c = carById(b.carId); if (!c) throw new Error('Избери кола');
    if (c.allSeason) throw new Error('Колата е с всесезонни гуми');
    const put = other(c.mounted);
    if (!c.sets[put]) throw new Error('Колата няма ' + SETN[put].toLowerCase() + ' гуми');
    const km = numv(b.km) || c.odo || c.km;
    if (b.treadOn) c.sets[put].tread = numv(b.treadOn);
    if (b.treadOff && c.sets[c.mounted]) c.sets[c.mounted].tread = numv(b.treadOff);
    const driven = km - c.km;
    if (driven > 0 && c.sets[c.mounted]) c.sets[c.mounted].kmRun = (c.sets[c.mounted].kmRun || 0) + driven;
    const cost = b.cost !== '' && b.cost != null ? numv(b.cost) : '';
    const bill = [b.base ? BASE[b.base] + (b.sizeNote ? ' (' + String(b.sizeNote).slice(0, 40) + ')' : '') : '', (b.extras || []).length ? 'допълнително: ' + b.extras.join(', ') : ''].filter(Boolean).join(' · ');
    hist_(c, { date: b.date || todayStr(), type: 'change', text: SETN[c.mounted] + ' → ' + SETN[put].toLowerCase(), service: b.service || c.service, km: km || '', cost, note: [bill, b.note].filter(Boolean).join(' · ') });
    c.mounted = put;
    if (km) { c.km = km; c.odo = Math.max(c.odo || 0, km); if (!c.roadKm) c.manOdo = Math.max(c.manOdo || 0, km); }
    if (b.rotate) {
      const st = c.sets[put]; st.rotAt = st.kmRun || 0; st.tires = [st.tires[2], st.tires[3], st.tires[0], st.tires[1]];
      hist_(c, { date: b.date || todayStr(), type: 'rotate', text: 'Ротация ' + SETN[put].toLowerCase() + ' при монтажа', service: b.service || c.service });
    }
    const it = itemOf(c.id); if (it && it.step < 2) it.step = 2;
    return true;
  },
  newTrip(b) {
    if (!b.cars || !b.cars.length) throw new Error('Избери поне една кола');
    const t = { id: nid(), date: b.date || todayStr(), bus: b.bus, service: b.service, items: b.cars.filter(id => carById(id)).map(id => ({ carId: id, step: 0 })) };
    DB.trips.push(t); return t.id;
  },
  addToTrip(b) {
    const t = DB.trips.find(x => x.id === b.tripId); if (!t) throw new Error('Няма такъв рейс');
    const ids = (b.cars || []).filter(id => carById(id) && !tripOf(id));
    if (!ids.length) throw new Error('Избери поне една кола');
    ids.forEach(id => t.items.push({ carId: id, step: 0 }));
    return ids.length;
  },
  cycleTire(b) {
    const c = carById(b.carId), s = c && c.sets[b.k]; if (!s) throw new Error('Няма такъв комплект');
    const nx = { ok: 'worn', worn: 'scrap', scrap: 'ok' }[s.tires[b.i]];
    s.tires[b.i] = nx;
    if (nx === 'scrap') hist_(c, { type: 'scrap', text: SETN[b.k] + ' ' + POS[b.i] + ' — брак' });
    return nx;
  },
  newTires(b) {
    const c = carById(b.carId); if (!c) throw new Error('Няма такава кола');
    const n = Math.max(1, Math.min(4, parseInt(b.count, 10) || 0));
    if (b.size && !c.size) c.size = String(b.size).trim();
    let s = c.sets[b.k];
    if (b.dot) b.dot = dotYear_(b.dot);
    if (!s) s = c.sets[b.k] = { size: b.size || c.size, brand: b.brand || '—', dot: b.dot || '', tread: NEWD[b.k], rims: !!b.rims, kmRun: 0, rotAt: 0, tires: ['scrap', 'scrap', 'scrap', 'scrap'] };
    let left = n;
    ['scrap', 'worn'].forEach(st => s.tires.forEach((t, i) => { if (left && t === st) { s.tires[i] = 'ok'; left--; } }));
    if (n === 4) { s.tread = b.tread ? numv(b.tread) : NEWD[b.k]; s.kmRun = numv(b.kmRun); s.rotAt = s.kmRun; s.rims = !!b.rims; if (b.brand) s.brand = b.brand; if (b.dot) s.dot = b.dot; if (b.size) s.size = b.size; }
    hist_(c, { date: b.date || todayStr(), type: 'buy', text: (b.existing ? 'Въведени ' : 'Нови ') + SETN[b.k].toLowerCase() + ' × ' + n + (b.brand ? ' · ' + b.brand : ''), cost: b.cost ? numv(b.cost) : '' });
    return true;
  },
  removeCar(b) {
    const c = carById(b.carId); if (!c) throw new Error('Няма такава кола');
    if (!c.manual) throw new Error('Колата е от пътната книжка — махни я там.');
    kinds(c).forEach(k => toFree(c, k, 'Колата е премахната'));
    hist_(c, { text: 'Колата е премахната — гумите ѝ са в свободни' });
    DB.trips.forEach(t => { t.items = t.items.filter(x => x.carId !== c.id); });
    DB.cars = DB.cars.filter(x => x.id !== c.id);
    DB.removedRows.push(carRow_(c, todayStr()));
    return true;
  },
  addFree(b) {
    const n = Math.max(1, Math.min(4, parseInt(b.count, 10) || 0));
    if (!b.size) throw new Error('Въведи размера');
    if (b.dot) b.dot = dotYear_(b.dot);
    const k = SETN[b.k] ? b.k : 'summer';
    DB.free.push({ id: nid(), k, size: String(b.size).trim(), brand: b.brand || '—', dot: b.dot || '', tread: b.tread ? numv(b.tread) : NEWD[k], rims: !!b.rims, kmRun: numv(b.kmRun), rotAt: numv(b.kmRun), tires: Array(n).fill('ok'), from: '', date: todayStr(), note: b.note || '' });
    return true;
  },
  dropFree(b) { DB.free = DB.free.filter(f => f.id !== b.id); return true; },
  assignFree(b) {
    const f = DB.free.find(x => x.id === b.id), c = carById(b.carId);
    if (!f || !c) throw new Error('Липсват данни');
    if (kinds(c).indexOf(f.k) < 0) throw new Error('Колата не ползва ' + SETN[f.k].toLowerCase() + ' гуми');
    const s = c.sets[f.k], src = f.from ? ' (от ' + f.from + ')' : '';
    if (b.mode === 'fill' && s) {
      let avail = f.tires.length, used = 0;
      ['scrap', 'worn'].forEach(st => s.tires.forEach((t, i) => { if (avail && t === st) { s.tires[i] = 'ok'; avail--; used++; } }));
      f.tires = f.tires.slice(used);
      if (!f.tires.length) DB.free = DB.free.filter(x => x.id !== f.id);
      hist_(c, { type: 'buy', text: 'Допълнени ' + SETN[f.k].toLowerCase() + ' × ' + used + ' от свободни' + src });
      return used;
    }
    toFree(c, f.k, 'Сменени със свободен комплект');
    const tires = f.tires.slice(0, 4); while (tires.length < 4) tires.push('scrap');
    c.sets[f.k] = { size: f.size, brand: f.brand, dot: f.dot, tread: f.tread, rims: !!f.rims, kmRun: f.kmRun || 0, rotAt: f.rotAt || f.kmRun || 0, tires };
    if (!c.size) c.size = f.size;
    DB.free = DB.free.filter(x => x.id !== f.id);
    hist_(c, { type: 'buy', text: 'Сложени свободни ' + SETN[f.k].toLowerCase() + ' × ' + f.tires.length + src });
    return f.tires.length;
  },
  addCar(b) {
    const id = normPlate_(b.plate);
    if (!id) throw new Error('Въведи номера');
    if (carById(id)) throw new Error('Вече има кола с номер ' + fmtPlate_(id));
    if (!b.size) throw new Error('Въведи размера на гумите');
    DB.removedRows = DB.removedRows.filter(r => normPlate_(r['Номер']) !== id);
    const km = numv(b.km), all = !!b.allSeason;
    const c = { id, plate: fmtPlate_(id), manual: true, model: b.model || '—', driver: b.driver || '—', size: String(b.size).trim(), service: b.service || DB.services[0] || '',
      allSeason: all, mounted: all ? 'all' : 'summer', km, odo: km, roadKm: 0, manOdo: km, sets: all ? { all: null } : { winter: null, summer: null } };
    DB.cars.push(c);
    hist_(c, { text: 'Колата е добавена ръчно', km: km || '' });
    return c.id;
  },
  editCar(b) {
    const c = carById(b.carId); if (!c) throw new Error('Няма такава кола');
    if (b.size != null) c.size = String(b.size).trim();
    if (b.service && DB.services.indexOf(b.service) >= 0) c.service = b.service;
    if (b.vtype != null) c.vtype = VTN[b.vtype] ? b.vtype : '';
    if (!c.allSeason && (b.mounted === 'winter' || b.mounted === 'summer')) c.mounted = b.mounted;
    if (c.manual) { if (b.model != null) c.model = String(b.model).trim() || '—'; if (b.driver != null) c.driver = String(b.driver).trim() || '—'; }
    return true;
  },
  editCars(b) {
    if (DB.services.indexOf(b.service) < 0) throw new Error('Няма такъв сервиз');
    let n = 0;
    (b.ids || []).forEach(id => { const c = carById(id); if (c && c.service !== b.service) { c.service = b.service; n++; } });
    return n;
  },
  updateKm(b) {
    const c = carById(b.carId), km = numv(b.km);
    if (!c) throw new Error('Няма такава кола');
    if (!km || km < c.km) throw new Error('Км не може да са по-малко от ' + kmFmt(c.km));
    c.odo = km; c.manOdo = km; return true;
  },
  rotate(b) {
    const c = carById(b.carId), s = c && c.sets[b.k]; if (!s) throw new Error('Няма такъв комплект');
    s.rotAt = kmOf(c, b.k);
    s.tires = [s.tires[2], s.tires[3], s.tires[0], s.tires[1]];
    hist_(c, { type: 'rotate', text: 'Ротация ' + SETN[b.k].toLowerCase() + ' (предни ↔ задни) · ' + kmFmt(s.rotAt) + ' с комплекта', km: c.odo || '' });
    return true;
  },
  editSet(b) {
    const c = carById(b.carId), s = c && c.sets[b.k]; if (!s) throw new Error('Няма такъв комплект');
    if (String(b.size || '').trim()) s.size = String(b.size).trim();
    if (b.brand != null) s.brand = String(b.brand).trim() || '—';
    if (b.dot != null) s.dot = dotYear_(b.dot);
    if (b.tread !== '' && b.tread != null) s.tread = numv(b.tread);
    if (b.kmRun !== '' && b.kmRun != null) { const old = s.kmRun || 0; s.kmRun = numv(b.kmRun); s.rotAt = Math.max(0, (s.rotAt || 0) + (s.kmRun - old)); }
    return true;
  },
  toggleRims(b) { const c = carById(b.carId), s = c && c.sets[b.k]; if (!s) throw new Error('Няма такъв комплект'); s.rims = !s.rims; return s.rims; },
  setAllSeason(b) {
    const c = carById(b.carId); if (!c) throw new Error('Няма такава кола');
    if (!!c.allSeason === !!b.on) return true;
    kinds(c).forEach(k => toFree(c, k, b.on ? 'Колата мина на всесезонни' : 'Колата мина на сезонни гуми'));
    DB.trips.forEach(t => { t.items = t.items.filter(x => x.carId !== c.id); });
    c.allSeason = !!b.on;
    c.sets = b.on ? { all: null } : { winter: null, summer: null };
    c.mounted = b.on ? 'all' : 'summer';
    hist_(c, { text: b.on ? 'Минава на всесезонни гуми' : 'Минава на летни + зимни гуми' });
    return true;
  },
  setPrices(b) {
    if (DB.services.indexOf(b.service) < 0) throw new Error('Няма такъв сервиз');
    const P = DB.prices[b.service] = DB.prices[b.service] || { norims: 0, rims: 0, grid: {} };
    P.grid = P.grid || {};
    const d = String(b.diam || '').replace(/\D/g, '');
    if (VTN[b.vtype] && DIAMS.indexOf(d) >= 0) {   // цена за този размер и вид кола
      const g = P.grid[b.vtype] = P.grid[b.vtype] || {};
      g[d] = { norims: numv(b.norims), rims: numv(b.rims) };
      if (!g[d].norims && !g[d].rims) delete g[d];
    } else { P.norims = numv(b.norims); P.rims = numv(b.rims); }
    return true;
  },
  saveSettings(b) {
    const clean = L => (L || []).map(x => ({ old: x.old, name: String(x.name || '').trim() })).filter(x => x.name);
    const sv = clean(b.services), bs = clean(b.buses);
    if (!sv.length) throw new Error('Трябва поне един сервиз');
    if (!bs.length) throw new Error('Трябва поне един бус');
    const dup = L => L.some((x, i) => L.findIndex(y => y.name === x.name) !== i);
    if (dup(sv) || dup(bs)) throw new Error('Има повтарящи се имена');
    const ren = {}, bren = {};
    sv.forEach(x => { if (x.old && x.old !== x.name) ren[x.old] = x.name; });
    bs.forEach(x => { if (x.old && x.old !== x.name) bren[x.old] = x.name; });
    DB.history.forEach(h => { if (ren[h.service]) h.service = ren[h.service]; });
    DB.cars.forEach(c => { if (ren[c.service]) c.service = ren[c.service]; });
    DB.trips.forEach(t => { if (ren[t.service]) t.service = ren[t.service]; if (bren[t.bus]) t.bus = bren[t.bus]; });
    const np = {};
    sv.forEach(x => { const o = (b.prices || {})[x.old || x.name] || {}; np[x.name] = { norims: numv(o.norims), rims: numv(o.rims), grid: cleanGrid_(o.grid) }; });
    DB.services = sv.map(x => x.name); DB.buses = bs.map(x => x.name); DB.prices = np;
    DB.extras = (b.extras || []).map(x => String(x || '').trim()).filter(Boolean);
    DB.cars.forEach(c => { if (DB.services.indexOf(c.service) < 0) c.service = DB.services[0]; });
    return true;
  },
  expense(b) {
    const c = carById(b.carId); if (!c) throw new Error('Избери кола');
    if (!b.text) throw new Error('Опиши разхода');
    hist_(c, { date: b.date || todayStr(), type: HTYPE[b.type] ? b.type : 'other', text: b.text, service: b.service || '', cost: b.cost ? numv(b.cost) : '' });
    return true;
  }
};

/* ---------- потребители (само за администратор) ---------- */
function uniqueName_(L, username, self) {
  const n = String(username || '').trim();
  if (!/^[\wа-яА-Я.\-]{3,}$/.test(n)) throw new Error('Потребителското име трябва да е поне 3 знака, без интервали');
  if (L.some(x => x !== self && x.username.toLowerCase() === n.toLowerCase())) throw new Error('Вече има потребител „' + n + '“');
  return n;
}
const USER_ACT = {
  users() { return usersList_().map(userOut_); },
  addUser(b) {
    const L = usersList_();
    if (!String(b.name || '').trim()) throw new Error('Въведи име');
    const u = { username: uniqueName_(L, b.username), name: String(b.name).trim(), role: ROLEN[b.role] ? b.role : 'driver', active: true, hash: '', salt: '', token: '' };
    setPass_(u, b.password);
    L.push(u); usersWrite_(L);
    return L.map(userOut_);
  },
  setUser(b, me) {
    const L = usersList_(), u = L.find(x => x.token === b.id); if (!u) throw new Error('Няма такъв потребител');
    const self = u.token === me.token;
    if (b.active === false && self) throw new Error('Не може да спреш собствения си достъп');
    if (b.role && self && b.role !== 'admin') throw new Error('Не може да махнеш собствените си права на администратор');
    if (b.active != null) u.active = !!b.active;
    if (b.role && ROLEN[b.role]) u.role = b.role;
    if (b.username) u.username = uniqueName_(L, b.username, u);
    if (b.password) { if (self) throw new Error('Своята парола смени от Профил'); setPass_(u, b.password); }
    usersWrite_(L);
    return L.map(userOut_);
  }
};
// смяна на собствената парола и потребителско име (за всички)
function setOwnPass_(b, me) {
  const L = usersList_(), u = L.find(x => x.token === me.token);
  if (u.hash && hash_(u.salt, String(b.old || '')) !== u.hash) throw new Error('Сегашната парола е грешна');
  u.username = uniqueName_(L, b.username || u.username, u);
  setPass_(u, b.password);
  usersWrite_(L);
  return { token: u.token, username: u.username };
}

/* ---------- вход ---------- */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'Гуми Автопарк' })).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  return ContentService.createTextOutput(JSON.stringify(handle_(e && e.postData ? e.postData.contents : '{}'))).setMimeType(ContentService.MimeType.JSON);
}
function handle_(body) {
  let lock = null;
  RAW = cacheLoad_() || {}; RAW_DIRTY = false;
  try {
    const req = JSON.parse(body || '{}'), a = String(req.a || 'load'), d = req.d || {};
    if (a === 'login') return { ok: true, res: login_(d) };
    const me = auth_(req.t);
    if (a === 'setPass') return { ok: true, res: setOwnPass_(d, me) };
    if (USER_ACT[a]) {
      if (me.role !== 'admin') throw new Error('Само за администратор');
      return { ok: true, res: USER_ACT[a](d, me) };
    }
    if (a !== 'load' && a !== 'refresh') {
      if (!ACT[a]) throw new Error('Непознато действие: ' + a);
      if (me.role === 'driver' && !DRIVER_OK[a]) throw new Error('Нямаш права за това');
      if (me.role === 'staff' && STAFF_NO[a]) throw new Error('Само за администратор');
    }
    lock = LockService.getScriptLock();
    lock.waitLock(25000);
    RAW = cacheLoad_() || {}; RAW_DIRTY = false;   // наново след заключването, за да не се ползват стари данни
    DB = load_(a === 'refresh');
    // ако някоя кола е изчезнала от пътната книжка, листовете се записват изцяло (гумите ѝ минават в свободни)
    const before = DB.removedNow.length ? {} : rowsAll_(DB);
    processRemoved_();
    let res = null;
    if (ACT[a]) {
      if (me.role === 'driver' && a === 'change' && !itemOf(d.carId)) throw new Error('Колата не е в рейс');
      res = ACT[a](d);
    }
    const after = rowsAll_(DB);
    Object.keys(after).forEach(k => { if (after[k] !== before[k]) write_(k, JSON.parse(after[k])); });
    if (RAW && RAW_DIRTY) cacheSave_();
    return { ok: true, res, db: public_(), me: { name: me.name, role: me.role, username: me.username, hasPass: !!me.hash } };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), auth: !!(err && err.auth) };
  } finally {
    if (lock) try { lock.releaseLock(); } catch (e) {}
  }
}

/* ---------- автоматично обновяване всеки час ----------
 * Чете пътната книжка (нови/махнати коли, км), записва промените и държи данните в паметта,
 * за да се отваря приложението бързо. Грешките не се пращат по имейл — само се записват в дневника. */
function warmUp() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    RAW = cacheLoad_() || {}; RAW_DIRTY = false;
    DB = load_(true);
    const before = DB.removedNow.length ? {} : rowsAll_(DB);
    processRemoved_();
    const after = rowsAll_(DB);
    Object.keys(after).forEach(k => { if (after[k] !== before[k]) write_(k, JSON.parse(after[k])); });
    cacheSave_();
  } catch (e) {
    console.log('Автоматично обновяване: ' + (e && e.message));
  } finally { lock.releaseLock(); }
}
function installTrigger_() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'warmUp').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('warmUp').timeBased().everyHours(1).create();
}

/* ---------- първоначална настройка: изпълни веднъж ---------- */
function setup() {
  RAW = null; cacheDrop_();
  Object.keys(SH).forEach(sheet_);
  if (!read_('cfg').length) write_('cfg', Object.keys(CFG_DEFAULTS).map(k => ({ 'Ключ': k, 'Стойност': CFG_DEFAULTS[k] })));
  if (!read_('svc').length) write_('svc', [{ 'Сервиз': 'Сервиз 1', 'Монтаж и демонтаж €': 0, 'Смяна с джанти €': 0 }, { 'Сервиз': 'Сервиз 2', 'Монтаж и демонтаж €': 0, 'Смяна с джанти €': 0 }]);
  if (!read_('bus').length) write_('bus', [{ 'Бус': 'Бус 1' }, { 'Бус': 'Бус 2' }]);
  if (!read_('extra').length) write_('extra', ['Изправяне на джанта', 'Вентили', 'Лепенка', 'Баланс', 'Тежести'].map(x => ({ 'Услуга': x })));
  const users = usersList_();
  let pass = '';
  if (!users.length) {
    pass = token_().slice(0, 8);
    const u = { username: 'admin', name: 'Администратор', role: 'admin', active: true, hash: '', salt: '', token: '' };
    setPass_(u, pass); users.push(u);
  }
  users.forEach(u => { if (!u.token) u.token = token_(); });
  usersWrite_(users);   // обновява листа към новия вид (потребител + парола)
  ['Sheet1', 'Лист1', 'Лист 1'].forEach(n => { const s = ss_().getSheetByName(n); if (s && ss_().getSheets().length > 1) ss_().deleteSheet(s); });
  const n = roadCars_(cfg_(), true).length;
  Logger.log('✔ Пътната книжка е намерена: ' + n + ' активни коли. ' + ROAD_INFO);
  const a = users.find(u => u.role === 'admin');
  if (pass) Logger.log('✔ Вход: потребител „admin“, парола „' + pass + '“ — смени я от Профил в приложението.');
  else if (a && !a.hash) Logger.log('Администраторът още няма парола: влез с линка ?t=' + a.token + ' и я задай от Профил.');
  else Logger.log('✔ Потребителите вече имат пароли.');
  cacheDrop_();
  installTrigger_();
  warmUp();
  Logger.log('✔ Автоматично обновяване: всеки час.');
}
