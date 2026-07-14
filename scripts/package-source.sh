#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/package.json').version")
name="headless-mfa-$version"
archive="$root/dist/$name.tar.gz"

mkdir -p "$root/dist"
tar \
  --exclude='./.agents' \
  --exclude='./.browsers' \
  --exclude='./.codex' \
  --exclude='./.git' \
  --exclude='./.state' \
  --exclude='./dist' \
  --exclude='./node_modules' \
  --transform "s,^\.,$name," \
  -czf "$archive" \
  -C "$root" \
  .

(cd "$root/dist" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
printf '%s\n' "$archive" "$archive.sha256"
