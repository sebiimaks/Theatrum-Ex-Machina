#!/bin/sh

set -eu

source_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_project_dir=$(CDPATH= cd -- "$source_script_dir/.." && pwd)
source_input_dir=${MEDIA_SOURCE_OUTPUT_DIR:-"$source_project_dir/build/media-sources"}
source_legal_dir=${MEDIA_LEGAL_OUTPUT_DIR:-"$source_project_dir/build/media-legal"}
source_release_input=${1:-"$source_project_dir/release"}
source_platform_suffix=${2:-${MEDIA_SOURCE_PLATFORM_SUFFIX:-}}

if [ "$#" -gt 2 ]; then
  echo "Usage: $0 [release-directory] [platform-suffix]" >&2
  exit 1
fi

case "$source_platform_suffix" in
  '')
    source_archive_suffix=
    ;;
  -*|*-|*--*|*[!a-z0-9-]*)
    echo "Invalid media-source platform suffix: $source_platform_suffix" >&2
    echo "Use lowercase letters, digits, and single hyphens only." >&2
    exit 1
    ;;
  *)
    if [ "${#source_platform_suffix}" -gt 64 ]; then
      echo "Media-source platform suffix is longer than 64 characters." >&2
      exit 1
    fi
    source_archive_suffix="-$source_platform_suffix"
    ;;
esac

mkdir -p "$source_release_input"
source_release_dir=$(CDPATH= cd -- "$source_release_input" && pwd)
source_version=$(node -p "require('$source_project_dir/package.json').version")
source_archive_name="theatrum-ex-machina-media-source-v$source_version$source_archive_suffix.tar.xz"
source_work_dir=$(mktemp -d "${TMPDIR:-/tmp}/theatrum-ex-machina-source.XXXXXX")
source_stage_dir="$source_work_dir/theatrum-ex-machina-media-source-v$source_version$source_archive_suffix"

trap 'rm -rf "$source_work_dir"' EXIT HUP INT TERM

for source_required_file in \
  "$source_input_dir/ffmpeg-8.1.2.tar.xz" \
  "$source_input_dir/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz" \
  "$source_input_dir/BUILD-MANIFEST.txt" \
  "$source_legal_dir/GPL-2.0-or-later.txt" \
  "$source_legal_dir/FFMPEG-LICENSE.md" \
  "$source_legal_dir/X264-LICENSE.txt"; do
  if [ ! -f "$source_required_file" ]; then
    echo "Missing corresponding-source input: $source_required_file" >&2
    echo "Run npm run media:build first." >&2
    exit 1
  fi
done

mkdir -p "$source_stage_dir/sources" "$source_stage_dir/licenses" "$source_stage_dir/build-scripts"
cp "$source_input_dir/ffmpeg-8.1.2.tar.xz" "$source_stage_dir/sources/"
cp "$source_input_dir/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz" "$source_stage_dir/sources/"
cp "$source_input_dir/BUILD-MANIFEST.txt" "$source_stage_dir/"
cp "$source_legal_dir/GPL-2.0-or-later.txt" "$source_stage_dir/licenses/"
cp "$source_legal_dir/FFMPEG-LICENSE.md" "$source_stage_dir/licenses/"
cp "$source_legal_dir/X264-LICENSE.txt" "$source_stage_dir/licenses/"
cp "$source_script_dir/build-media-tools.sh" "$source_stage_dir/build-scripts/"

(
  cd "$source_work_dir"
  tar -cJf "$source_release_dir/$source_archive_name" "$(basename "$source_stage_dir")"
)

echo "Created corresponding-source archive: $source_release_dir/$source_archive_name"
