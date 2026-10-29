#!/bin/sh
# Run inside a fresh Debian amd64 container, with the package mounted read-only.
set -eu

package_path=${1:?Usage: verify-debian-install.sh /absolute/path/to/package.deb}
case "$package_path" in
  /*) ;;
  *) echo 'The package path must be absolute.' >&2; exit 1 ;;
esac
test -f "$package_path"
test "$(dpkg --print-architecture)" = amd64
test "$(dpkg-deb --field "$package_path" Package)" = theatrum-ex-machina
test "$(dpkg-deb --field "$package_path" Architecture)" = amd64
expected_version=$(dpkg-deb --field "$package_path" Version)

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Install only the package and its declared dependencies before checking linkage.
apt-get install --yes --no-install-recommends "$package_path"
test "$(dpkg-query --show --showformat='${Version}' theatrum-ex-machina)" = "$expected_version"
test "$(dpkg-query --show --showformat='${Architecture} ${Status}' theatrum-ex-machina)" = 'amd64 install ok installed'

app_root='/opt/Theatrum Ex Machina'
for binary in \
  "$app_root/theatrum-ex-machina" \
  "$app_root/chrome-sandbox" \
  "$app_root/chrome_crashpad_handler" \
  "$app_root"/*.so* \
  "$app_root/resources/media-tools/ffmpeg" \
  "$app_root/resources/media-tools/ffprobe"
do
  test -f "$binary"
  linkage=$(ldd "$binary")
  printf '%s\n%s\n' "$binary" "$linkage"
  if printf '%s\n' "$linkage" | grep -q 'not found'; then
    echo 'The package did not install all required runtime libraries.' >&2
    exit 1
  fi
done
"$app_root/resources/media-tools/ffmpeg" -version
"$app_root/resources/media-tools/ffprobe" -version

# Add display-test tools only after the dependency-only linkage check has passed.
apt-get install --yes --no-install-recommends xvfb xauth
useradd --create-home --shell /bin/sh theatrum-test
smoke_directory=$(mktemp -d)
chown theatrum-test:theatrum-test "$smoke_directory"
smoke_log="$smoke_directory/startup.log"
if ! runuser -u theatrum-test -- env \
  THEATRUM_PACKAGED_SMOKE_TEST=1 \
  XDG_CACHE_HOME="$smoke_directory/cache" \
  XDG_CONFIG_HOME="$smoke_directory/config" \
  XDG_DATA_HOME="$smoke_directory/data" \
  PORTABLE_EXECUTABLE_DIR="$smoke_directory" \
  timeout 45s xvfb-run -a --server-args='-screen 0 1280x800x24' \
  "$app_root/theatrum-ex-machina" --no-sandbox --disable-gpu \
  > "$smoke_log" 2>&1
then
  cat "$smoke_log"
  exit 1
fi
cat "$smoke_log"
grep -q 'THEATRUM_PACKAGED_SMOKE_READY' "$smoke_log"
printf '%s\n' 'Clean Debian installation, runtime linkage, media tools and startup verified.'
