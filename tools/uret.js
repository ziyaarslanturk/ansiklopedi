#!/usr/bin/env node
'use strict';
// Kullanım: node tools/uret.js <grup-id> [limit]
// Wikidata'dan tür listesi, Vikipedi'den 5 dilde makale, Commons'tan görsel + lisans bilgisi üretir,
// paketleri Release'e yükler ve meta/<grup>.json yazar.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');

const LANGS = ['tr', 'en', 'de', 'ru', 'ar'];
const UA = 'TrailoPRO-ansiklopedi/1.0 (https://github.com/ziyaarslanturk/ansiklopedi)';
const REPO = process.env.GITHUB_REPOSITORY || 'ziyaarslanturk/ansiklopedi';
const TAG = 'ansiklopedi';
const KURU = process.env.KURU === '1';            // 1: Release'e yükleme yapma (deneme)
const MAX_MS = 5 * 60 * 60 * 1000;                // 5 saat sonra durup eldekini yayınla
const CONC = 4;                                   // aynı anda en fazla 4 istek (Wikimedia nezaketi)
const MAX_IMG = 3;                                // tür başına en fazla görsel
const IMG_W = 640;                                // küçük görsel genişliği
const IMG_MAX_BYTES = 400 * 1024;
const PART_BYTES = 1500 * 1024 * 1024;            // görsel zip parçası (GitHub sınırı 2 GB)
const MAX_CHARS = 16000;

const SCI = { tr: 'Bilimsel ad', en: 'Scientific name', de: 'Wissenschaftlicher Name', ru: 'Научное название', ar: 'الاسم العلمي' };
const SRC = { tr: 'Kaynak: Vikipedi', en: 'Source: Wikipedia', de: 'Quelle: Wikipedia', ru: 'Источник: Википедия', ar: 'المصدر: ويكيبيديا' };
const DROP = {
  en: ['see also', 'references', 'external links', 'further reading', 'notes', 'bibliography', 'sources', 'footnotes'],
  tr: ['ayrıca bakınız', 'kaynakça', 'dış bağlantılar', 'notlar', 'kaynaklar', 'dipnotlar'],
  de: ['weblinks', 'einzelnachweise', 'literatur', 'siehe auch', 'anmerkungen', 'quellen'],
  ru: ['примечания', 'литература', 'ссылки', 'см. также', 'источники', 'комментарии'],
  ar: ['انظر أيضا', 'انظر أيضًا', 'مراجع', 'المراجع', 'وصلات خارجية', 'هوامش', 'الهوامش', 'المصادر']
};
const BAD_IMG = /(^|[^a-z])(icon|logo|flag|map|range|distribution|symbol|commons|wiki|wikipedia|ambox|question_book|status|increase|decrease|taxobox|iucn|audio|speaker|skull|skeleton|diagram|chart|graph|cladogram|phylogeny)([^a-z]|$)/i;
const OK_EXT = /\.(jpe?g|png|webp)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

