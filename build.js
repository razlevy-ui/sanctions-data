import fs from 'fs/promises';
import Papa from 'papaparse';
import { XMLParser } from 'fast-xml-parser';

const SOURCES = [
  { id:'ofac', display:'OFAC SDN (US Treasury)', format:'csv',
    url:'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/targets.simple.csv' },
  { id:'eu', display:'EU Consolidated Sanctions', format:'csv',
    url:'https://data.opensanctions.org/datasets/latest/eu_fsf/targets.simple.csv' },
  { id:'un', display:'UN Security Council', format:'csv',
    url:'https://data.opensanctions.org/datasets/latest/un_sc_sanctions/targets.simple.csv' },
  { id:'uk', display:'UK Sanctions (FCDO)', format:'csv',
    url:'https://data.opensanctions.org/datasets/latest/gb_fcdo_sanctions/targets.simple.csv' },
  { id:'ch', display:'Switzerland SECO', format:'csv',
    url:'https://data.opensanctions.org/datasets/latest/ch_seco_sanctions/targets.simple.csv' },
  { id:'il_individuals', display:'Israel NBCTF — Individuals', format:'xml',
    url:'https://nbctf.mod.gov.il/he/Announcements/Documents/NBCTF%20Israel%20designation%20Individuals_XML.xml' },
  { id:'il_orgs', display:'Israel NBCTF — Organizations', format:'xml',
    url:'https://nbctf.mod.gov.il/he/Announcements/Documents/NBCTFIsrael%20-%20Terror%20Organization%20Designation%20List_XML.xml' },
  { id:'il_seizure', display:'Israel NBCTF — Seizure Orders', format:'xml',
    url:'https://nbctf.mod.gov.il/he/PropertyPerceptions/Documents/NBCTF_Seizure_List-XML.xml' }
];

const PARTICLES = new Set(['al','abu','ibn','bin','el','van','de','von','ben','der','la','le','du']);

function normalize(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[̀-ͯ]/g,'')
    .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ')
    .split(/\s+/).filter(w => w && !PARTICLES.has(w)).join(' ').trim();
}

// Returns true if the string looks like an ISO datetime (from SpreadsheetML date cells)
function isIsoDatetime(s) {
  return /^\d{4}-\d{2}-\d{2}T/.test(s);
}

// Returns true if the string looks like a DD/MM/YYYY date
function isDmyDate(s) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(s);
}

// Decode numeric HTML entities that fast-xml-parser may leave unresolved (e.g. &#45; → -)
function decodeNumericEntities(s) {
  if (!s || !s.includes('&#')) return s;
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// Returns true if the string is a null placeholder (e.g. "--/--/----")
function isNullPlaceholder(s) {
  if (!s) return true;
  const decoded = decodeNumericEntities(s);
  return /^[-\s\/—–]+$/.test(decoded);
}

// Returns true if the record has a revoked/cancelled designation (Hebrew: בוטל)
function isRevoked(s) {
  return typeof s === 'string' && s.includes('בוטל');
}

async function fetchUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SanctionsETL/1.0)' },
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.text();
  if (!body || body.length < 100) throw new Error(`Body too small: ${body.length} bytes`);
  return body;
}

function parseCsv(body) {
  const { data } = Papa.parse(body, { header:true, skipEmptyLines:true });
  return data.filter(r => r.name && !r.name.startsWith('#')).map(r => {
    const aliases = r.aliases ? r.aliases.split(';').map(s=>s.trim()).filter(Boolean) : [];
    return {
      name: r.name,
      name_normalized: normalize(r.name),
      aliases,
      aliases_normalized: aliases.map(normalize),
      type: r.schema === 'Person' ? 'Individual' : 'Entity',
      country: (r.countries || '').replace(/^-$/, ''),
      program: r.sanctions || '',
      ref: r.id || '',
      designation_date: '',
      expiry_date: '',
      reason: r.notes || ''
    };
  });
}

