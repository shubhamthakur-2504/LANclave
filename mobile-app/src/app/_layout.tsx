import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { TransferProvider } from '@/contexts/TransferContext';
import { IncomingPairingHost } from '@/components/IncomingPairingHost';
import { IncomingOfferHost } from '@/components/IncomingOfferHost';
import { OffersProvider } from '@/contexts/OffersContext';

SplashScreen.preventAutoHideAsync();

/**
 * Root layout — orchestrates top-level navigation routes:
 * - (tabs)         ← Bottom tab bar navigation (My Sandbox, Paired Peers, Scan & Pair)
 * - peer-sandbox   ← Fullscreen peer sandbox file browser
 */
export default function RootLayout() {
  return (
    <TransferProvider>
      <OffersProvider>
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="peer-sandbox" options={{ headerShown: false }} />
      </Stack>
      {/* Pairing started on another device can arrive on any screen. */}
      <IncomingPairingHost />
      {/* So is an offer of files. */}
      <IncomingOfferHost />
      </OffersProvider>
    </TransferProvider>
  );
}
