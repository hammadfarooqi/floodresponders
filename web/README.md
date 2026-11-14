# Roll Call web

From `web/`, install dependencies with `npm ci` and run `npm run dev`. Next.js listens on port 3000 by default. Set `PORT` in your shell before starting it, for example `PORT=3001 npm run dev` in Bash or `$env:PORT = '3001'; npm run dev` in PowerShell.

When running against the API, copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_API_URL` to the API server origin, for example `http://localhost:8001`.

Without that URL, the 3D map shows six fictional buildings with scores out of 10. Scores are the product of mock exposure, evacuation difficulty, and urgency, scaled by 10. If the API returns building records, the map displays their geometry and leaves their scores blank until the scenario API supplies them. Rectangular footprints are used where the API provides no outline.

The dev and build scripts copy Cesium assets locally. No Cesium ion token, sponsor credentials, or database is needed to run the demo.

Run `npm run lint` and `npm run build` before opening a PR.
