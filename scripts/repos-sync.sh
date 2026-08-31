#!/usr/bin/env bash
# Refresh the vendored reference sources under repos/.
#
# These are git subtrees, committed on purpose: a fresh clone hands a coding
# agent the real source of the libraries this project is built on, which it
# reads far better than it reads documentation. They are reference material
# only - nothing here is imported by application code.
#
# Keep repos/effect on the same line as the `effect` dependency in
# packages/*/package.json. Vendoring a branch that does not match the
# installed version is worse than not vendoring at all.
set -euo pipefail

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty; git subtree pull needs a clean tree" >&2
  exit 1
fi

sync() {
  local prefix="$1" url="$2" branch="$3"
  echo ">>> $prefix <- $url#$branch"
  git subtree pull --prefix="$prefix" "$url" "$branch" --squash
}

sync repos/effect                 https://github.com/Effect-TS/effect.git                 main
sync repos/workers-oauth-provider https://github.com/cloudflare/workers-oauth-provider.git main
sync repos/workers-sdk            https://github.com/cloudflare/workers-sdk.git            main
