#!/usr/bin/env bash
# StaffPlusPRO Android ilovasini (APK) clinicuk24.com/ilova orqali tarqatish.
#
# Serverda, backend papkasida ishga tushiriladi:
#   scripts/release-android.sh <apk-fayl-yoki-URL> <versiya> <build> [--min <build>] [--notes "1-o'zgarish|2-o'zgarish"]
#
# Misollar:
#   scripts/release-android.sh ~/StaffPlusPRO.apk 1.0.0 1 --notes "Birinchi versiya"
#   scripts/release-android.sh https://expo.dev/artifacts/eas/xxx.apk 1.0.1 2 --min 1 --notes "Xatolar tuzatildi|GPS barqarorroq"
#
# --min: shundan eski build'lar ilovada "Yangilash majburiy" oynasini ko'radi
#        (masalan, backend API o'zgarganda). Berilmasa — avvalgi qiymat saqlanadi.
#
# Natija: app-releases/android/StaffPlusPRO-<versiya>-<build>.apk va latest.json
# (nginx: https://clinicuk24.com/app/android/…). Eski APK'lar o'chirilmaydi.
set -euo pipefail

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[ $# -ge 3 ] || usage

SRC="$1"; VERSION="$2"; BUILD="$3"; shift 3
MIN=""; NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --min) MIN="$2"; shift 2 ;;
    --notes) NOTES="$2"; shift 2 ;;
    *) echo "Noma'lum parametr: $1"; usage ;;
  esac
done

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Versiya formati: 1.2.3"; exit 1; }
[[ "$BUILD" =~ ^[0-9]+$ ]] || { echo "Build — butun son"; exit 1; }
[ -z "$MIN" ] || [[ "$MIN" =~ ^[0-9]+$ ]] || { echo "--min — butun son"; exit 1; }
command -v python3 >/dev/null || { echo "python3 kerak"; exit 1; }
if [ -n "$MIN" ] && [ "$MIN" -gt "$BUILD" ]; then
  echo "--min ($MIN) yangi build'dan ($BUILD) katta bo'lishi mumkin emas"; exit 1
fi

BASE_URL="${PUBLIC_WEB_URL:-https://clinicuk24.com}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/app-releases/android"
mkdir -p "$DIR"
NAME="StaffPlusPRO-${VERSION}-${BUILD}.apk"
TMP="$DIR/.${NAME}.part"
trap 'rm -f "$TMP"' EXIT

# Build raqami faqat oshishi kerak — aks holda ilovalar "yangi versiya"ni ko'rmaydi
if [ -f "$DIR/latest.json" ]; then
  PREV_BUILD=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["latest"]["build"])' "$DIR/latest.json" 2>/dev/null || echo 0)
  if [ "$BUILD" -le "$PREV_BUILD" ]; then
    echo "Build $BUILD ≤ joriy build $PREV_BUILD. Yangi build raqami kattaroq bo'lishi kerak."; exit 1
  fi
fi

if [[ "$SRC" =~ ^https?:// ]]; then
  echo "⬇  Yuklanmoqda: $SRC"
  curl -fL --retry 3 -o "$TMP" "$SRC"
else
  [ -f "$SRC" ] || { echo "Fayl topilmadi: $SRC"; exit 1; }
  cp "$SRC" "$TMP"
fi

# APK aslida ZIP — boshqa fayl (masalan, HTML xato sahifasi) yuklanib qolmasin
python3 - "$TMP" <<'PY'
import sys, zipfile
p = sys.argv[1]
if not zipfile.is_zipfile(p):
    sys.exit("Bu APK emas (ZIP formati emas)")
with zipfile.ZipFile(p) as z:
    if "AndroidManifest.xml" not in z.namelist():
        sys.exit("APK ichida AndroidManifest.xml yo'q")
PY

mv "$TMP" "$DIR/$NAME"
chmod 644 "$DIR/$NAME"
ln -sfn "$NAME" "$DIR/StaffPlusPRO-latest.apk"

python3 - "$DIR" "$NAME" "$VERSION" "$BUILD" "$MIN" "$NOTES" "$BASE_URL" <<'PY'
import hashlib, json, os, sys, datetime
d, name, version, build, min_b, notes, base = sys.argv[1:8]
path = os.path.join(d, name)
h = hashlib.sha256()
with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
manifest_path = os.path.join(d, "latest.json")
prev = {}
if os.path.exists(manifest_path):
    try:
        prev = json.load(open(manifest_path))
    except Exception:
        prev = {}
build = int(build)
prev_min = int(prev.get("minSupportedBuild") or 1)
min_supported = int(min_b) if min_b else prev_min
if min_supported > build:
    sys.exit("--min yangi build'dan katta bo'lishi mumkin emas")
data = {
    "platform": "android",
    "latest": {
        "version": version,
        "build": build,
        "url": f"{base}/app/android/{name}",
        "sha256": h.hexdigest(),
        "size": os.path.getsize(path),
        "publishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "notes": [n.strip() for n in notes.split("|") if n.strip()],
    },
    "minSupportedBuild": min_supported,
    "pageUrl": f"{base}/ilova",
}
tmp = manifest_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
os.chmod(tmp, 0o644)
os.replace(tmp, manifest_path)  # atomik: ilova yarim yozilgan faylni ko'rmaydi
print(f"✅ {name}  sha256={h.hexdigest()[:16]}…  minSupportedBuild={min_supported}")
PY

echo "🔗 ${BASE_URL}/app/android/${NAME}"
echo "📄 ${BASE_URL}/app/android/latest.json"
