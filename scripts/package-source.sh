#!/bin/sh

set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$root/package.json').version")
name="headless-mfa-$version"
archive="$root/dist/$name.tar.gz"

mkdir -p "$root/dist"
stage_root=$(mktemp -d "${TMPDIR:-/tmp}/headless-mfa-package.XXXXXX")
trap 'rm -rf "$stage_root"' EXIT HUP INT TERM

mkdir -p "$stage_root/$name"

tar \
  --exclude='./.agents' \
  --exclude='./.browsers' \
  --exclude='./.codex' \
  --exclude='./.git' \
  --exclude='./.state' \
  --exclude='./dist' \
  --exclude='./node_modules' \
  -cf "$stage_root/source.tar" \
  -C "$root" \
  .

tar -xf "$stage_root/source.tar" -C "$stage_root/$name"
tar -czf "$archive" -C "$stage_root" "$name"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$root/dist" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$root/dist" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
else
  printf '%s\n' 'Neither sha256sum nor shasum is available' >&2
  exit 1
fi

printf '%s\n' "$archive" "$archive.sha256"
