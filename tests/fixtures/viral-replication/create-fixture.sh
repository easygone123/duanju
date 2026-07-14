#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly OUTPUT_PATH="${SCRIPT_DIR}/three-scenes.mp4"

ffmpeg \
  -hide_banner \
  -loglevel error \
  -y \
  -f lavfi -i "color=c=red:s=320x180:r=30:d=5" \
  -f lavfi -i "color=c=white:s=320x180:r=30:d=5" \
  -f lavfi -i "color=c=blue:s=320x180:r=30:d=5" \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" \
  -c:v mpeg4 \
  -q:v 3 \
  -movflags +faststart \
  "${OUTPUT_PATH}"
