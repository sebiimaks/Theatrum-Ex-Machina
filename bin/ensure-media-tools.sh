#!/bin/sh

set -eu

ensure_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ensure_project_dir=$(CDPATH= cd -- "$ensure_script_dir/.." && pwd)
ensure_output_dir=${MEDIA_OUTPUT_DIR:-"$ensure_project_dir/build/media-tools"}
ensure_source_dir=${MEDIA_SOURCE_OUTPUT_DIR:-"$ensure_project_dir/build/media-sources"}
ensure_legal_dir=${MEDIA_LEGAL_OUTPUT_DIR:-"$ensure_project_dir/build/media-legal"}
ensure_manifest="$ensure_output_dir/BUILD-MANIFEST.txt"

ensure_checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

ensure_valid=true
for ensure_required_file in \
  "$ensure_output_dir/ffmpeg" \
  "$ensure_output_dir/ffprobe" \
  "$ensure_manifest" \
  "$ensure_source_dir/ffmpeg-8.1.2.tar.xz" \
  "$ensure_source_dir/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz" \
  "$ensure_legal_dir/GPL-2.0-or-later.txt" \
  "$ensure_legal_dir/FFMPEG-LICENSE.md" \
  "$ensure_legal_dir/X264-LICENSE.txt"; do
  if [ ! -s "$ensure_required_file" ]; then
    ensure_valid=false
  fi
done

if [ "$ensure_valid" = true ]; then
  ensure_expected_script_sha=$(sed -n 's/^Build script SHA-256: //p' "$ensure_manifest")
  ensure_actual_script_sha=$(ensure_checksum "$ensure_script_dir/build-media-tools.sh")
  if [ "$ensure_expected_script_sha" != "$ensure_actual_script_sha" ]; then
    ensure_valid=false
  fi
fi

if [ "$ensure_valid" = true ]; then
  ensure_version=$($ensure_output_dir/ffmpeg -version 2>/dev/null || true)
  case "$ensure_version" in
    *"ffmpeg version 8.1.2"*"--enable-gpl"*"--enable-libx264"*"--enable-zlib"*) ;;
    *) ensure_valid=false ;;
  esac
fi

if [ "$ensure_valid" = true ]; then
  if ! "$ensure_output_dir/ffmpeg" -hide_banner -decoders 2>/dev/null | \
    awk '$2 == "png" { found = 1 } END { exit !found }'; then
    ensure_valid=false
  fi
fi

if [ "$ensure_valid" = true ]; then
  echo "Using verified existing fork-built FFmpeg tools."
else
  sh "$ensure_script_dir/build-media-tools.sh"
fi
