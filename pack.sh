#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")

sync_files() {
  echo "📦 Sync release/ (v${VERSION})..."

  # Remove symlinks
  rm -rf release/extensions release/skills release/prompts

  # Extensions: strip tests, docs, dev config
  rsync -a \
    --exclude='*.test.ts' \
    --exclude='vitest.config.ts' \
    --exclude='tsconfig.json' \
    --exclude='docs/' \
    --exclude='node_modules' \
    extensions/ release/extensions/

  rsync -a skills/ release/skills/
  cp -r prompts  release/prompts

  echo "✅ release/ ready"
}

restore_symlinks() {
  rm -rf release/extensions release/skills release/prompts
  ln -s ../extensions release/extensions
  ln -s ../skills     release/skills
  ln -s ../prompts    release/prompts
  echo "✅ symlinks restored"
}

case "${1:-sync}" in
  sync)    sync_files ;;
  clean)   restore_symlinks ;;
  release)
    sync_files
    echo ""
    echo "Next steps (inside release/):"
    echo "  git add -A"
    echo "  git commit -m \"Release v${VERSION}\""
    echo "  git tag v${VERSION}"
    echo "  git push origin main v${VERSION}"
    echo ""
    echo "Then: ./pack.sh clean"
    ;;
  *)
    echo "Usage: ./pack.sh {sync|release|clean}"
    ;;
esac
