import { useEffect, useState } from "react";
import {
  StatusBar,
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StorageAccessFramework } from "expo-file-system/legacy";
import { Paths } from "expo-file-system";
import { C } from "@/constants/colors";
import { AppSettings, getSettings, saveSettings } from "@/services/settings";
import { startServer, stopServer, isServerRunning } from "@/services/server";

export default function SettingsScreen() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  
  // Local state for the text input to show save/cancel buttons
  const [localDisplayName, setLocalDisplayName] = useState("");
  const isNameDirty = settings ? localDisplayName !== settings.displayName : false;

  useEffect(() => {
    getSettings().then(s => {
      setSettings(s);
      setLocalDisplayName(s.displayName);
    });
  }, []);

  const handleSave = async (newSettings: AppSettings, silent = false) => {
    setSaving(true);
    try {
      await saveSettings(newSettings);
      setSettings(newSettings);
      
      // If server is currently running, restart it to apply new settings
      if (isServerRunning()) {
        await startServer();
      }
      
      if (!silent) {
        Alert.alert("Success", "Settings saved successfully.");
      }
    } catch (e) {
      if (!silent) {
        Alert.alert("Error", "Failed to save settings.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveName = () => {
    if (!settings) return;
    handleSave({ ...settings, displayName: localDisplayName }, true);
  };

  const handleCancelName = () => {
    if (!settings) return;
    setLocalDisplayName(settings.displayName);
  };

  const handlePickDirectory = async () => {
    if (!settings) return;
    try {
      const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (permissions.granted) {
        // The URI looks something like content://.../tree/primary%3ADownloads
        // We try to extract a slightly more readable name from it
        let label = "Custom Folder";
        try {
          const decoded = decodeURIComponent(permissions.directoryUri);
          const parts = decoded.split(":");
          if (parts.length > 1) {
            label = parts[1]; // e.g. "Downloads"
          }
        } catch {}

        handleSave({
          ...settings,
          sandboxPath: permissions.directoryUri,
          sandboxLabel: label,
        });
      }
    } catch (e) {
      Alert.alert("Error", "Could not pick folder.");
      console.error(e);
    }
  };

  const handleResetDirectory = () => {
    if (!settings) return;
    handleSave({
      ...settings,
      sandboxPath: Paths.document.uri,
      sandboxLabel: "Internal Sandbox",
    });
  };

  if (!settings) {
    return (
      <View style={[styles.root, { justifyContent: "center", alignItems: "center" }]}>
        <ActivityIndicator color={C.action} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.subtitle}>Configure your device preferences</Text>
        </View>

        <View style={styles.divider} />

        {/* Content */}
        <View style={styles.content}>
          <View style={styles.section}>
            <Text style={styles.label}>Display Name</Text>
            <Text style={styles.hint}>This name will be shown to other devices on the network.</Text>
            <TextInput
              style={styles.input}
              value={localDisplayName}
              onChangeText={setLocalDisplayName}
              placeholderTextColor={C.contentFaint}
              placeholder="e.g. My Phone"
            />
            {isNameDirty && (
              <View style={[styles.btnRow, { marginTop: 12 }]}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnPrimary, { paddingVertical: 10 }]}
                  onPress={handleSaveName}
                  disabled={saving}
                >
                  <Text style={styles.btnTextPrimary}>Save</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnSecondary, { paddingVertical: 10 }]}
                  onPress={handleCancelName}
                  disabled={saving}
                >
                  <Text style={styles.btnTextSecondary}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Sandbox Location</Text>
            <Text style={styles.hint}>
              Where files are stored. By default, files are kept securely inside the app. You can change this to a public folder like Downloads.
            </Text>
            
            <View style={styles.pathCard}>
              <Text style={styles.pathCardTitle}>{settings.sandboxLabel}</Text>
              <Text style={styles.pathCardUri} numberOfLines={2} ellipsizeMode="middle">
                {settings.sandboxPath}
              </Text>
            </View>

            <View style={styles.btnRow}>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary]}
                onPress={handlePickDirectory}
                disabled={saving}
              >
                <Text style={styles.btnTextPrimary}>Change Folder</Text>
              </TouchableOpacity>

              {settings.sandboxPath !== Paths.document.uri && (
                <TouchableOpacity
                  style={[styles.btn, styles.btnSecondary]}
                  onPress={handleResetDirectory}
                  disabled={saving}
                >
                  <Text style={styles.btnTextSecondary}>Reset to Internal</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  safe: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14 },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: C.action,
    letterSpacing: -0.5,
  },
  subtitle: { fontSize: 13, color: C.contentMuted, marginTop: 4 },
  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  section: {
    marginBottom: 32,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    color: C.content,
    marginBottom: 4,
  },
  hint: {
    fontSize: 13,
    color: C.contentMuted,
    marginBottom: 12,
    lineHeight: 18,
  },
  input: {
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: 12,
    color: C.content,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  pathCard: {
    backgroundColor: C.surfaceActive,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 12,
  },
  pathCardTitle: {
    color: C.content,
    fontWeight: "600",
    fontSize: 15,
    marginBottom: 4,
  },
  pathCardUri: {
    color: C.contentFaint,
    fontSize: 11,
  },
  btnRow: {
    flexDirection: "row",
    gap: 12,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: {
    backgroundColor: C.action,
  },
  btnTextPrimary: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  btnSecondary: {
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  btnTextSecondary: {
    color: C.content,
    fontWeight: "600",
    fontSize: 14,
  },
});
