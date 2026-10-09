import { Stack } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { Alert, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SessionStore } from '../../src/features/code-entry/session-store';
import { services } from '../../src/services';
import { ActionButton } from '../../src/ui/action-button';
import { StudyCodeText } from '../../src/ui/study-code-text';

/** Placeholder signed-in screen: shows the study code and offers "this isn't me". */
export default function Home() {
  return services ? <HomeScreen session={services.session} /> : null;
}

function confirmSignOut(session: SessionStore, code: string | null) {
  const forgets = code ? `This phone will forget ${code}.` : 'This phone will forget your study code.';
  Alert.alert(
    'Use a different code?',
    `${forgets} Your progress stays saved under that code, so write it down first if it is yours.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget code', style: 'destructive', onPress: () => void session.signOut() },
    ],
  );
}

function HomeScreen({ session }: { session: SessionStore }) {
  const { code } = useSyncExternalStore(session.subscribe, session.getState);

  return (
    <SafeAreaView style={styles.fill}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.heading} accessibilityRole="header">
          Your Study Code
        </Text>
        {code ? (
          <StudyCodeText code={code} />
        ) : (
          <Text style={styles.body}>You are signed in on this device.</Text>
        )}
        <Text style={styles.body}>Quizzes are coming in the next update.</Text>
        <Text style={styles.body}>Not your code? Sign out so you can enter yours.</Text>
        <ActionButton
          title="This isn't me"
          variant="secondary"
          accessibilityLabel="This isn't me. Forget this study code on this device"
          onPress={() => confirmSignOut(session, code)}
          testID="not-me"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { padding: 24, gap: 16 },
  heading: { fontSize: 22, fontWeight: '600' },
  body: { fontSize: 16, color: '#374151' },
});
