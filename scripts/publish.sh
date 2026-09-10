#!/bin/bash
# Publish pi-graft to npm using a granular access token (bypasses the 2FA/OTP
# prompt). The token is used once from memory and never stored in the repo.
#
# Get a token at: npmjs.com → avatar → Access Tokens → Granular Access Token
# (pi-graft, Read and write, bypass 2FA). Revoke it afterwards if you like.
set -u
cd "$(dirname "$0")/.." || exit 1

read -s -p "Paste npm token (starts with npm_): " NPM_TOKEN; echo
if [ -z "$NPM_TOKEN" ]; then echo "no token given, aborting"; exit 1; fi

cleanup() { npm config delete '//registry.npmjs.org/:_authToken' >/dev/null 2>&1; unset NPM_TOKEN; }
trap cleanup EXIT

npm config set '//registry.npmjs.org/:_authToken' "$NPM_TOKEN"
npm publish
