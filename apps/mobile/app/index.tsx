import * as Clipboard from 'expo-clipboard';
import { Link, Redirect } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ApiClient } from '../src/api/client';
import {
  canSubmit,
  shouldLeaveCodeEntry,
  type CodeEntryStore,
} from '../src/features/code-entry/code-entry-store';
import { loadCourseHeading } from '../src/features/code-entry/course-heading';
import { codeEntryMessage, type CodeEntryMessage } from '../src/features/code-entry/messages';
import type { SessionStore } from '../src/features/code-entry/session-store';
import { services } from '../src/services';
import { ActionButton } from '../src/ui/action-button';
import { StudyCodeText } from '../src/ui/study-code-text';

export default function CodeEntry() {
  return services ? (
    <CodeEntryScreen
      client={services.client}
      session={services.session}
      codeEntry={services.codeEntry}
      showConnectionCheck={services.config.profile === 'development'}
    />
  ) : null;
}

const TONE_COLORS: Record<CodeEntryMessage['tone'], string> = {
  problem: '#b91c1c',
  notice: '#92400e',
  neutral: '#374151',
};

function MessageText({ message, testID }: { message: CodeEntryMessage; testID: string }) {
  return (
    <Text style={[styles.message, { color: TONE_COLORS[message.tone] }]} testID={testID}>
      {message.text}
    </Text>
  );
}

function CodeEntryScreen({
  client,
  session,
  codeEntry,
  showConnectionCheck,
}: {
  client: ApiClient;
  session: SessionStore;
  codeEntry: CodeEntryStore;
  showConnectionCheck: boolean;
}) {
  const sessionState = useSyncExternalStore(session.subscribe, session.getState);
  const entry = useSyncExternalStore(codeEntry.subscribe, codeEntry.getState);
  const headerHeight = useHeaderHeight();
  const [courseHeading, setCourseHeading] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadCourseHeading(client).then(setCourseHeading);
  }, [client]);

  // Every outcome is announced explicitly, and no message carries a live region, so Android does
  // not read it twice.
  const announcement = entry.announcement;
  useEffect(() => {
    if (announcement) AccessibilityInfo.announceForAccessibility(announcement.text);
  }, [announcement]);

  if (shouldLeaveCodeEntry(sessionState, entry)) return <Redirect href="/home" />;

  if (sessionState.phase === 'restoring') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator accessibilityLabel="Checking your session" size="large" />
      </View>
    );
  }

  if (entry.phase.status === 'creating') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <Text style={styles.body}>Creating your study code...</Text>
      </View>
    );
  }

  if (entry.phase.status === 'created') {
    const { code } = entry.phase;
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.heading} accessibilityRole="header">
          Save Your Study Code
        </Text>
        <StudyCodeText code={code} />
        <Text style={styles.body}>
          This code is the only way back to your progress. Write it down or take a screenshot before you continue.
        </Text>
        <ActionButton
          title={copied ? 'Copied' : 'Copy code'}
          variant="secondary"
          accessibilityLabel={copied ? 'Code copied' : 'Copy code'}
          onPress={() => {
            void Clipboard.setStringAsync(code).then(() => setCopied(true));
          }}
          testID="copy-code"
        />
        <ActionButton title="I wrote it down, continue" onPress={codeEntry.continueAfterCreate} />
      </ScrollView>
    );
  }

  const submitting = entry.phase.status === 'submitting';
  const message = codeEntryMessage(entry.phase);

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {courseHeading && (
          <Text style={styles.course} accessibilityRole="header" testID="course-heading">
            {courseHeading}
          </Text>
        )}
        <Text style={styles.heading} accessibilityRole="header">
          Enter Your Study Code
        </Text>
        <TextInput
          value={entry.input}
          onChangeText={codeEntry.setInput}
          onSubmitEditing={() => void codeEntry.submit()}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="e.g. brave purple penguin"
          accessibilityLabel="Study code"
          accessibilityHint="Three words, for example brave purple penguin"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          returnKeyType="go"
          editable={!submitting}
          style={[styles.input, focused && styles.inputFocused]}
          testID="study-code-input"
        />
        {message?.place === 'code' && <MessageText message={message} testID="code-entry-message" />}
        <ActionButton
          title={submitting ? 'Checking...' : 'Continue'}
          accessibilityLabel={submitting ? 'Checking your study code' : 'Continue with this study code'}
          onPress={() => void codeEntry.submit()}
          disabled={!canSubmit(entry)}
          busy={submitting}
          testID="submit-code"
        />

        <View style={styles.divider} />
        <Text style={styles.body}>New here? Get a study code of your own.</Text>
        <ActionButton
          title="I'm new, create a code"
          variant="secondary"
          onPress={() => void codeEntry.create()}
          disabled={submitting}
          testID="create-code"
        />
        {message?.place === 'create' && <MessageText message={message} testID="create-code-message" />}

        {showConnectionCheck && (
          <Link href="/connection-check" style={styles.devLink} accessibilityRole="link">
            Connection check
          </Link>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  container: { padding: 24, gap: 16 },
  course: { fontSize: 18, fontWeight: '600', color: '#3730a3' },
  heading: { fontSize: 22, fontWeight: '600' },
  body: { fontSize: 16, color: '#374151' },
  input: {
    borderWidth: 2,
    borderColor: '#6b7280',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 20,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  inputFocused: { borderColor: '#4f46e5' },
  message: { fontSize: 15 },
  divider: { height: 1, backgroundColor: '#e5e7eb', marginVertical: 8 },
  devLink: { marginTop: 24, fontSize: 14, color: '#6b7280', textDecorationLine: 'underline' },
});
