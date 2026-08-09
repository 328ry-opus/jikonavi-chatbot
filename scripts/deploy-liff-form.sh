#!/bin/bash
# Deploy liff-form.html to jiko-navi.jp (sakura) via FTP.
# The LIFF endpoint URL points to https://jiko-navi.jp/liff-form.html,
# so a git push alone does NOT update the live form — run this after commit.
set -euo pipefail

CRED_FILE="$HOME/Desktop/仕事/Opus.net/事故なび事業/サーバー情報/事故なびFTP情報.txt"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

FTP_HOST=$(grep "^Host" "$CRED_FILE" | sed 's/.*[:：]//' | tr -d ' \r')
FTP_ID=$(grep "^ID" "$CRED_FILE" | sed 's/.*[:：]//' | tr -d ' \r')
FTP_PW=$(grep "^PW" "$CRED_FILE" | sed 's/.*[:：]//' | tr -d ' \r')

curl -s --ftp-ssl --user "${FTP_ID}:${FTP_PW}" \
  -T "${REPO_DIR}/liff-form.html" \
  "ftp://${FTP_HOST}/www/liff-form.html"

echo "uploaded. verifying..."
sleep 2
if curl -s "https://jiko-navi.jp/liff-form.html" | grep -q "2011041230-1Cb2lg53"; then
  echo "OK: https://jiko-navi.jp/liff-form.html serves the current form"
else
  echo "WARNING: LIFF ID not found in served page — check manually" >&2
  exit 1
fi
