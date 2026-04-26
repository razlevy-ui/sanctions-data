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
    url:'https://data.opensanctions.org/datasets/latest/ch_seco/targets.simple.csv' },
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
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ')
    .split(/\s+/).filter(w => w && !PARTICLES.has(w)).join(' ').trim();
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
      country: r.countries || '',
      program: r.sanctions || '',
      ref: r.id || '',
      reason: r.notes || ''
    };
  });
}

function parseXml(body, listId) {
  const parser = new XMLParser({ ignoreAttributes:false, parseTagValue:true });
  const doc = parser.parse(body);

  const findArray = (o) => {
    if (Array.isArray(o)) return o;
    if (typeof o !== 'object' || !o) return null;
    for (const k of Object.keys(o)) {
      const r = findArray(o[k]);
      if (r && r.length > 0 && typeof r[0] === 'object') return r;
    }
    return null;
  };

  const items = findArray(doc) || [];
  const pick = (o, keys) => { for (const k of keys) if (o?.[k]) return String(o[k]); return ''; };

  return items.map(item => {
    const name = pick(item, ['NameInEnglish','Name','FullName','EntityName']);
    if (!name) return null;
    const aliases = [];
    for (const k of ['Alias','AlsoKnownAs','AKA','NameVariation']) {
      const v = item?.[k];
      if (Array.isArray(v)) v.forEach(x => aliases.push(String(x)));
      else if (v) aliases.push(String(v));
    }
    return {
      name,
      name_normalized: normalize(name),
      aliases,
      aliases_normalized: aliases.map(normalize),
      type: listId === 'il_individuals' ? 'Individual' : 'Entity',
      country: pick(item, ['Country','Nationality']),
      program: `NBCTF ${listId}`,
      ref: pick(item, ['Id','Reference','SerialNumber']),
      reason: pick(item, ['Reason','Designation','Description'])
    };
  }).filter(Boolean);
}

const out = { generated_at: new Date().toISOString(), lists: [] };

for (const src of SOURCES) {
  try {
    console.log(`Fetching ${src.id}...`);
    const body = await fetchUrl(src.url);
    const records = src.format === 'csv' ? parseCsv(body) : parseXml(body, src.id);
    if (!records.length) throw new Error('Parser produced 0 records');
    out.lists.push({
      id: src.id, display_name: src.display, source_url: src.url,
      records_count: records.length, status: 'ok', records
    });
    console.log(`  ${src.id}: ${records.length} records`);
  } catch (e) {
    console.error(`  ${src.id}: FAILED — ${e.message}`);
    out.lists.push({
      id: src.id, display_name: src.display, source_url: src.url,
      records_count: 0, status: 'failed', error: e.message, records: []
    });
  }
}

await fs.writeFile('data.json', JSON.stringify(out));
const total = out.lists.reduce((a,l)=>a+l.records_count,0);
console.log(`\nDone. Total records across all lists: ${total}`);
