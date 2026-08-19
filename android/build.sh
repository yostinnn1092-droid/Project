#!/usr/bin/env bash
# Build the Kinesis APK.
#
# Deliberately no Gradle: the app is one Java file wrapping one HTML asset, and
# the Android Gradle Plugin would pull a dependency tree larger than the whole
# game to do the same aapt2/d8/apksigner sequence this script runs directly.
#
#   ./android/build.sh          -> android/build/kinesis.apk
#
# Needs: JDK, and an Android SDK with build-tools 34.0.0 + platform 34.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
OUT="$HERE/build"

for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$PLATFORM"; do
  [ -e "$f" ] || { echo "missing: $f (set ANDROID_HOME)" >&2; exit 1; }
done

# Rebuild the bundle first. The APK embeds a copy, and shipping one built from
# a stale kinesis3d.html is the one failure this script can silently cause.
echo "==> building game bundle"
( cd "$ROOT/game" && node build.mjs ../kinesis3d.html >/dev/null )

rm -rf "$OUT/compiled" "$OUT/gen" "$OUT/classes" "$OUT/assets" \
       "$OUT/base.apk" "$OUT/aligned.apk" "$OUT/classes.dex"
mkdir -p "$OUT/compiled" "$OUT/gen" "$OUT/classes" "$OUT/assets"
cp "$ROOT/kinesis3d.html" "$OUT/assets/kinesis3d.html"

echo "==> resources"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/compiled/res.zip"
"$BT/aapt2" link \
  -I "$PLATFORM" \
  --manifest "$HERE/AndroidManifest.xml" \
  -A "$OUT/assets" \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  -o "$OUT/base.apk" \
  "$OUT/compiled/res.zip"

echo "==> java"
javac -nowarn -source 11 -target 11 -classpath "$PLATFORM" -d "$OUT/classes" \
  $(find "$HERE/java" "$OUT/gen" -name '*.java')

echo "==> dex"
"$BT/d8" --lib "$PLATFORM" --min-api 24 --output "$OUT" \
  $(find "$OUT/classes" -name '*.class')

( cd "$OUT" && "$BT/aapt" add -f base.apk classes.dex >/dev/null )

echo "==> sign"
# A local debug key. Regenerating it changes the signature, and Android refuses
# to install over an existing app signed by a different key — so it is kept
# between builds rather than made fresh each time.
KS="$OUT/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -storepass android -keypass android \
    -alias kinesis -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Kinesis, O=Kinesis, C=ID" >/dev/null 2>&1
fi

"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias kinesis --out "$OUT/kinesis.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/kinesis.apk" | head -3

echo
echo "==> $OUT/kinesis.apk  ($(du -h "$OUT/kinesis.apk" | cut -f1))"
