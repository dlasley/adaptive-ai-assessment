interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  color?: 'indigo' | 'blue';
  className?: string;
}

const SIZE_CLASSES = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};

const COLOR_CLASSES = {
  indigo: 'border-indigo-600',
  blue: 'border-blue-600',
};

export default function LoadingSpinner({
  size = 'lg',
  color = 'indigo',
  className = '',
}: LoadingSpinnerProps) {
  return (
    <div
      className={`animate-spin rounded-full border-b-2 ${SIZE_CLASSES[size]} ${COLOR_CLASSES[color]} ${className}`}
    />
  );
}
