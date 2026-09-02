#!/usr/bin/env bash
# Build the Kinesis app.
#
#   ./android/build.sh          -> android/build/kinesis.apk   (sideload / testing)
#   ./android/build.sh --aab    -> android/build/kinesis.aab   (Play Store upload)
#
# Deliberately no Gradle: the app is one Java file wrapping one HTML asset, and
# the Android Gradle Plugin would pull a dependency tree larger than the whole
# game to do the same aapt2/d8/apksigner sequence this script runs directly.
# The AAB path adds bundletool to that list and nothing else.
#
# Needs: JDK, and an Android SDK with build-tools 34.0.0 + platform 34.
# --aab additionally needs bundletool (see README).
set -euo pipefail

MODE="apk"
[ "${1:-}" = "--aab" ] && MODE="aab"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
OUT="$HERE/build"

for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$PLATFORM"; do
  [ -e "$f" ] || { echo "missing: $f (set ANDROID_HOME)" >&2; exit 1; }
done

# bundletool is not part of the SDK and is 32MB, so it is not vendored here.
if [ "$MODE" = "aab" ]; then
  BUNDLETOOL="${BUNDLETOOL:-/opt/bundletool/bundletool.jar}"
  if [ ! -e "$BUNDLETOOL" ]; then
    echo "missing bundletool: $BUNDLETOOL" >&2
    echo "  curl -sSL -o bundletool.jar https://github.com/google/bundletool/releases/download/1.17.2/bundletool-all-1.17.2.jar" >&2
    echo "  then set BUNDLETOOL=/path/to/bundletool.jar" >&2
    exit 1
  fi
fi

# Rebuild the bundle first. The package embeds a copy, and shipping one built
# from a stale kinesis3d.html is the one failure this script can silently cause.
echo "==> building game bundle"
( cd "$ROOT/game" && node build.mjs ../kinesis3d.html >/dev/null )

rm -rf "$OUT/compiled" "$OUT/gen" "$OUT/classes" "$OUT/assets" \
       "$OUT/base.apk" "$OUT/aligned.apk" "$OUT/classes.dex" \
       "$OUT/proto.apk" "$OUT/module" "$OUT/base.zip"
mkdir -p "$OUT/compiled" "$OUT/gen" "$OUT/classes" "$OUT/assets"
cp "$ROOT/kinesis3d.html" "$OUT/assets/kinesis3d.html"

echo "==> resources"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/compiled/res.zip"

# An APK carries resources.arsc in binary form; a bundle carries resources.pb in
# protobuf, with the manifest in protobuf too. That single flag is the whole
# difference at this stage — everything downstream diverges only in how the
# pieces are wrapped.
LINK_OUT="$OUT/base.apk"
PROTO=()
if [ "$MODE" = "aab" ]; then
  LINK_OUT="$OUT/proto.apk"
  PROTO=(--proto-format)
fi

"$BT/aapt2" link \
  -I "$PLATFORM" \
  --manifest "$HERE/AndroidManifest.xml" \
  -A "$OUT/assets" \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  "${PROTO[@]}" \
  -o "$LINK_OUT" \
  "$OUT/compiled/res.zip"

echo "==> java"
javac -nowarn -source 11 -target 11 -classpath "$PLATFORM" -d "$OUT/classes" \
  $(find "$HERE/java" "$OUT/gen" -name '*.java')

echo "==> dex"
"$BT/d8" --lib "$PLATFORM" --min-api 24 --output "$OUT" \
  $(find "$OUT/classes" -name '*.class')

# ── the signing key ─────────────────────────────────────────────────────────
# The APK is signed with a throwaway local key: it only has to install on a
# phone that has allowed unknown sources. Play is different — it identifies
# your app BY the key forever, so a release build takes one you supply through
# the environment and this script never invents one.
KS="$OUT/debug.keystore"
if [ ! -f "$KS" ]; then
  # Kept between builds rather than made fresh: regenerating changes the
  # signature, and Android refuses to install over an app signed by another key.
  keytool -genkeypair -v -keystore "$KS" -storepass android -keypass android \
    -alias kinesis -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Kinesis, O=Kinesis, C=ID" >/dev/null 2>&1
fi

if [ "$MODE" = "apk" ]; then
  echo "==> package"
  ( cd "$OUT" && "$BT/aapt" add -f base.apk classes.dex >/dev/null )

  echo "==> sign"
  "$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
  "$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
    --ks-key-alias kinesis --out "$OUT/kinesis.apk" "$OUT/aligned.apk"
  "$BT/apksigner" verify --print-certs "$OUT/kinesis.apk" | head -3

  echo
  echo "==> $OUT/kinesis.apk  ($(du -h "$OUT/kinesis.apk" | cut -f1))"
  exit 0
fi

# ── AAB ─────────────────────────────────────────────────────────────────────
# bundletool takes a zip per module laid out in its own shape, which is NOT the
# shape aapt2 emits: the manifest moves under manifest/, the dex under dex/,
# and res/ + assets/ + resources.pb stay at the root. The module's NAME comes
# from the zip's filename, so this one has to be base.zip.
echo "==> module"
mkdir -p "$OUT/module"
( cd "$OUT/module" && unzip -qo "$OUT/proto.apk" )
mkdir -p "$OUT/module/manifest" "$OUT/module/dex"
mv "$OUT/module/AndroidManifest.xml" "$OUT/module/manifest/AndroidManifest.xml"
cp "$OUT/classes.dex" "$OUT/module/dex/classes.dex"
( cd "$OUT/module" && zip -qr "$OUT/base.zip" . )

echo "==> bundle"
rm -f "$OUT/kinesis.aab"
java -jar "$BUNDLETOOL" build-bundle \
  --modules="$OUT/base.zip" \
  --output="$OUT/kinesis.aab"

echo "==> sign"
# An AAB is a jar, so it is signed with jarsigner — apksigner does not handle
# bundles. Play re-signs the APKs it generates with the app signing key; this
# signature is only the upload credential.
if [ -n "${KINESIS_KEYSTORE:-}" ]; then
  jarsigner -keystore "$KINESIS_KEYSTORE" \
    -storepass "${KINESIS_KS_PASS:?set KINESIS_KS_PASS}" \
    -keypass "${KINESIS_KEY_PASS:-${KINESIS_KS_PASS}}" \
    -digestalg SHA-256 -sigalg SHA256withRSA \
    "$OUT/kinesis.aab" "${KINESIS_KEY_ALIAS:?set KINESIS_KEY_ALIAS}" >/dev/null
  echo "    signed with $KINESIS_KEYSTORE"
else
  jarsigner -keystore "$KS" -storepass android -keypass android \
    -digestalg SHA-256 -sigalg SHA256withRSA \
    "$OUT/kinesis.aab" kinesis >/dev/null
  echo
  echo "    !! signed with the LOCAL DEBUG KEY."
  echo "    !! Play will reject this upload. It is built this way so the bundle"
  echo "    !! can be verified end to end without a real key existing yet."
  echo "    !! For a real upload, set:"
  echo "    !!   KINESIS_KEYSTORE=/path/outside/this/repo/upload.jks"
  echo "    !!   KINESIS_KS_PASS=... KINESIS_KEY_ALIAS=..."
fi

echo
echo "==> $OUT/kinesis.aab  ($(du -h "$OUT/kinesis.aab" | cut -f1))"
