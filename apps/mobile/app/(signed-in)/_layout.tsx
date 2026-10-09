import { Redirect, Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { SessionStore } from '../../src/features/code-entry/session-store';
import { services } from '../../src/services';

/**
 * Every screen that needs a session lives in this group. Whenever the session ends, whether by
 * "this isn't me" or by the API client clearing the token after a 401, the group redirects to
 * code entry.
 */
export default function SignedInLayout() {
  return services ? <SignedInGate session={services.session} /> : null;
}

function SignedInGate({ session }: { session: SessionStore }) {
  const { phase } = useSyncExternalStore(session.subscribe, session.getState);

  if (phase === 'signed-out') return <Redirect href="/" />;
  if (phase === 'restoring') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator accessibilityLabel="Checking your session" size="large" />
      </View>
    );
  }
  return <Stack screenOptions={{ headerBackVisible: false }} />;
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
