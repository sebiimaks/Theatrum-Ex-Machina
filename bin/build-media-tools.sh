#!/bin/sh

set -eu

export LC_ALL=C
export TZ=UTC

media_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
media_project_dir=$(CDPATH= cd -- "$media_script_dir/.." && pwd)
media_output_dir=${MEDIA_OUTPUT_DIR:-"$media_project_dir/build/media-tools"}
media_source_dir=${MEDIA_SOURCE_OUTPUT_DIR:-"$media_project_dir/build/media-sources"}
media_legal_dir=${MEDIA_LEGAL_OUTPUT_DIR:-"$media_project_dir/build/media-legal"}
media_cache_dir=${MEDIA_SOURCE_CACHE_DIR:-"$media_project_dir/build/media-source-cache"}

ffmpeg_version=8.1.2
ffmpeg_archive="ffmpeg-$ffmpeg_version.tar.xz"
ffmpeg_url="https://ffmpeg.org/releases/$ffmpeg_archive"
ffmpeg_sha256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c

x264_commit=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
x264_archive="x264-$x264_commit.tar.gz"
x264_url="https://code.videolan.org/videolan/x264/-/archive/$x264_commit/$x264_archive"
x264_sha256=cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9

media_host_os=$(uname -s)
media_host_arch=$(uname -m)

case "$media_host_os:$media_host_arch" in
  Darwin:arm64)
    media_target=darwin-arm64
    media_minimum_os="macOS 12.0"
    media_cc=clang
    media_ffmpeg_target_args="--cc=clang --arch=arm64 --target-os=darwin"
    export MACOSX_DEPLOYMENT_TARGET=12.0
    ;;
  Linux:x86_64)
    media_target=linux-amd64
    media_minimum_os="glibc baseline of the native Debian build host"
    media_cc=cc
    media_ffmpeg_target_args="--cc=cc --arch=x86_64 --target-os=linux"
    ;;
  *)
    echo "Unsupported media-tool build host: $media_host_os $media_host_arch" >&2
    echo "Build natively on Apple Silicon macOS or amd64 Linux." >&2
    exit 1
    ;;
esac

for media_command in curl make pkg-config tar "$media_cc"; do
  if ! command -v "$media_command" >/dev/null 2>&1; then
    echo "Required build command is missing: $media_command" >&2
    exit 1
  fi
done

if [ "$media_host_os" = Linux ]; then
  for media_linux_command in nasm xz; do
    if ! command -v "$media_linux_command" >/dev/null 2>&1; then
      echo "Required Linux build command is missing: $media_linux_command" >&2
      exit 1
    fi
  done
fi

if [ "$media_host_os" = Darwin ]; then
  media_jobs=$(sysctl -n hw.ncpu)
else
  media_jobs=$(getconf _NPROCESSORS_ONLN)
fi

media_work_dir=$(mktemp -d "${TMPDIR:-/tmp}/theatrum-ex-machina-media.XXXXXX")
trap 'rm -rf "$media_work_dir"' EXIT HUP INT TERM

mkdir -p "$media_output_dir" "$media_source_dir" "$media_legal_dir" "$media_cache_dir"

media_checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

media_download() {
  media_download_url=$1
  media_download_sha=$2
  media_download_path=$3

  if [ -f "$media_download_path" ]; then
    media_actual_sha=$(media_checksum "$media_download_path")
    if [ "$media_actual_sha" != "$media_download_sha" ]; then
      rm -f "$media_download_path"
    fi
  fi

  if [ ! -f "$media_download_path" ]; then
    media_partial_path="$media_download_path.partial"
    rm -f "$media_partial_path"
    curl --fail --location --proto '=https' --tlsv1.2 \
      --retry 3 --output "$media_partial_path" "$media_download_url"
    media_partial_sha=$(media_checksum "$media_partial_path")
    if [ "$media_partial_sha" != "$media_download_sha" ]; then
      rm -f "$media_partial_path"
      echo "Downloaded source checksum mismatch: $media_download_url" >&2
      exit 1
    fi
    mv "$media_partial_path" "$media_download_path"
  fi

  media_actual_sha=$(media_checksum "$media_download_path")
  if [ "$media_actual_sha" != "$media_download_sha" ]; then
    echo "Source checksum mismatch: $media_download_path" >&2
    exit 1
  fi
}

