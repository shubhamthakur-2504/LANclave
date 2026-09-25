import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AppSettings {
  display_name: string;
  sandbox_path: string;
  /** Downloads that run at once; the rest wait their turn. */
  max_downloads: number;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch((e) => console.error("Failed to load settings:", e));
  }, []);

  const handleSave = async (newSettings: AppSettings) => {
    setSaving(true);
    try {
      await invoke("update_settings", { newSettings });
      setSettings(newSettings);
      
      // If server is currently running, restart it to apply new settings
      const isRunning = await invoke<boolean>("is_server_running");
      if (isRunning) {
        await invoke("start_server");
      }
    } catch (e) {
      console.error("Failed to save settings:", e);
      alert("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handlePickDirectory = async () => {
    if (!settings) return;
    try {
      const path = await invoke<string | null>("pick_directory");
      if (path) {
        handleSave({ ...settings, sandbox_path: path });
      }
    } catch (e) {
      console.error("Failed to pick directory:", e);
    }
  };

  if (!settings) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center text-content-muted">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="flex-1 p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-content mb-2">Settings</h1>
        <p className="text-content-muted">Configure your LANclave preferences</p>
      </div>

      <div className="max-w-2xl space-y-8">
        <section>
          <label className="block text-lg font-semibold text-content mb-1">
            Display Name
          </label>
          <p className="text-sm text-content-muted mb-3">
            This name will be shown to other devices on the network.
          </p>
          <input
            type="text"
            className="w-full bg-surface-inset border border-border rounded-xl px-4 py-3 text-content focus:outline-none focus:border-action transition-colors"
            value={settings.display_name}
            onChange={(e) => setSettings({ ...settings, display_name: e.target.value })}
            onBlur={() => handleSave(settings)}
            placeholder="e.g. My PC"
          />
        </section>

        <section>
          <label className="block text-lg font-semibold text-content mb-1">
            Sandbox Location
          </label>
          <p className="text-sm text-content-muted mb-3">
            The folder where LANclave stores and serves your files. 
            Changing this will update what other devices can see.
          </p>
          
          <div className="flex gap-4">
            <input
              type="text"
              readOnly
              className="flex-1 bg-surface-raised border border-border rounded-xl px-4 py-3 text-content-muted focus:outline-none"
              value={settings.sandbox_path}
            />
            <button
              onClick={handlePickDirectory}
              disabled={saving}
              className="px-6 py-3 bg-action text-on-action font-medium rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap"
            >
              Browse...
            </button>
          </div>
        </section>

        <section>
          <label htmlFor="max-downloads" className="block text-lg font-semibold text-content mb-1">
            Downloads at once
          </label>
          <p className="text-sm text-content-muted mb-3">
            The rest wait their turn. Two fill a Wi-Fi connection without spreading it thin.
          </p>
          <select
            id="max-downloads"
            className="bg-surface-inset border border-border rounded-xl px-4 py-3 text-content focus:outline-none focus:border-action transition-colors"
            value={settings.max_downloads}
            disabled={saving}
            onChange={(e) => handleSave({ ...settings, max_downloads: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </section>
      </div>
    </div>
  );
}
