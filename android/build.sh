#!/usr/bin/env bash
# Builds BloodConnect.apk with the Android SDK build tools directly, so no
# Gradle download is needed. Run from anywhere: ./android/build.sh
#
# Needs a JDK 17+ and an Android SDK with platforms;android-34 and
# build-tools;34.0.0. Set JAVA_HOME and ANDROID_SDK_ROOT if they are not found.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

: "${JAVA_HOME:=$(dirname "$(dirname "$(command -v javac)")")}"
: "${ANDROID_SDK_ROOT:=$HOME/android-sdk}"
# The build-tools wrappers (d8, apksigner) shell out to `java` from PATH.
export PATH="$JAVA_HOME/bin:$PATH"
tools="$ANDROID_SDK_ROOT/build-tools/34.0.0"
jar="$ANDROID_SDK_ROOT/platforms/android-34/android.jar"
keystore="$here/keystore.jks"

for tool in "$tools/aapt2" "$tools/d8" "$tools/zipalign" "$tools/apksigner"; do
  [ -x "$tool" ] || { echo "Missing $tool — install Android build-tools 34.0.0." >&2; exit 1; }
done
[ -f "$jar" ] || { echo "Missing $jar — install platforms;android-34." >&2; exit 1; }

out="$here/build"
rm -rf "$out"
mkdir -p "$out/compiled" "$out/classes" "$out/dex"

echo "Packaging resources"
"$tools/aapt2" compile --dir "$here/res" -o "$out/resources.zip"
"$tools/aapt2" link \
  -o "$out/unsigned.apk" \
  -I "$jar" \
  --manifest "$here/AndroidManifest.xml" \
  -R "$out/resources.zip" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --auto-add-overlay

echo "Compiling Java"
"$JAVA_HOME/bin/javac" -source 8 -target 8 -Xlint:-options \
  -classpath "$jar" -d "$out/classes" \
  $(find "$here/java" -name '*.java')
"$tools/d8" --lib "$jar" --min-api 24 --output "$out/dex" \
  $(find "$out/classes" -name '*.class')

echo "Assembling the APK"
(cd "$out/dex" && zip -q "$out/unsigned.apk" classes.dex)
"$tools/zipalign" -f 4 "$out/unsigned.apk" "$out/aligned.apk"

if [ ! -f "$keystore" ]; then
  echo "Creating a signing key at $keystore (keep it: updates need the same one)"
  "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$keystore" \
    -storepass bloodconnect -keypass bloodconnect \
    -alias bloodconnect -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Blood Connect, OU=Sideload, O=Blood Connect, L=Pune, C=IN" >/dev/null 2>&1
fi

echo "Signing"
"$tools/apksigner" sign --ks "$keystore" \
  --ks-pass pass:bloodconnect --key-pass pass:bloodconnect \
  --out "$root/app/public/BloodConnect.apk" "$out/aligned.apk"
"$tools/apksigner" verify --print-certs "$root/app/public/BloodConnect.apk" | head -5

echo "Wrote app/public/BloodConnect.apk"
ls -lh "$root/app/public/BloodConnect.apk"
