import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { apiConfigLoad } from '../src/config';

export default function RootLayout() {
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
      <Stack screenOptions={{ title: 'Connection check' }} />
    </>
  );
}

const styles = StyleSheet.create({
  error: { padding: 24, paddingTop: 96, gap: 12 },
  heading: { fontSize: 18, fontWeight: '600' },
});
