import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { apiConfigLoad } from '../src/config';
import { services } from '../src/services';

export default function RootLayout() {
  useEffect(() => {
    void services?.session.restore();
  }, []);

  if (apiConfigLoad.error !== null) {
    return (
      <ScrollView contentContainerStyle={styles.error}>
        <Text style={styles.heading}>This build is not configured</Text>
        <Text selectable testID="config-error">{apiConfigLoad.error}</Text>
      </ScrollView>
    );
  }

  return (
    <>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Study code' }} />
        <Stack.Screen name="(signed-in)" options={{ headerShown: false }} />
        <Stack.Screen name="connection-check" options={{ title: 'Connection check' }} />
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  error: { padding: 24, paddingTop: 96, gap: 12 },
  heading: { fontSize: 18, fontWeight: '600' },
});
