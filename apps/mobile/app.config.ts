import type { ExpoConfig } from 'expo/config';

const APP_NAME = 'Adaptive Quiz';

const config: ExpoConfig = {
  name: APP_NAME,
  slug: 'adaptive-quiz',
  version: '0.1.0',
  scheme: 'adaptive-quiz',
  orientation: 'portrait',
  ios: {
    bundleIdentifier: 'com.amazingzebra.adaptivequiz',
    supportsTablet: false,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'com.amazingzebra.adaptivequiz',
  },
  // No over-the-air updates: expo-updates is not installed and every release is a store build.
  updates: { enabled: false },
  plugins: ['expo-router', 'expo-secure-store'],
};

export default config;
