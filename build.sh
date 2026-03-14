#!/usr/bin/env bash
echo "📦 Instalando yt-dlp..."
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/render/project/src/yt-dlp
chmod +x /opt/render/project/src/yt-dlp
echo "✅ yt-dlp instalado correctamente"
npm install
