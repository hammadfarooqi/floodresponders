/** @type {import('next').NextConfig} */
// NEXT_DIST_DIR lets a production build (npm run demo) live next to the dev server's .next without breaking it.
const nextConfig = { reactStrictMode: false, distDir: process.env.NEXT_DIST_DIR || ".next" };
export default nextConfig;
