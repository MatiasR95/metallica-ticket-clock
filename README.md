# Metallica ticket clock

Logs resale prices for Metallica's *Life Burns Faster* shows at Sphere, Las Vegas, every 30 minutes up to showtime.
The Nov 5 and Nov 7 2026 curves show how prices move in the last days. The Feb 4 and Feb 6 2027 data is for timing a purchase.

- `watch.mjs` reads public pages only, with an honest user-agent. It never logs in, buys anything or works around a captcha. Sources:
  - TrackaLacker: StubHub, SeatGeek, Viagogo, Vivid Seats and Gametime, plus each listing's change log.
  - TicketSmarter: section-by-section listings for single shows and the 2-day passes.
  - Vibee and SUPER: whether the official travel packages and enhanced experiences are on sale.
- `build.mjs` turns `data/` into the CSVs in `data/out/`. The focus zones are GA floor and sections 104–108 and 204–208. It also compares a 2-day pass with buying the two nights separately.
- `.github/workflows/clock.yml` runs `watch.mjs --part cloud` every 30 minutes. That covers TicketSmarter and SUPER. It then rebuilds the CSVs and commits them.
- TrackaLacker and Vibee refuse requests from GitHub's servers. `laptop.mjs` collects those two from Matías' laptop whenever it's on, writing only to `data/tl/` and `data/history.json`. It commits to the same repo, and the next cloud run folds that data in.
