#!/usr/bin/env bash
# One-time setup for the green route line inside the Matterport 3D tour (/interior and the /console layout panel).
# 1. Downloads the Matterport SDK Bundle (their viewer, about 27 MB) into explore/public/matterport-bundle/.
#    It is not in git: Matterport's licence covers it, and it is large.
# 2. Copies MATTERPORT_SDK_KEY from the repo's .env into explore/.env.local as NEXT_PUBLIC_MATTERPORT_SDK_KEY.
#    An SDK key is made for use in a browser (it goes into the viewer's URL). It works only on the domains its
#    owner allowed; localhost works with our key (checked 2026-11-14).
# Then start the dev server again. Run from any folder: explore/scripts/get_matterport_bundle.sh
set -euo pipefail
VERSION="26.5.4_webgl-708-g332adb66f5"
cd "$(dirname "$0")/.."

key=$(grep '^MATTERPORT_SDK_KEY=' ../.env | cut -d= -f2-)
[ -n "$key" ] || { echo "MATTERPORT_SDK_KEY is missing in $(cd .. && pwd)/.env" >&2; exit 1; }
touch .env.local
grep -v '^NEXT_PUBLIC_MATTERPORT_SDK_KEY=' .env.local > .env.local.tmp || true
echo "NEXT_PUBLIC_MATTERPORT_SDK_KEY=$key" >> .env.local.tmp
mv .env.local.tmp .env.local

if [ "$(cat public/matterport-bundle/version.txt 2>/dev/null)" != "$VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fL --progress-bar -o "$tmp/bundle.zip" "https://static.matterport.com/showcase-sdk/bundle/$VERSION/showcase-bundle.zip"
  rm -rf public/matterport-bundle
  mkdir -p public/matterport-bundle
  unzip -q "$tmp/bundle.zip" -d public/matterport-bundle
  rm -rf "$tmp"
fi
echo "Bundle $(cat public/matterport-bundle/version.txt) is in explore/public/matterport-bundle/ and the key is in explore/.env.local."
echo "Start the dev server again, then open /interior and the tab \"3D tour\"."