media_download "$ffmpeg_url" "$ffmpeg_sha256" "$media_cache_dir/$ffmpeg_archive"
media_download "$x264_url" "$x264_sha256" "$media_cache_dir/$x264_archive"

cp "$media_cache_dir/$ffmpeg_archive" "$media_source_dir/$ffmpeg_archive"
cp "$media_cache_dir/$x264_archive" "$media_source_dir/$x264_archive"

tar -xf "$media_cache_dir/$ffmpeg_archive" -C "$media_work_dir"
tar -xf "$media_cache_dir/$x264_archive" -C "$media_work_dir"

media_prefix=/opt/theatrum-ex-machina-media
media_x264_stage="$media_work_dir/x264-stage"
media_ffmpeg_stage="$media_work_dir/ffmpeg-stage"
media_x264_source="$media_work_dir/x264-$x264_commit"
media_ffmpeg_source="$media_work_dir/ffmpeg-$ffmpeg_version"

(
  cd "$media_x264_source"
  CC="$media_cc" ./configure \
    --prefix="$media_prefix" \
    --enable-static \
    --enable-pic \
    --disable-cli \
    --disable-opencl \
    --disable-avs \
    --disable-swscale \
    --disable-lavf \
    --disable-ffms \
    --disable-gpac \
    --disable-lsmash
  make -s -j"$media_jobs"
  make -s install DESTDIR="$media_x264_stage"
)

(
  cd "$media_ffmpeg_source"
  env \
    PKG_CONFIG_LIBDIR="$media_x264_stage$media_prefix/lib/pkgconfig" \
    PKG_CONFIG_SYSROOT_DIR="$media_x264_stage" \
    ./configure \
      --prefix="$media_prefix" \
      $media_ffmpeg_target_args \
      --disable-autodetect \
      --disable-shared \
      --enable-static \
      --enable-pic \
      --enable-gpl \
      --enable-libx264 \
      --disable-debug \
      --disable-doc \
      --disable-ffplay \
      --disable-network \
      --pkg-config-flags=--static
  make -s -j"$media_jobs"
  make -s install DESTDIR="$media_ffmpeg_stage"
)

cp "$media_ffmpeg_stage$media_prefix/bin/ffmpeg" "$media_output_dir/ffmpeg"
cp "$media_ffmpeg_stage$media_prefix/bin/ffprobe" "$media_output_dir/ffprobe"
chmod 755 "$media_output_dir/ffmpeg" "$media_output_dir/ffprobe"

cp "$media_ffmpeg_source/COPYING.GPLv2" "$media_legal_dir/GPL-2.0-or-later.txt"
cp "$media_ffmpeg_source/LICENSE.md" "$media_legal_dir/FFMPEG-LICENSE.md"
cp "$media_x264_source/COPYING" "$media_legal_dir/X264-LICENSE.txt"

media_compiler_line=$($media_cc --version | sed -n '1p')
media_ffmpeg_configuration=$($media_output_dir/ffmpeg -version)

{
  printf '%s\n' "Theatrum Ex Machina media-tool build manifest"
  printf '%s\n' "Target: $media_target"
  printf '%s\n' "Minimum operating system: $media_minimum_os"
  printf '%s\n' "Compiler: $media_compiler_line"
  printf '%s\n' "FFmpeg source: $ffmpeg_url"
  printf '%s\n' "FFmpeg SHA-256: $ffmpeg_sha256"
  printf '%s\n' "x264 source: $x264_url"
  printf '%s\n' "x264 commit: $x264_commit"
  printf '%s\n' "x264 SHA-256: $x264_sha256"
  printf '%s\n' "Build script SHA-256: $(media_checksum "$media_script_dir/build-media-tools.sh")"
  printf '%s\n' "ffmpeg binary SHA-256: $(media_checksum "$media_output_dir/ffmpeg")"
  printf '%s\n' "ffprobe binary SHA-256: $(media_checksum "$media_output_dir/ffprobe")"
  printf '\n%s\n' "$media_ffmpeg_configuration"
} > "$media_output_dir/BUILD-MANIFEST.txt"

cp "$media_output_dir/BUILD-MANIFEST.txt" "$media_source_dir/BUILD-MANIFEST.txt"

echo "Built $media_target FFmpeg and FFprobe in $media_output_dir"
