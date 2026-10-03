# LANclave — mobile app

The Android app. A React Native interface built with Expo, with the engine
(the file server, transfers and pairing checks) written in Kotlin as a local
native module.

For what LANclave does, see the [main README](../README.md).

## What you need

- An Android phone running **Android 13 or later**, with USB debugging turned
  on. An emulator runs the app but cannot be reached by other devices on your
  Wi-Fi.
- [Node.js](https://nodejs.org/) (LTS) with npm.
- JDK 17 and the Android SDK. Installing
  [Android Studio](https://developer.android.com/studio) provides both.
- `adb` on your PATH (it comes with the Android SDK's platform tools).

**Expo Go will not work.** The app includes its own native code, so it has to
be built and installed as a development build, which the steps below do.

## Run it

Connect the phone by USB, then:

```powershell
cd mobile-app
npm install
npx expo run:android
```

The first run generates the `android/` project, builds it and installs it on
the phone, which takes several minutes. After that, as long as you have not
changed any native code or `app.json`, starting the bundler is enough:

```powershell
npx expo start
```

### Without the cable

With the phone connected by USB once:

```powershell
adb tcpip 5555
adb connect <phone-ip>:5555
```

You can then unplug it. `adb devices` shows what is connected; use
`adb disconnect <phone-ip>:5555` to drop a stale wireless connection.

## Build an APK

```powershell
cd android
.\gradlew assembleRelease
```

The APK is written to
`android/app/build/outputs/apk/release/app-release.apk`.

This build is signed with Android's debug key, which is fine for installing on
your own devices. To distribute the app, sign it with your own keystore.

## Tests and lint

```powershell
cd android
.\gradlew :expo-native-server:testDebugUnitTest   # Kotlin unit tests
cd ..
npm run lint
```

## Things to know

- **The `android/` folder is generated and is not in git.** Do not edit it by
  hand; your changes are lost the next time it is regenerated. Permissions and
  build settings belong in `app.json`, and native code belongs in
  `modules/expo-native-server/`.
- After changing `app.json` or anything under `modules/`, run
  `npx expo run:android` again so the change is built in.
- The phone can only be found, browsed or sent to while the app is open with
  its server on. The server starts when the app opens and has a switch on the
  My Sandbox screen. Nothing listens once the app is closed; only a transfer
  already under way continues in the background.
- There is no iPhone version. The native module's iOS half is a placeholder.

## Layout

```
src/
  app/                 Screens (Expo Router): sandbox, peers, scan, transfers,
                       settings, and a paired device's sandbox
  components/          Rows, cards and dialogs shared by the screens
  contexts/            Transfer and offer state shared across screens
  services/            Calls to other devices, pairing, settings, storage
modules/expo-native-server/android/src/main/java/…/nativeserver/
  NativeServer.kt      The HTTP server other devices talk to
  TransferEngine.kt    Downloads: queue, pause, resume
  TransferService.kt   Keeps a transfer running in the background
  Offers.kt            Sending: offers, consent, expiry
  PairingGuard.kt      One pairing at a time, and the cooldown on rejections
  Sandbox.kt           Keeps every path inside the shared folder
```
