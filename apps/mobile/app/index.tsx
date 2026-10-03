import { useCallback, useEffect, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createApiClient, type ApiClient, type ApiResponse } from '../src/api/client';
import { createSecureTokenStore } from '../src/auth/token-store';
import { apiConfigLoad, type ApiConfig } from '../src/config';
import { loadSmokeSummary, type SmokeSummary } from '../src/smoke/smoke-summary';

// The root layout renders an error screen instead of this route when the config failed to load.
const client = apiConfigLoad.config
  ? createApiClient({ config: apiConfigLoad.config, tokenStore: createSecureTokenStore() })
  : null;

type Load =
  | { state: 'loading' }
  | { state: 'loaded'; summary: SmokeSummary }
  | { state: 'failed'; message: string };

function describeResponse(response: ApiResponse): string {
  return `${response.status} ${JSON.stringify(response.body)}`;
}

/**
 * Connection check against the configured API: course title, unit count and the shared
 * difficulty count, plus the logout POST sent with and without the `Origin` header.
 */
export default function Index() {
  const { config } = apiConfigLoad;
  return client && config ? <SmokeScreen client={client} config={config} /> : null;
}

function SmokeScreen({ client, config }: { client: ApiClient; config: ApiConfig }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [withOrigin, setWithOrigin] = useState<string | null>(null);
  const [withoutOrigin, setWithoutOrigin] = useState<string | null>(null);

  useEffect(() => {
    loadSmokeSummary(client)
      .then((summary) => setLoad({ state: 'loaded', summary }))
      .catch((error: unknown) => setLoad({ state: 'failed', message: String(error) }));
  }, [client]);

  const logout = useCallback(async (omitOrigin: boolean) => {
    const show = omitOrigin ? setWithoutOrigin : setWithOrigin;
    show('sending...');
    try {
      show(describeResponse(await client.logout({ omitOrigin })));
    } catch (error) {
      show(`request failed: ${String(error)}`);
    }
  }, [client]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.label}>API</Text>
      <Text selectable>
        {config.baseUrl} (Origin {config.origin}, profile {config.profile})
      </Text>

      {load.state === 'loading' && <Text>Loading...</Text>}
      {load.state === 'failed' && <Text style={styles.error}>{load.message}</Text>}
      {load.state === 'loaded' && (
        <View>
          <Text style={styles.label}>Course title</Text>
          <Text testID="course-title">{load.summary.courseTitle}</Text>
          <Text style={styles.label}>Units</Text>
          <Text testID="unit-count">{load.summary.unitCount}</Text>
          <Text style={styles.label}>Difficulties (from @adaptive/shared)</Text>
          <Text testID="difficulty-count">{load.summary.difficultyCount}</Text>
        </View>
      )}

      <View style={styles.section}>
        <Button title="POST /api/student/logout" onPress={() => logout(false)} />
        <Text selectable testID="logout-with-origin">{withOrigin ?? 'not sent'}</Text>
      </View>
      <View style={styles.section}>
        <Button title="Same POST without Origin" onPress={() => logout(true)} />
        <Text selectable testID="logout-without-origin">{withoutOrigin ?? 'not sent'}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 4 },
  label: { marginTop: 12, fontWeight: '600' },
  error: { color: '#b00020' },
  section: { marginTop: 24, gap: 4 },
});
