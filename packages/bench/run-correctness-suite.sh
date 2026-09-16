#!/usr/bin/env bash
# Reproduces the correctness accuracy table from a clean checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm install
npm run build --workspaces --if-present
npm run correctness --workspace=packages/bench