function parseXml(body, listId) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: true,
    maxEntityCount: 10_000_000,
    maxTotalExpansions: 10_000_000,
    maxExpansionDepth: 1_000_000,
    maxExpandedLength: 100_000_000,
    maxEntitySize: 10_000_000,
  });
  const doc = parser.parse(body);

  // SpreadsheetML: Workbook → Worksheet → Table → Row[] → Cell[] → Data
  const ws = doc?.Workbook?.Worksheet;
  const sheet = Array.isArray(ws) ? ws[0] : ws;
  let rows = sheet?.Table?.Row;
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  if (rows.length < 3) return [];

  const cellText = (cell) => {
    const d = cell?.Data;
    if (d == null) return '';
    const raw = typeof d === 'object' ? String(d['#text'] ?? '') : String(d);
    return decodeNumericEntities(raw);
  };
  const rowCells = (row) => {
    const c = row?.Cell;
    const arr = Array.isArray(c) ? c : (c ? [c] : []);
    return arr.map(cellText);
  };

  // Row 1 = Hebrew headers, Row 2 = English headers, Row 3+ = data
  const headers = rowCells(rows[1]).map(h => (h || '').trim().toLowerCase());
  const findCol = (...needles) => headers.findIndex(h => needles.every(n => h.includes(n)));

  const nameCol   = [findCol('name','english'), findCol('name')].find(i => i >= 0) ?? -1;
  if (nameCol < 0) return [];

  const idCol         = findCol('id');
  const nationCol     = [findCol('national'), findCol('residency'), findCol('citizen')].find(i => i >= 0) ?? -1;
  const aliasCol      = [findCol('alias'), findCol('aka'), findCol('known')].find(i => i >= 0) ?? -1;
  const designationCol = findCol('designation');   // usually "Designation Date"
  const expiryCol     = [findCol('expiry'), findCol('valid until'), findCol('until')].find(i => i >= 0) ?? -1;
  // seq/serial: correct for individuals/orgs; in il_seizure this column holds the expiry date
  const refCol        = [findCol('seq'), findCol('serial'), findCol('order','number'), findCol('number')].find(i => i >= 0) ?? -1;

  const today = new Date().toISOString().substring(0, 10);

  return rows.slice(2).map(r => {
    const cells = rowCells(r);

    const name = (cells[nameCol] || '').trim();
    if (!name || name === '-') return null;

    // Aliases — may or may not exist in each XML
    const aliasRaw = aliasCol >= 0 ? (cells[aliasCol] || '').trim() : '';
    const aliases = aliasRaw && aliasRaw !== '-'
      ? aliasRaw.split(/[;,]/).map(s => s.trim()).filter(Boolean)
      : [];

    // Country — normalize '-' placeholder to ''
    const countryRaw = nationCol >= 0 ? (cells[nationCol] || '').trim() : '';
    const country = countryRaw === '-' ? '' : countryRaw;

    // Designation date — stored in 'designation' column (e.g. "25/03/2026" or ISO)
    const designationRaw = designationCol >= 0 ? (cells[designationCol] || '').trim() : '';
    // If the field contains a revocation notice, drop this record entirely
    if (isRevoked(designationRaw)) return null;
    const designation_date = (isDmyDate(designationRaw) || isIsoDatetime(designationRaw))
      ? designationRaw
      : '';
    // Null placeholders (--/--/----) become empty string
    const reason = designation_date || isNullPlaceholder(designationRaw) ? '' : designationRaw;

    // Ref / expiry — the refCol in il_seizure contains expiry datetimes instead of IDs
    const refRaw = refCol >= 0 ? (cells[refCol] || '').trim() : '';
    const refIsDate = isIsoDatetime(refRaw);

    // Explicit expiry column takes priority; fall back to refCol if it looks like a date
    const expiryRaw = expiryCol >= 0
      ? (cells[expiryCol] || '').trim()
      : (refIsDate ? refRaw : '');
    const expiry_date = isIsoDatetime(expiryRaw) ? expiryRaw.substring(0, 10) : '';

    const ref = refIsDate
      ? (idCol >= 0 ? (cells[idCol] || '').trim() : '')
      : refRaw;

    return {
      name,
      name_normalized: normalize(name),
      aliases,
      aliases_normalized: aliases.map(normalize),
      type: listId === 'il_individuals' ? 'Individual' : 'Entity',
      country,
      program: `NBCTF ${listId}`,
      ref,
      designation_date,
      expiry_date,
      reason
    };
  }).filter(r => {
    if (!r) return false;
    if (!r.name_normalized) return false;
    // Drop expired seizure/designation orders
    if (r.expiry_date && r.expiry_date < today) return false;
    return true;
  });
}

// Deduplicate records within a list by (name_normalized, ref)
function dedup(records) {
  const seen = new Set();
  return records.filter(r => {
    const key = r.name_normalized + '|' + r.ref;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const today_str = new Date().toISOString().substring(0, 10);
const out = { generated_at: new Date().toISOString(), build_date: today_str, lists: [] };

for (const src of SOURCES) {
  try {
    console.log(`Fetching ${src.id}...`);
    const body = await fetchUrl(src.url);
    const raw = src.format === 'csv' ? parseCsv(body) : parseXml(body, src.id);
    if (!raw.length) throw new Error('Parser produced 0 records');
    const records = dedup(raw);
    const filtered_count = raw.length - records.length;
    out.lists.push({
      id: src.id, display_name: src.display, source_url: src.url,
      records_count: records.length,
      filtered_count,
      status: 'ok',
      records
    });
    console.log(`  ${src.id}: ${records.length} records (${filtered_count} filtered/deduped)`);
  } catch (e) {
    console.error(`  ${src.id}: FAILED — ${e.message}`);
    out.lists.push({
      id: src.id, display_name: src.display, source_url: src.url,
      records_count: 0, filtered_count: 0, status: 'failed', error: e.message, records: []
    });
  }
}

await fs.writeFile('data.json', JSON.stringify(out));
const total = out.lists.reduce((a,l)=>a+l.records_count,0);
console.log(`\nDone. Total active records: ${total}`);
