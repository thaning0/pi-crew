#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PACKAGE_NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
TARBALL="${PACKAGE_NAME}-${VERSION}.tgz"

# Create temp directory (auto-cleaned on exit)
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "📦 Packaging ${PACKAGE_NAME} v${VERSION}..."

# Copy project to temp dir, excluding:
#   - node_modules, .git, .vscode
#   - test files (*.test.ts, vitest.config.ts)
#   - docs (extensions/crew/docs/)
#   - prompts/ (we use prompts.for.pack instead)
#   - dev config (tsconfig.json is only for type-checking)
rsync -a \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.vscode' \
  --exclude='*.test.ts' \
  --exclude='vitest.config.ts' \
  --exclude='tsconfig.json' \
  --exclude='extensions/crew/docs/' \
  --exclude='prompts/' \
  --exclude='prompts.for.pack/' \
  --exclude='*.tgz' \
  --exclude='pack.sh' \
  --exclude='package-lock.json' \
  ./ "$TMPDIR/"

# Use prompts.for.pack as the prompts directory
cp -r prompts.for.pack "$TMPDIR/prompts"

# Run npm pack in the temp directory
(cd "$TMPDIR" && npm pack)

# Move tarball back to project root
mv "$TMPDIR/$TARBALL" ./

echo "✅ Created $TARBALL"
