'use client';

interface TourButtonProps {
  onClick: () => void;
  label?: string;
}

export default function TourButton({ onClick, label = 'Take a Tour' }: TourButtonProps) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium transition-colors"
      title={label}
    >
      <span className="w-5 h-5 rounded-full border-2 border-current flex items-center justify-center text-xs font-bold">
        ?
      </span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
