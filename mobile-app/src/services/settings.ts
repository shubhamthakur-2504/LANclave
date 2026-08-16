import * as SecureStore from 'expo-secure-store';
import { Paths } from 'expo-file-system';

export interface AppSettings {
  displayName: string;
  sandboxPath: string; // The selected SAF URI or the internal path
  sandboxLabel: string; // User-friendly name of the folder (e.g. "Downloads" or "Internal Sandbox")
}

const SETTINGS_KEY = 'lanclave_settings_v1';

export async function getSettings(): Promise<AppSettings> {
  try {
    const data = await SecureStore.getItemAsync(SETTINGS_KEY);
    if (data) {
      return JSON.parse(data) as AppSettings;
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }
  
  // Default settings
  return {
    displayName: 'Mobile Device',
    sandboxPath: Paths.document.uri, // default to internal document path
    sandboxLabel: 'Internal Sandbox',
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
    throw e;
  }
}
