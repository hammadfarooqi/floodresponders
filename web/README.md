# Roll Call web

From `web/`, install dependencies with `npm ci` and run `npm run dev`. Next.js listens on port 3000 by default. Set `PORT` in your shell before starting it, for example `PORT=3001 npm run dev` in Bash or `$env:PORT = '3001'; npm run dev` in PowerShell.

When running against the API, copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_API_URL` to the API server origin, for example `http://localhost:8001`.

Run `npm run lint` and `npm run build` before opening a PR.
