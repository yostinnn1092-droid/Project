#!/usr/bin/env bash
# Install the /watch skill (bradautomates/claude-video) on Ubuntu/Debian.
set -euo pipefail

echo "==> installing system dependencies"
sudo apt-get update -qq
sudo apt-get install -y ffmpeg python3 python3-pip git curl

echo "==> installing yt-dlp (binary; apt's copy is usually too old for YouTube)"
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
     -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

echo "==> cloning the skill"
mkdir -p ~/.claude/skills
rm -rf ~/claude-video
git clone --depth 1 https://github.com/bradautomates/claude-video.git ~/claude-video
ln -sfn ~/claude-video/skills/watch ~/.claude/skills/watch

echo "==> running setup"
python3 ~/claude-video/skills/watch/scripts/setup.py || true

echo
echo "==> versions"
ffmpeg -version | head -1
yt-dlp --version
echo "skill: $(readlink -f ~/.claude/skills/watch)"
echo
echo "Done. Update later with: git -C ~/claude-video pull"
