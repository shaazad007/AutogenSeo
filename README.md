# Shopify Cloth AI Automation

आपके Shopify store के पुराने ~80,000 products की title, description, meta description, tags
और image alt text को Google Gemini AI से रोज़ थोड़ा-थोड़ा (डिफ़ॉल्ट: 1,000/दिन) अपने-आप बेहतर
करने वाला सिस्टम। सिर्फ आपके अपने स्टोर के लिए — कोई embedded app, कोई public OAuth login screen नहीं।

---

## पहले यह समझ लें

- यह GitHub Actions पर रोज़ रात को अपने-आप चलता है — आपका लैपटॉप बंद हो तब भी।
- Fabric का नाम इमेज से नहीं गढ़ा जाता — सिर्फ अगर पुरानी title/description में पहले से हो, तभी।
- Designer और model/celebrity के नाम सिर्फ `designers.json` / `models.json` से आते हैं — AI कभी अंदाज़ा नहीं लगाता।
- Product का URL/handle कभी नहीं बदलता (SEO के लिए ज़रूरी)।
- हर product की पुरानी description अपने-आप एक metafield में backup हो जाती है, इसलिए वापस भी जाया जा सकता है।
- **`preview` mode से हमेशा शुरू करें** — यह सिर्फ `/preview` folder में files लिखता है, Shopify में कुछ नहीं बदलता।

---

## सेटअप — Step by Step

### A) Gemini API Key

