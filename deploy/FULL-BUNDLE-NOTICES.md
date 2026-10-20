
## Fully offline release bundle (`*-full.tar.gz`): bundled binaries

The "full" release file ships two third-party programs so that the server needs no internet and no package manager.
They are separate programs started by the app; they are not linked into NoSignal, whose own code stays MIT.

### Node.js (MIT)
- Official linux-x64 binary from https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz
- SHA256 of that tarball: `cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008` (verified against nodejs.org SHASUMS256.txt at build time).
- Only `bin/node` and its LICENSE are included (`LICENSES/node-LICENSE`). Source: https://github.com/nodejs/node/tree/v24.22.0

### FFmpeg + ffprobe (LGPL build)
- Static linux-x64 build by BtbN: https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/ffmpeg-n8.1.3-18-g46d899d7a0-linux64-lgpl-8.1.tar.xz
  (FFmpeg n8.1.3, git g46d899d7a0; build recipes: https://github.com/BtbN/FFmpeg-Builds).
- SHA256 of that tarball: `6369d7e2e647d3b467ba01b5779f211fb45acf5895a15514e0426f959d3563b4`.
- This is the "lgpl" variant: configured with `--enable-version3` but **without** `--enable-gpl` and `--enable-nonfree` (check with `bin/ffmpeg -buildconf`). FFmpeg and the bundled libraries are licensed under the GNU Lesser General Public License (LGPL), version 3 or later where `--enable-version3` applies (FFmpeg itself is LGPL-2.1-or-later). The licence text is in `LICENSES/ffmpeg-LICENSE.txt`. It contains no libx264 or libx265; H.264 is encoded with Cisco's OpenH264 (BSD-2-Clause), VP8/VP9 with libvpx (BSD-3-Clause) and WebP with libwebp (BSD-3-Clause).
- Only `ffmpeg` and `ffprobe` are included, unmodified, as separate executables. NoSignal starts them as external processes (video/GIF conversion and probing) and does not link them. You may replace them with any other FFmpeg build (put your own `ffmpeg`/`ffprobe` in `bin/`, or install the distribution package and delete `bin/ffmpeg*`).
- Source code: the complete corresponding source of FFmpeg n8.1.3 is at https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz (git tag n8.1.3: https://git.ffmpeg.org/ffmpeg.git), and the exact recipes and source versions of every bundled library are in the BtbN repository and release above. On request to the project maintainers (via the public repository issue tracker) we will also provide the source archives for the shipped build for at least three years after the release date.
- OpenH264 note: the H.264 patent licence offered by Cisco covers only Cisco's own binaries; this build compiles OpenH264 itself. Operators in regions where H.264 needs a patent licence are responsible for it.
