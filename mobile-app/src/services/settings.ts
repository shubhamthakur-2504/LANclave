import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';

export interface AppSettings {
  displayName: string;
  sandboxPath: string; // The selected SAF URI or the internal path
  sandboxLabel: string; // User-friendly name of the folder (e.g. "Downloads" or "Internal Sandbox")
}

const SETTINGS_KEY = 'lanclave_settings_v1';

/** The built-in sandbox's folder, inside the app's private storage. */
const SANDBOX_DIR = 'Sandbox';

/**
 * What the app and Android keep beside that folder. The sandbox used to be
 * the private folder itself, so these were listed to paired peers and could
 * be downloaded: Android's install markers, and our own offer and transfer
 * records.
 */
function isInternalFile(name: string): boolean {
  return (
    name.startsWith('.') ||
    name === 'profileInstalled' ||
    name.startsWith('profileinstaller_') ||
    /^(offers|transfers)\.json(\.tmp)?$/.test(name) ||
    name === 'transfer_history.jsonl'
  );
}

const sameDir = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

let builtIn: string | null = null;

/**
 * The built-in sandbox, created on first use. Files the user already had in
 * the old location (the private folder's root) are moved in with it.
 */
export function builtInSandboxUri(): string {
  if (builtIn) return builtIn;
  try {
    const dir = new Directory(Paths.document, SANDBOX_DIR);
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
      for (const item of Paths.document.list()) {
        if (!(item instanceof File) || isInternalFile(item.name)) continue;
        try {
          item.moveSync(dir);
        } catch (e) {
          console.warn(`Could not move ${item.name} into the sandbox:`, e);
        }
      }
    }
    builtIn = dir.uri;
  } catch (e) {
    console.warn('Could not create the sandbox folder:', e);
    return Paths.document.uri;
  }
  return builtIn;
}

export function isBuiltInSandbox(path: string): boolean {
  return sameDir(path, builtInSandboxUri());
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const data = await SecureStore.getItemAsync(SETTINGS_KEY);
    if (data) {
      const saved = JSON.parse(data) as AppSettings;
      // Saved while the sandbox was still the private folder's root.
      if (sameDir(saved.sandboxPath, Paths.document.uri)) {
        saved.sandboxPath = builtInSandboxUri();
      }
      return saved;
    }
  } catch (e) {
    console.warn('Failed to load settings:', e);
  }

  // Default settings
  return {
    displayName: 'Mobile Device',
    sandboxPath: builtInSandboxUri(),
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