async function http(url, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    let wait = Math.min(60000, 1500 * 2 ** i);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return r;
      last = new Error('HTTP ' + r.status + ' ' + url.slice(0, 140));
      if (![429, 500, 502, 503, 504].includes(r.status)) { last.fatal = true; throw last; }
      const ra = parseInt((r.headers && r.headers.get && r.headers.get('retry-after')) || '0', 10);
      if (ra > 0) wait = Math.max(wait, Math.min(ra, 120) * 1000);
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    await sleep(wait);
  }
  throw last;
}
const getJson = async (url) => (await http(url)).json();

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------- metin temizleme
function cleanText(raw, lang) {
  const drop = new Set((DROP[lang] || []).map((s) => s.toLowerCase()));
  const out = [];
  let skip = false;
  for (const ln of String(raw || '').replace(/\r/g, '').split('\n')) {
    const m = ln.match(/^(=+)\s*(.+?)\s*=+\s*$/);
    if (m) {
      const level = m[1].length;
      const name = m[2].trim();
      if (level <= 2 && drop.has(name.toLowerCase())) { skip = true; continue; }
      if (level <= 2) skip = false;
      if (skip) continue;
      out.push('', '## ' + name);
      continue;
    }
    if (!skip) out.push(ln.trimEnd());
  }
  let t = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let prev;
  do { prev = t; t = t.replace(/(^|\n)## [^\n]+\n+(?=## |$)/g, '$1'); } while (t !== prev);
  t = t.trim();
  if (t.length > MAX_CHARS) {
    let cut = t.lastIndexOf('\n\n', MAX_CHARS);
    if (cut < MAX_CHARS * 0.5) cut = MAX_CHARS;
    t = t.slice(0, cut).trim() + ' …';
  }
  return t;
}

// ---------------------------------------------------------------- görsel yardımcıları
const normName = (s) => String(s || '').replace(/^[^:]+:/, '').replace(/_/g, ' ').trim();
const licOk = (s) => /^(cc[ -]?by|cc0|cc[ -]?zero|public domain|pd\b)/i.test(s || '') && !/(-nc|-nd|\bnc\b|\bnd\b)/i.test(s || '');
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
const extOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || null);

async function imageCandidates(titles) {
  const lang = titles.en ? 'en' : Object.keys(titles)[0];
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=images|pageimages&piprop=name&imlimit=60&titles=${enc(titles[lang])}`;
  const j = await getJson(url);
  const pg = (j.query && j.query.pages && j.query.pages[0]) || {};
  const names = [];
  if (pg.pageimage) names.push(pg.pageimage);
  for (const im of pg.images || []) names.push(im.title);
  const seen = new Set();
  const out = [];
  for (const n of names.map(normName)) {
    if (!n || seen.has(n) || !OK_EXT.test(n) || BAD_IMG.test(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 10) break;
  }
  return out;
}

async function imageInfos(cands) {
  if (!cands.length) return [];
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo' +
    '&iiprop=' + enc('url|mime|size|extmetadata') + '&iiextmetadatafilter=' + enc('Artist|LicenseShortName') +
    '&iiurlwidth=' + IMG_W + '&titles=' + enc(cands.map((n) => 'File:' + n).join('|'));
  const j = await getJson(url);
  const byName = {};
  for (const p of (j.query && j.query.pages) || []) {
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii) continue;
    byName[normName(p.title)] = ii;
  }
  const res = [];
  for (const n of cands) {
    const ii = byName[n];
    if (!ii) continue;
    const ext = extOf(ii.mime);
    const lic = stripHtml(ii.extmetadata && ii.extmetadata.LicenseShortName && ii.extmetadata.LicenseShortName.value);
    if (!ext || !licOk(lic) || (ii.width || 0) < 400) continue;
    const by = stripHtml(ii.extmetadata && ii.extmetadata.Artist && ii.extmetadata.Artist.value).slice(0, 140) || 'Wikimedia Commons';
    res.push({ name: n, ext, url: ii.thumburl || ii.url, by, lic: lic.slice(0, 40), src: ii.descriptionurl || ('https://commons.wikimedia.org/wiki/File:' + enc(n.replace(/ /g, '_'))) });
    if (res.length >= MAX_IMG) break;
  }
  return res;
}

// ---------------------------------------------------------------- Wikidata
async function sparql(q) {
  const j = await getJson('https://query.wikidata.org/sparql?format=json&query=' + enc(q));
  return j.results.bindings;
}

async function selectSpecies(gr, limit) {
  let min = gr.min_sl;
  for (let k = 0; k < 4; k++) {
    const q = `SELECT ?item ?sci ?sl WHERE { ?item wdt:P105 wd:Q7432 ; wdt:P171+ wd:${gr.klad} ; wdt:P225 ?sci ; wikibase:sitelinks ?sl . FILTER(?sl >= ${min}) } ORDER BY DESC(?sl) LIMIT ${limit}`;
    try {
      const rows = await sparql(q);
      const seen = new Set();
      const list = [];
      for (const r of rows) {
        const qid = r.item.value.split('/').pop();
        if (seen.has(qid)) continue;
        seen.add(qid);
        list.push({ qid, sci: r.sci.value, sl: parseInt(r.sl.value, 10) || 0 });
      }
      console.log(`== ${gr.id}: ${list.length} tür bulundu (eşik ${min})`);
      return list;
    } catch (e) {
      console.log('SPARQL hatası, eşik yükseltiliyor: ' + e.message);
      min = Math.ceil(min * 1.6);
    }
  }
  throw new Error('Tür listesi alınamadı: ' + gr.id);
}

async function fetchEntities(qids) {
  const res = {};
  for (let i = 0; i < qids.length; i += 50) {
    const url = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=' + enc('sitelinks|labels') +
      '&sitefilter=' + enc(LANGS.map((l) => l + 'wiki').join('|')) + '&languages=' + enc(LANGS.join('|')) +
      '&ids=' + enc(qids.slice(i, i + 50).join('|'));
    const j = await getJson(url);
    Object.assign(res, j.entities || {});
  }
  return res;
}

async function fetchArticle(lang, title) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${enc(title)}`;
  const j = await getJson(url);
  const pg = (j.query && j.query.pages && j.query.pages[0]) || {};
  return cleanText(pg.extract || '', lang);
}

// ---------------------------------------------------------------- yardımcılar
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function upload(file) {
  if (KURU) return;
  cp.execFileSync('gh', ['release', 'upload', TAG, file, '--clobber', '--repo', REPO], { stdio: 'inherit' });
}
const assetMeta = (file) => ({
  dosya: path.basename(file), boyut: fs.statSync(file).size, sha256: sha256(file),
  url: `https://github.com/${REPO}/releases/download/${TAG}/${path.basename(file)}`
});

function zipParts(dir, grup, outDir) {
  const files = fs.readdirSync(dir).filter((f) => /\.(jpg|png|webp)$/.test(f)).sort();
  const parts = [];
  let cur = [], size = 0;
  const flush = () => {
    if (!cur.length) return;
    const zipPath = path.join(outDir, `gorsel_${grup}_${parts.length + 1}.zip`);
    cp.execFileSync('zip', ['-q', '-0', '-j', zipPath, '-@'], { input: cur.map((f) => path.join(dir, f)).join('\n') });
    parts.push(zipPath);
    cur = []; size = 0;
  };
  for (const f of files) {
    const s = fs.statSync(path.join(dir, f)).size;
    if (size + s > PART_BYTES) flush();
    cur.push(f); size += s;
  }
  flush();
  return parts;
}

// ---------------------------------------------------------------- ana akış
async function main(grupId, limitOverride) {
  const T0 = Date.now();
  const gr = JSON.parse(fs.readFileSync('gruplar.json', 'utf8')).find((g) => g.id === grupId);
  if (!gr) throw new Error('Grup yok: ' + grupId);
  const limit = limitOverride > 0 ? Math.min(limitOverride, gr.limit) : gr.limit;

  const out = path.resolve('out'), imgDir = path.join(out, 'img', grupId), metaDir = path.resolve('meta');
  fs.rmSync(path.join(out, 'img', grupId), { recursive: true, force: true });
  fs.mkdirSync(imgDir, { recursive: true });
  fs.mkdirSync(metaDir, { recursive: true });

  const klad = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=${gr.klad}`);
  console.log(`== Klad ${gr.klad}: ${(klad.entities[gr.klad].labels.en || {}).value} (beklenen grup: ${grupId})`);

  const species = await selectSpecies(gr, limit);
  const ents = await fetchEntities(species.map((s) => s.qid));
  for (const s of species) {
    const e = ents[s.qid] || {};
    s.titles = {}; s.labels = {};
    for (const l of LANGS) {
      const sl = e.sitelinks && e.sitelinks[l + 'wiki'];
      if (sl) s.titles[l] = sl.title;
      const lb = e.labels && e.labels[l];
      if (lb) s.labels[l] = lb.value;
    }
  }
  const work = species.filter((s) => Object.keys(s.titles).length > 0);
  console.log(`== ${work.length} türün en az bir dilde makalesi var`);

  let partial = false, done = 0;
  await pool(work, CONC, async (s) => {
    if (Date.now() - T0 > MAX_MS) { partial = true; return; }
    try {
      s.text = {};
      for (const l of LANGS) {
        if (!s.titles[l]) continue;
        try {
          const t = await fetchArticle(l, s.titles[l]);
          if (t.length >= 200) s.text[l] = t;
        } catch (e) { console.log(`makale alınamadı ${l}/${s.titles[l]}: ${e.message}`); }
      }
      s.images = [];
      if (Object.keys(s.text).length) {
        try {
          const infos = await imageInfos(await imageCandidates(s.titles));
          let n = 0;
          for (const im of infos) {
            try {
              const buf = Buffer.from(await (await http(im.url, 4)).arrayBuffer());
              if (buf.length > IMG_MAX_BYTES || buf.length < 2000) continue;
              n++;
              const f = `${s.qid}_${n}.${im.ext}`;
              fs.writeFileSync(path.join(imgDir, f), buf);
              s.images.push({ f, by: im.by, lic: im.lic, src: im.src });
            } catch (e) { console.log(`görsel indirilemedi ${im.name}: ${e.message}`); }
          }
        } catch (e) { console.log(`görsel listesi alınamadı ${s.qid}: ${e.message}`); }
      }
    } catch (e) { console.log(`tür atlandı ${s.qid}: ${e.message}`); }
    if (++done % 50 === 0) console.log(`ilerleme: ${done}/${work.length}`);
  });

  const meta = { id: gr.id, ad: gr.ad, sayi: {}, makale: {}, gorseller: [], tamam: !partial, guncelleme: new Date().toISOString() };
  for (const l of LANGS) {
    const arr = [];
    for (const s of work) {
      if (!s.text || !s.text[l]) continue;
      const title = s.titles[l];
      const srcUrl = `https://${l}.wikipedia.org/wiki/${encodeURI(title.replace(/ /g, '_'))}`;
      const content = `${SCI[l]}: ${s.sci}\n\n${s.text[l]}\n\n${SRC[l]} — ${srcUrl} (CC BY-SA 4.0)`;
      const tags = Array.from(new Set([s.sci, ...Object.values(s.labels), gr.id]));
      arr.push({ qid: s.qid, title: s.labels[l] || title, sci: s.sci, content, tags, src: srcUrl, images: s.images });
    }
    const file = path.join(out, `${l}_${gr.id}.json.gz`);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(arr), 'utf8')));
    meta.sayi[l] = arr.length;
    meta.makale[l] = assetMeta(file);
    upload(file);
    console.log(`== ${l}: ${arr.length} makale, ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
  }
  for (const z of zipParts(imgDir, gr.id, out)) {
    meta.gorseller.push(assetMeta(z));
    upload(z);
    console.log(`== görsel paketi: ${path.basename(z)} ${(fs.statSync(z).size / 1048576).toFixed(1)} MB`);
  }
  fs.writeFileSync(path.join(metaDir, `${gr.id}.json`), JSON.stringify(meta, null, 2));
  console.log(`== Bitti: ${gr.id}${partial ? ' (süre doldu, kısmi)' : ''}`);
  return meta;
}

module.exports = { main, cleanText, licOk, stripHtml, BAD_IMG, OK_EXT };

if (require.main === module) {
  const id = process.argv[2];
  if (!id) { console.error('Kullanım: node tools/uret.js <grup-id> [limit]'); process.exit(1); }
  main(id, parseInt(process.argv[3] || '0', 10)).catch((e) => { console.error('HATA:', e.message); process.exit(1); });
}
