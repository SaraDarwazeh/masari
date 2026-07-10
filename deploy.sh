#!/usr/bin/env bash
# نشر "مصاري" (Docker: Node + SQLite) على الـVPS — عدّلي المتغيرات مرة وحدة:
set -euo pipefail

VPS_USER="${VPS_USER:-root}"            # اسم المستخدم على السيرفر
VPS_HOST="${VPS_HOST:-your-vps-ip}"     # عنوان السيرفر أو الدومين
VPS_PATH="${VPS_PATH:-/opt/masari}"     # المسار اللي رح يتنصب فيه المشروع

cd "$(dirname "$0")"

echo "⏫ رفع الملفات إلى $VPS_USER@$VPS_HOST:$VPS_PATH ..."
rsync -avz --delete --exclude node_modules --exclude .env \
  public server Dockerfile docker-compose.yml .env.example \
  "$VPS_USER@$VPS_HOST:$VPS_PATH/"

echo "🚀 تشغيل/تحديث الكونتينر على السيرفر..."
ssh "$VPS_USER@$VPS_HOST" "
  set -e
  cd $VPS_PATH
  if [ ! -f .env ]; then
    cp .env.example .env
    echo '⚠️  أنشأت .env جديد بقيم افتراضية — لازم تدخلي عليه وتغيّري SESSION_SECRET قبل ما تكملي!'
  fi
  docker compose up -d --build
"

echo "✅ تم رفع الكود وتشغيل الكونتينر."
echo "   - أول مرة: افتحي الرابط وسجّلي رمز دخول (٦ أرقام) من شاشة الإعداد."
echo "   - لازم يكون في nginx (أو Caddy) قدام الكونتينر بيعمل HTTPS reverse proxy — شوفي README.md."
echo "   - بعدين من Safari على الآيفون: مشاركة ← Add to Home Screen."
