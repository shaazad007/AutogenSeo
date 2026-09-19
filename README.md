# Shopify Cloth AI Automation

Aap ke Shopify store ke purane ~80,000 products ki title, description, meta
description, tags aur image alt text ko Google Gemini AI se roz thora-thora
(default: 1,000/din) khud behtar karne wala system. Sirf aap ke apne store
ke liye — koi embedded app, koi public OAuth login screen nahi.

---

## Pehle yeh samajh lein

- Yeh GitHub Actions par roz raat ko khud chalta hai — aap ka laptop band ho tab bhi.
- Fabric ka naam image se nahi gharha jata — sirf agar purani title/description mein pehle se ho, tabhi.
- Designer aur model/celebrity ke naam sirf `designers.json` / `models.json` se aate hain — AI kabhi andaza nahi lagata.
- Product ka URL/handle kabhi nahi badalta (SEO ke liye zaroori hai).
- Har product ki purani description apne-aap ek metafield mein backup ho jati hai, isliye wapas bhi jaya ja sakta hai.
- **`preview` mode se hamesha shuru karein** — yeh sirf `/preview` folder mein files likhta hai, Shopify mein kuch nahi badalta.

---

## Setup — Step by Step

### A) Gemini API Key

1. [aistudio.google.com](https://aistudio.google.com) par apne Google account se login karein.
2. **"Get API Key"** par click karke key copy karein.

### B) Shopify Custom App banana (Client Credentials tareeqa — koi OAuth popup nahi)

1. Shopify Admin → **Settings → Apps and sales channels → Develop apps** → **Create an app**.
2. Configuration mein scopes dein: `read_products`, `write_products` (image alt text ke liye zaroorat pare to `write_files`/`write_media` bhi).
3. **Client credentials** section se **Client ID** aur **Client Secret** copy karein.
4. App ko apne hi store par install karein (Distribution: yeh pehle se aap ke store ke liye hi hota hai).

> Code har baar in dono se khud access token bana leta hai (`grant_type=client_credentials`) — isme koi browser "Authorize this app?" wali screen nahi aati, yeh server-to-server hai.

### C) GitHub par Repo banana

1. [github.com](https://github.com) par free account banayein.
2. **New repository** → naam `shopify-cloth-ai`, **Public** chunein (free minutes zyada milte hain).
3. Yeh sare files (jo aap ko mile hain) us repo mein upload kar dein — folder structure bilkul waise hi rakhein (zip ko pehle extract karke, folder/files upload karein — zip file ko waise hi upload na karein).
4. **Settings → Secrets and variables → Actions → New repository secret** — yeh 4 secrets banayein:

   | Name | Value |
   |---|---|
   | `SHOPIFY_STORE` | `aapkastore.myshopify.com` |
   | `SHOPIFY_CLIENT_ID` | (B se) |
   | `SHOPIFY_CLIENT_SECRET` | (B se) |
   | `GEMINI_API_KEY` | (A se) |

   **Keys kabhi bhi chat mein, code mein, ya kisi file mein hardcode na karein — hamesha Secrets mein hi.**

### D) Pehla Test

1. Repo ke **Actions** tab mein jayein. Agar **"Test"** workflow nahi dikh rahi, kuch seconds wait karein (GitHub ko nayi repo ke workflows index karne mein thora waqt lagta hai).
2. **"Test"** workflow chunein → **Run workflow** → 1-2 minute mein green ✅ tick aana chahiye. Isse pata chalega Actions chal raha hai.
3. Ab **"Auto Process Products"** workflow chunein → **Run workflow** → `mode: preview`, `limit: 10` rakhein → Run karein.
4. Run pura hone par repo ke `/preview` folder mein 10 `.txt` files ban jayengi — har ek mein nayi title, description, meta, tags, alt text. **Inhein parh kar check karein.**
5. Santusht hone ke baad, `mode: live`, `limit: 10` se ek chota asli test chalayein aur Shopify Admin mein jakar 1-2 products khud dekh lein.
6. Sab theek lage to nightly automatic run (`0 21 * * *` UTC, yani roz raat) apne-aap chalti rahegi — kuch karne ki zaroorat nahi.

---

## Rozana Progress kahan dekhein

- **GitHub → Actions tab**: har run ka pura log (kitne products hue, koi fail hua ya nahi).
- **Dashboard**: `docs/index.html` ko GitHub Pages par publish karein (repo **Settings → Pages → Source: main branch, /docs folder**) — phir ek link milega jahan professional dashboard dikhega: total progress, aaj ka batch, ETA days, live-jaisa activity log, failed items list. Isse kholne se pehle `docs/index.html` mein `GITHUB_REPO` constant apne asli `username/repo` se badal dein.
- **Shopify Admin**: processed products par `ai-done` tag lag jata hai, filter karke gin sakte hain.
- `progress.json` aur `failed.csv` repo ki root mein hamesha latest sthiti rakhte hain.

---

## Config Files (bezijhak GitHub par edit karein)

- **`config.json`** — AI kya detect kare (`detect`), tone rules (`extra_rules`), banned phrases, brand name/link, daily cap, delay, Gemini model names, collection filter. Doosri category (jaise electronics) ke liye bas `detect` badal dein, ya iski ek copy (`electronics-config.json`) banakar code mein select karne ki suvidha jori ja sakti hai.
- **`designers.json`** — designer ka naam, use pehchanne wale keywords (`match`), collection link, Instagram. Isme placeholder example hai — ise apne asli designers se bharein/mitayein.
- **`models.json`** — model/celebrity ka naam + Instagram, sirf yahan maujood naam hi description mein ayenge.

### Collections ka order kaise set karein

`config.json` mein `collection_filter` ek **ordered list** hai:

```json
"collection_filter": []
```

- **Khali `[]`** rakhein → poora catalog process hoga, koi particular collection-order nahi (jo bhi product ID ke hisab se mile).
- **Collection handles list mein order se daal dein** → system pehli collection ko **pura khatam** karega (ya us run ki `limit` tak pahunch jaye), tabhi doosri collection shuru hogi:
  ```json
  "collection_filter": ["new-arrivals", "eid-collection", "winter-sale"]
  ```
  Yahan pehle `new-arrivals` ke saare products hongे, phir `eid-collection`, phir `winter-sale`.

**Collection ka "handle" kahan se milega:** Shopify Admin → Products → Collections → us collection ko kholein → browser ke URL mein `.../collections/XXXXX` wala hissa hi handle hai।

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
├── preview/                       # preview-mode output yahan aata hai
└── .github/workflows/
    ├── auto-process.yml           # manual + nightly cron run
    └── test.yml                   # simple connectivity test
```

---

## Zaroori Ehtiyaat

- Hamesha `preview` mode se naya category/collection shuru karein.
- `config.json` mein `daily_cap` aur `delay_seconds` free-tier limits ke hisab se rakhein — asli limits [aistudio.google.com](https://aistudio.google.com) mein apni key ke andar zaroor verify kar lein, yeh badalti rehti hain.
- Public repo mein kabhi bhi asli keys, `.env` file, ya customer data push na karein (`.gitignore` mein `.env` pehle se excluded hai).
- Agar koi run 60 din tak na chale, GitHub public repos par scheduled workflows apne-aap band ho sakte hain — rozana commit hone wali `progress.json` ise rokti rahegi, bas repo ko puri tarah mat chorhiye.
