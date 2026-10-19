import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { C } from "@/constants/colors";
import ExpoNativeServerModule, { DevStatus } from "../../modules/expo-native-server/src/ExpoNativeServerModule";

/** Port of the laptop's local developer endpoint (desktop `devtools.rs`). */
const LAPTOP_PORT = 8378;

function readStatus(): DevStatus | null {
  try {
    return ExpoNativeServerModule.devStatus();
  } catch {
    return null; // iOS, or a build without developer tools
  }
}

/**
 * Settings section for the dev build: lets a paired laptop read this phone's
 * logs and install apps on it, with no USB cable after one-time setup.
 */
export function DevToolsSection() {
  const [status, setStatus] = useState<DevStatus | null>(readStatus);

  // Live while the tab is open: line count, and whether Android allowed
  // full access once the prompt is answered.
  useFocusEffect(
    useCallback(() => {
      setStatus(readStatus());
      const timer = setInterval(() => setStatus(readStatus()), 2000);
      return () => clearInterval(timer);
    }, []),
  );

  if (!status) return null;

  const grantCommand = `adb shell pm grant ${status.packageName} android.permission.READ_LOGS`;
  const toggle = () => {
    try {
      setStatus(status.enabled ? ExpoNativeServerModule.devDisable() : ExpoNativeServerModule.devEnable());
    } catch {
      setStatus(readStatus());
    }
  };
  // A new capture brings Android's log access prompt back.
  const restart = () => {
    try {
      ExpoNativeServerModule.devDisable();
      setStatus(ExpoNativeServerModule.devEnable());
    } catch {
      setStatus(readStatus());
    }
  };
  const copy = (text: string) => {
    try {
      ExpoNativeServerModule.copyText(text);
    } catch {}
  };

  return (
    <View style={styles.section}>
      <Text style={styles.label}>Developer tools</Text>
      <Text style={styles.hint}>
        {"Your paired laptop can read this phone's logs and install apps on it over the network. No USB cable needed."}
      </Text>

      <TouchableOpacity
        style={[styles.btn, status.enabled ? styles.btnSecondary : styles.btnPrimary]}
        onPress={toggle}
        accessibilityRole="button"
      >
        <Text style={status.enabled ? styles.btnTextSecondary : styles.btnTextPrimary}>
          {status.enabled ? "Turn off" : "Turn on"}
        </Text>
      </TouchableOpacity>

      {status.enabled && (
        <View style={styles.checks}>
          <Check
            ok={status.readLogsGranted}
            title={status.readLogsGranted ? "Log access granted" : "Log access needs a one-time USB step"}
            detail={status.readLogsGranted ? undefined : `Connect over USB once and run:\n${grantCommand}`}
            action={status.readLogsGranted ? undefined : { label: "Copy command", onPress: () => copy(grantCommand) }}
          />
          {status.readLogsGranted && (
            <Check
              ok={status.seesOtherApps}
              title={status.seesOtherApps ? "Reading every app's logs" : "Only LANclave's own logs so far"}
              detail={
                status.seesOtherApps
                  ? `${status.lines.toLocaleString()} lines captured`
                  : "Android asks before sharing other apps' logs. Restart capture and choose Allow."
              }
              action={status.seesOtherApps ? undefined : { label: "Restart capture", onPress: restart }}
            />
          )}
          <Check
            ok={status.canInstall}
            title={status.canInstall ? "Installs allowed" : "Installs need permission"}
            detail={status.canInstall ? undefined : "Allow LANclave to install unknown apps."}
            action={
              status.canInstall
                ? undefined
                : { label: "Open setting", onPress: () => ExpoNativeServerModule.devOpenInstallSettings() }
            }
          />
          <Check
            ok={status.canOpenApps}
            title={status.canOpenApps ? "Can open apps after installing" : "Opening apps needs permission"}
            detail={
              status.canOpenApps
                ? undefined
                : "Allow LANclave to display over other apps, so it can open what your laptop just installed. Until then you get a notification to tap."
            }
            action={
              status.canOpenApps
                ? undefined
                : { label: "Open setting", onPress: () => ExpoNativeServerModule.devOpenOverlaySettings() }
            }
          />
          <Text style={[styles.hint, { marginTop: 8 }]}>
            On the laptop, open http://localhost:{LAPTOP_PORT} for the commands.
          </Text>
        </View>
      )}
    </View>
  );
}

function Check(props: {
  ok: boolean;
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.check}>
      <Text style={[styles.checkTitle, { color: props.ok ? C.ok : C.warn }]}>
        {props.ok ? "✓" : "!"}  {props.title}
      </Text>
      {props.detail ? (
        <Text style={styles.checkDetail} selectable>
          {props.detail}
        </Text>
      ) : null}
      {props.action ? (
        <TouchableOpacity style={[styles.btn, styles.btnSecondary, styles.checkBtn]} onPress={props.action.onPress}>
          <Text style={styles.btnTextSecondary}>{props.action.label}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 32 },
  label: { fontSize: 16, fontWeight: "600", color: C.content, marginBottom: 4 },
  hint: { fontSize: 13, color: C.contentMuted, marginBottom: 12, lineHeight: 18 },
  checks: { marginTop: 16, gap: 12 },
  check: {
    backgroundColor: C.surfaceRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
  },
  checkTitle: { fontSize: 14, fontWeight: "600" },
  checkDetail: { fontSize: 12, color: C.contentMuted, marginTop: 6, lineHeight: 17 },
  checkBtn: { marginTop: 10, paddingVertical: 8 },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnPrimary: { backgroundColor: C.action },
  btnTextPrimary: { color: "#fff", fontWeight: "600", fontSize: 14 },
  btnSecondary: { backgroundColor: C.surfaceRaised, borderWidth: 1, borderColor: C.borderStrong },
  btnTextSecondary: { color: C.content, fontWeight: "600", fontSize: 14 },
});
