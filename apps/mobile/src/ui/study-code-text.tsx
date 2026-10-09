import { Platform, StyleSheet, Text } from 'react-native';

/** A study code in large monospace type, so the student can read it back word by word. */
export function StudyCodeText({ code }: { code: string }) {
  return (
    <Text selectable accessibilityLabel={`Study code: ${code}`} style={styles.code} testID="study-code">
      {code}
    </Text>
  );
}

const styles = StyleSheet.create({
  code: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 24,
    fontWeight: '700',
    color: '#3730a3',
    backgroundColor: '#eef2ff',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    textAlign: 'center',
  },
});
