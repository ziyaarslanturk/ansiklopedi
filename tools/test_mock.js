// Ağ olmadan uçtan uca deneme: sahte Wikidata/Vikipedi/Commons yanıtlarıyla çalışır.
process.env.KURU = '1';
const fs = require('fs');
const zlib = require('zlib');
const u = require('./uret.js');

const FAKE = Buffer.alloc(5000, 7);
const EXTRACT = (t) => `${t} kısa bir girişdir. `.repeat(20) + '\n\n== Davranış ==\n' + 'Davranış metni. '.repeat(30) +
  '\n\n== See also ==\nGereksiz liste\n\n== References ==\nKaynak 1\n\n== Dış bağlantılar ==\nlink';
const json = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o, arrayBuffer: async () => FAKE });

global.fetch = async (url) => {
  const U = new URL(url);
  const p = U.searchParams;
  if (U.host === 'query.wikidata.org') {
    return json({ results: { bindings: ['Q1', 'Q2', 'Q3'].map((q, i) => ({
      item: { value: 'http://www.wikidata.org/entity/' + q }, sci: { value: 'Species ' + q }, sl: { value: String(100 - i) } })) } });
  }
  if (U.host === 'www.wikidata.org') {
    if (p.get('ids') === 'Q5113') return json({ entities: { Q5113: { labels: { en: { value: 'bird' } } } } });
    const ents = {};
    for (const q of p.get('ids').split('|')) {
      ents[q] = { sitelinks: { enwiki: { title: 'Bird ' + q }, trwiki: { title: 'Kuş ' + q } }, labels: { en: { value: 'Bird ' + q }, tr: { value: 'Kuş ' + q } } };
      if (q === 'Q3') ents[q].sitelinks = { dewiki: { title: 'Vogel Q3' } };
    }
    return json({ entities: ents });
  }
  if (U.host === 'commons.wikimedia.org') {
    const names = p.get('titles').split('|');
    return json({ query: { pages: names.map((n) => ({ title: n, imageinfo: [{
      mime: 'image/jpeg', width: 1200, thumburl: 'https://upload.wikimedia.org/x/' + n, descriptionurl: 'https://commons.wikimedia.org/wiki/' + n,
      extmetadata: { LicenseShortName: { value: n.includes('NC') ? 'CC BY-NC 4.0' : 'CC BY-SA 4.0' }, Artist: { value: '<a href="x">Jane &amp; Doe</a>' } } }] })) } });
  }
  if (U.host === 'upload.wikimedia.org') return json({});
  if (/wikipedia\.org$/.test(U.host)) {
    if (p.get('prop') === 'images|pageimages') {
      return json({ query: { pages: [{ pageimage: 'Main_photo.jpg', images: [
        { title: 'File:Main photo.jpg' }, { title: 'File:Second one.jpg' }, { title: 'File:Range map.png' },
        { title: 'File:Bad NC.jpg' }, { title: 'File:Icon.svg' }, { title: 'File:Orange tree.jpg' }, { title: 'File:Fourth.jpg' }] }] } });
    }
    return json({ query: { pages: [{ extract: EXTRACT(p.get('titles')) }] } });
  }
  throw new Error('beklenmeyen: ' + url);
};

(async () => {
  // birim kontroller
  const t = u.cleanText('Giriş\n\n== Davranış ==\nmetin\n\n== See also ==\nx\n\n== Boş ==\n\n=== Alt ===\ny', 'en');
  console.log(JSON.stringify(t));
  console.log('lisans:', u.licOk('CC BY-SA 4.0'), u.licOk('CC BY-NC 4.0'), u.licOk('Public domain'), u.licOk('Fair use'));
  console.log('kötü ad:', u.BAD_IMG.test('Range map.png'), u.BAD_IMG.test('Orange tree.jpg'), u.BAD_IMG.test('Main photo.jpg'));

  const meta = await u.main('birds', 3);
  console.log(JSON.stringify(meta.sayi), meta.gorseller.map((g) => g.dosya));
  const arr = JSON.parse(zlib.gunzipSync(fs.readFileSync('out/tr_birds.json.gz')));
  console.log(arr.length, JSON.stringify(arr[0], null, 1).slice(0, 900));
  console.log('img files:', fs.readdirSync('out/img/birds'));
})().catch((e) => { console.error('TEST HATA', e); process.exit(1); });
