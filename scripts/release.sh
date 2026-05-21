#!/usr/bin/env bash
# Crouton release script.
# Usage: npm run release -- <version>   (e.g. npm run release -- 0.5.3)
#
# What this does, in order:
#   1. Bumps version in package.json + package-lock.json + README.md
#   2. Builds the DMG (and the unpacked .app it depends on)
#   3. Commits, tags v<version>, pushes both
#   4. Creates a GitHub release with the DMG attached and auto-generated notes
#   5. Reinstalls /Applications/Crouton.app from the freshly built bundle
#
# Bail out at the first failure — we never want a half-released state.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: npm run release -- <version>   (e.g. 0.5.3)" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "Version '$VERSION' doesn't look like semver (e.g. 0.5.3 or 0.6.0-rc.1)." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Sanity: clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash changes first." >&2
  git status --short >&2
  exit 1
fi

# Sanity: tag doesn't already exist
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "Tag v$VERSION already exists." >&2
  exit 1
fi

echo "→ Bumping version to $VERSION"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
# Update the "**Version:** X.Y.Z" line in the README so the public docs match.
sed -i '' "s/^\*\*Version:\*\* .*/\*\*Version:\*\* $VERSION/" README.md

echo "→ Quitting any running Crouton instance"
pkill -f "Applications/Crouton.app/Contents/MacOS/Crouton" 2>/dev/null || true
sleep 1

echo "→ Building DMG (this takes a minute)"
rm -rf dist
npm run dist 2>&1 | grep -E "packaging|signing|building|notariz" || true

DMG="dist/Crouton-$VERSION-arm64.dmg"
if [ ! -f "$DMG" ]; then
  echo "Build failed: $DMG not found." >&2
  exit 1
fi

echo "→ Committing + tagging v$VERSION"
git add package.json package-lock.json README.md
git commit -q -m "v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push -q origin main
git push -q origin "v$VERSION"

echo "→ Generating release notes from commits since previous tag"
SHA=$(shasum -a 256 "$DMG" | awk '{print $1}')
SIZE=$(ls -lh "$DMG" | awk '{print $5}')
PREV_TAG=$(git tag --sort=-creatordate | grep -v "^v$VERSION\$" | head -1)
NOTES_FILE=$(mktemp)
{
  echo "## Changes since $PREV_TAG"
  echo
  git log "$PREV_TAG..HEAD^" --pretty='- %s' \
    | grep -vE "^- v[0-9]+\.[0-9]+\.[0-9]+\$" \
    || echo "- (no significant commits — see full diff in the repo)"
  echo
  echo "## Download"
  echo
  echo "| File | Size | SHA-256 |"
  echo "| --- | --- | --- |"
  echo "| \`$(basename "$DMG")\` | $SIZE | \`$SHA\` |"
  echo
  echo "**Apple Silicon only.**"
  echo
  echo "## Install"
  echo
  echo "Open the DMG → drag **Crouton.app** to Applications (replacing any previous build). If macOS blocks the launch, right-click → **Open**, or run \`xattr -dr com.apple.quarantine /Applications/Crouton.app\`."
  echo
  echo "See the [README](https://github.com/cheewee2000/crouton/blob/main/README.md) for first-time setup (Homebrew deps, HuggingFace token, etc.)."
} > "$NOTES_FILE"

echo "→ Creating GitHub release"
gh release create "v$VERSION" "$DMG" \
  --title "Crouton v$VERSION" \
  --notes-file "$NOTES_FILE"
rm -f "$NOTES_FILE"

echo "→ Reinstalling /Applications/Crouton.app from the v$VERSION build"
rm -rf /Applications/Crouton.app
cp -R "dist/mac-arm64/Crouton.app" /Applications/
open /Applications/Crouton.app

echo
echo "✅ Released v$VERSION"
echo "   https://github.com/cheewee2000/crouton/releases/tag/v$VERSION"
