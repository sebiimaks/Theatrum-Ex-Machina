# FFmpeg and x264 Notice

Theatrum Ex Machina includes separate `ffmpeg` and `ffprobe` command-line executables built from FFmpeg 8.1.2 and x264 commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`.

These executables are licensed under the GNU General Public License, version 2 or any later version. They are not relicensed under the MIT License that applies to Theatrum Ex Machina itself.

Release builds that distribute these executables must provide their exact corresponding source at the same download location. The release process creates a version-matched `theatrum-ex-machina-media-source-v<version>.tar.xz` archive containing the FFmpeg and x264 source archives, verified checksums, build manifest, licence texts, and complete build script. The matching source archive and checksum manifest are published beside each application binary on the same GitHub release page.

Anyone redistributing an application binary must preserve the applicable notices and provide the matching corresponding-source archive with equivalent access. A source archive from a different application or media-tool version is not a substitute.

Fork releases and source snapshots are available at:

https://github.com/sebiimaks/Theatrum-Ex-Machina/releases

FFmpeg project: https://ffmpeg.org/

x264 project: https://code.videolan.org/videolan/x264

No warranty is provided for these programs, to the extent permitted by law.
