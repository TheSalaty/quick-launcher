#!/usr/bin/env bash
# Compiles the TypeScript sources and assembles the extension in dist/.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
node_modules/.bin/tsc -p .
cp src/metadata.json src/stylesheet.css dist/
mkdir -p dist/schemas
cp src/schemas/*.gschema.xml dist/schemas/
glib-compile-schemas --strict dist/schemas
