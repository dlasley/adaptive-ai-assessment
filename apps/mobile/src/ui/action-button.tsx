import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

interface ActionButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  /** Shows a spinner and is announced as busy while an action it started is in flight. */
  busy?: boolean;
  /** Spoken in place of the title when the title alone would be unclear. */
  accessibilityLabel?: string;
  testID?: string;
}

export function ActionButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityLabel,
  testID,
}: ActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        variant === 'primary' ? styles.primary : styles.secondary,
        (pressed || disabled) && styles.dimmed,
      ]}
    >
      {busy && <ActivityIndicator color={variant === 'primary' ? '#ffffff' : '#4338ca'} />}
      <Text style={variant === 'primary' ? styles.primaryText : styles.secondaryText}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: 8,
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primary: { backgroundColor: '#4f46e5' },
  secondary: { borderWidth: 2, borderColor: '#818cf8', backgroundColor: 'transparent' },
  dimmed: { opacity: 0.6 },
  primaryText: { color: '#ffffff', fontSize: 17, fontWeight: '600' },
  secondaryText: { color: '#4338ca', fontSize: 17, fontWeight: '600' },
});