1. [aistudio.google.com](https://aistudio.google.com) पर अपने Google account से login करें।
2. **"Get API Key"** पर क्लिक करके key copy करें।

### B) Shopify Custom App बनाना (Client Credentials तरीका — कोई OAuth popup नहीं)

1. Shopify Admin → **Settings → Apps and sales channels → Develop apps** → **Create an app**।
2. Configuration में scopes दें: `read_products`, `write_products` (image alt text के लिए ज़रूरत पड़े तो `write_files`/`write_media` भी)।
3. **Client credentials** section से **Client ID** और **Client Secret** copy करें।
4. App को अपने ही स्टोर पर install करें (Distribution: यह पहले से आपके स्टोर के लिए ही होता है)।

> कोड हर बार इन दोनों से खुद access token बना लेता है (`grant_type=client_credentials`) — इसमें कोई browser "Authorize this app?" वाली स्क्रीन नहीं आती, यह server-to-server है।

### C) GitHub पर Repo बनाना

1. [github.com](https://github.com) पर free account बनाएं।
2. **New repository** → नाम `shopify-cloth-ai`, **Public** चुनें (free minutes ज़्यादा मिलते हैं)।
3. यह सारे files (जो आपको मिले हैं) उस repo में upload कर दें — folder structure बिल्कुल वैसे ही रखें।
4. **Settings → Secrets and variables → Actions → New repository secret** — यह 4 secrets बनाएं:

   | Name | Value |
   |---|---|
   | `SHOPIFY_STORE` | `aapkastore.myshopify.com` |
   | `SHOPIFY_CLIENT_ID` | (B से) |
   | `SHOPIFY_CLIENT_SECRET` | (B से) |
   | `GEMINI_API_KEY` | (A से) |

   **Keys कभी भी chat में, code में, या किसी file में hardcode न करें — हमेशा Secrets में ही।**

### D) पहला Test

1. Repo के **Actions** tab में जाएं। अगर **"Test"** workflow नहीं दिख रही, कुछ seconds wait करें (GitHub को नई repo के workflows index करने में थोड़ा वक़्त लगता है)।
2. **"Test"** workflow चुनें → **Run workflow** → 1-2 मिनट में green ✅ tick आना चाहिए। इससे पता चलेगा Actions चल रहा है।
3. अब **"Auto Process Products"** workflow चुनें → **Run workflow** → `mode: preview`, `limit: 10` रखें → Run करें।
4. Run पूरा होने पर repo के `/preview` folder में 10 `.txt` files बन जाएंगी — हर एक में नई title, description, meta, tags, alt text। **इन्हें पढ़कर check करें।**
5. संतुष्ट होने के बाद, `mode: live`, `limit: 10` से एक छोटा असली test चलाएं और Shopify Admin में जाकर 1-2 products खुद देख लें।
6. सब ठीक लगे तो nightly automatic run (`0 21 * * *` UTC, यानी रोज़ रात) अपने-आप चलती रहेगी — कुछ करने की ज़रूरत नहीं।

---

## रोज़ाना Progress कहाँ देखें

- **GitHub → Actions tab**: हर run का पूरा log (कितने products हुए, कोई fail हुआ या नहीं)।
- **Dashboard**: `docs/index.html` को GitHub Pages पर publish करें (repo **Settings → Pages → Source: main branch, /docs folder**) — फिर एक link मिलेगा जहाँ professional dashboard दिखेगा: total progress, आज का batch, ETA days, live-jैसा activity log, failed items list। इसे खोलने से पहले `docs/index.html` में `GITHUB_REPO` constant अपने असली `username/repo` से बदल दें।
- **Shopify Admin**: processed products पर `ai-done` tag लग जाता है, filter करके गिन सकते हैं।
- `progress.json` और `failed.csv` repo की root में हमेशा latest स्थिति रखते हैं।

---

## Config Files (बेझिझक GitHub पर edit करें)

- **`config.json`** — AI क्या detect करे (`detect`), tone rules (`extra_rules`), banned phrases, brand name/link, daily cap, delay, Gemini model names, collection filter। दूसरी category (जैसे electronics) के लिए बस `detect` बदल दें, या इसकी एक कॉपी (`electronics-config.json`) बनाकर code में select करने की सुविधा जोड़ी जा सकती है।
- **`designers.json`** — designer का नाम, उसे पहचानने वाले keywords (`match`), collection link, Instagram। इसमें placeholder example है — इसे अपने असली designers से भरें/मिटाएं।
- **`models.json`** — model/celebrity का नाम + Instagram, सिर्फ यहाँ मौजूद नाम ही description में आएंगे।

---

## Folder Structure

```
shopify-cloth-ai/
├── index.js                       # entry point (preview/live mode)
├── config.json                    # editable AI prompt + settings
├── designers.json                 # designer name -> collection link, Instagram
├── models.json                    # model/celebrity name -> Instagram
├── progress.json                  # auto-updated — current status
├── failed.csv                     # auto-updated — products that errored
├── lib/
│   ├── config.js                  # env + JSON config loader
│   ├── shopify.js                 # Shopify GraphQL client (client-credentials auth)
│   ├── analyzer.js                # Gemini vision — image -> attributes JSON
│   ├── description.js             # Gemini text — attributes -> final SEO copy
│   ├── processor.js               # batch loop, rate limiting, backup, tagging
│   └── util.js                    # retry/backoff, logging, CSV helpers
├── docs/
│   └── index.html                 # dashboard (host via GitHub Pages)
├── preview/                       # preview-mode output lands here
└── .github/workflows/
    ├── auto-process.yml           # manual + nightly cron run
    └── test.yml                   # simple connectivity test
```

---

## ज़रूरी सावधानियां

- हमेशा `preview` mode से नया category/collection शुरू करें।
- `config.json` में `daily_cap` और `delay_seconds` free-tier limits के हिसाब से रखें — असली limits [aistudio.google.com](https://aistudio.google.com) में अपनी key के अंतर्गत ज़रूर verify कर लें, यह बदलती रहती हैं।
- Public repo में कभी भी असली keys, `.env` file, या customer data push न करें (`.gitignore` में `.env` पहले से excluded है)।
- अगर कोई run 60 दिन तक न चले, GitHub public repos पर scheduled workflows अपने-आप बंद हो सकते हैं — रोज़ाना commit होने वाली `progress.json` इसे रोकती रहेगी, बस repo को पूरी तरह मत छोड़िए।
