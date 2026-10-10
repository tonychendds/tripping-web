# Tripping (web)

A free trip itinerary. Open it at **https://tonychendds.github.io/tripping-web/**.

Until you sign in, everything you enter stays in this browser. The page says so. **Add trip** and **From screenshot** work without an account. A screenshot is read on this device and is not uploaded.

**Settings → Account** signs in with email and password. Trips then sync to `https://tripping-sync.tonychendds.workers.dev` and come back on another device signed in with the same email. The worker source is in `sync-worker/`. A copy you can deploy with Wrangler is `tripping-sync-worker.tar.gz` (created at deploy time from that folder). No passwords or database ids are stored in this repo.

A fresh visit starts with an empty itinerary. There is no published personal trip file. Do not put a real itinerary in the site files.

This repository holds the published website plus the sync worker. The default seed in `assets/index-m7Home27.js` is an empty `trips` array.

**Deals** opens pre-filled searches on Google Flights, Kayak (including Kayak Explore), and Skyscanner. The home airport defaults to SMF, with SFO one tap away.
