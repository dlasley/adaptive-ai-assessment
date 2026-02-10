interface StatCardProps {
  value: string | number;
  label: string;
  colorClass?: string;
  size?: 'sm' | 'lg';
}

export default function StatCard({ value, label, colorClass, size = 'sm' }: StatCardProps) {
  const isLarge = size === 'lg';
  const valueSize = isLarge ? 'text-4xl' : 'text-3xl';
  const padding = isLarge ? 'p-6' : 'p-4';
  const rounding = isLarge ? 'rounded-xl' : 'rounded-lg';

  return (
    <div className={`bg-white dark:bg-gray-800 ${rounding} shadow-lg ${padding} text-center`}>
      <div className={`${valueSize} font-bold ${colorClass || ''}${isLarge ? ' mb-2' : ''}`}>
        {value}
      </div>
      <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">
        {label}
      </div>
    </div>
  );
}
