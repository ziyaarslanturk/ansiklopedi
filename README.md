# ansiklopedi

Trailo PRO için çevrimdışı ansiklopedi paketleri: 5 dilde (tr, en, de, ru, ar) tür makaleleri ve görselleri.

- Tür listesi: Wikidata (her grupta Vikipedi'de en çok dile çevrilmiş türler, `gruplar.json`)
- Metin: Vikipedi, CC BY-SA 4.0 (her makalenin sonunda kaynak bağlantısı vardır)
- Görsel: Wikimedia Commons. Sadece CC BY, CC BY-SA, CC0 ve kamu malı görseller alınır.
  Her görselin yazarı, lisansı ve kaynağı makale kaydındaki `images` alanında yazılıdır ve uygulamada görselin altında gösterilmelidir.
- Dosyalar **Releases > ansiklopedi** altında durur, liste `catalog.json` dosyasındadır:
  `https://raw.githubusercontent.com/ziyaarslanturk/ansiklopedi/main/catalog.json`

## Dosya biçimi
- `{dil}_{grup}.json.gz`: `[ { qid, title, sci, content, tags, src, images:[{f,by,lic,src}] } ]`
  (`title`, `content`, `tags` alanları mevcut uygulama ayrıştırıcısıyla uyumludur; `content` içinde `## Başlık` satırları bölüm başlığıdır.)
- `gorsel_{grup}_{n}.zip`: `{qid}_{sıra}.jpg|png|webp` dosyaları (640 piksel genişlik). Bir grubun tüm parçaları indirilir.

## Çalıştırma
Actions > **Ansiklopedi üret** > Run workflow.
- İlk deneme: `grup=birds`, `limit=30` (birkaç dakika).
- Tam üretim: `limit=0` yaz. Grup başına birkaç saat sürebilir.
- `grup=hepsi` tüm grupları çalıştırır.

Grup eklemek için `gruplar.json` dosyasına yeni satır ekle (`klad`: Wikidata sınıf kimliği).

## Lisans
Metin ve görseller kendi lisanslarıyla dağıtılır (yukarıya bakın).
