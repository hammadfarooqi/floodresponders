# Roll Call web

From `web/`, install dependencies with `npm ci` and run `npm run dev`. Next.js listens on port 3000 by default. Set `PORT` in your shell before starting it, for example `PORT=3001 npm run dev` in Bash or `$env:PORT = '3001'; npm run dev` in PowerShell.

The 3D map reads six fictional buildings from `src/lib/demo-buildings.ts`. Scores out of 10 are the product of mock exposure, evacuation difficulty, and urgency, scaled by 10. Buildings without outlines use rectangular footprints. The demo runs without contacting the API, even if `NEXT_PUBLIC_API_URL` is set.

The dev and build scripts copy Cesium assets locally. No Cesium ion token, sponsor credentials, or database is needed to run the demo.

Run `npm run lint` and `npm run build` before opening a PR.
