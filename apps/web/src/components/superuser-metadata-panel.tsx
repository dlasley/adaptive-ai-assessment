/**
 * Superuser-only metadata panels shown on questions and their evaluations.
 * Two layout variants exist because the panel is embedded in two different
 * contexts:
 *   - 'standalone': the panel is its own bordered box (used when it sits
 *     directly among other siblings that need visual separation).
 *   - 'divider': the panel sits below other content in the same card, so it
 *     only needs a top divider rather than its own border.
 * `spacing` controls how much vertical gap the divider variant's top
 * divider gets, matching the two divider contexts already in use ('sm' for
 * the quiz results view, 'lg' for the typed-answer evaluation view).
 */

import type { ReactNode } from 'react';
import type { SuperuserMetadataField } from '@/lib/superuser-metadata-labels';

interface SuperuserMetadataWrapperProps {
  variant: 'standalone' | 'divider';
  spacing?: 'sm' | 'lg';
  className?: string;
  heading: string;
  children: ReactNode;
}

function panelWrapperClassName(variant: 'standalone' | 'divider', spacing: 'sm' | 'lg'): string {
  if (variant === 'divider') {
    return spacing === 'lg'
      ? 'mt-6 pt-6 border-t border-gray-300 dark:border-gray-600'
      : 'mt-4 pt-4 border-t border-gray-300 dark:border-gray-600';
  }
  return 'p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg';
}

function panelHeadingClassName(variant: 'standalone' | 'divider'): string {
  return variant === 'divider'
    ? 'text-sm font-semibold mb-3 flex items-center gap-2 text-purple-700 dark:text-purple-300'
    : 'text-sm font-semibold mb-2 flex items-center gap-2 text-purple-900 dark:text-purple-300';
}

function SuperuserMetadataWrapper({
  variant,
  spacing = 'sm',
  className,
  heading,
  children,
}: SuperuserMetadataWrapperProps) {
  const wrapperClassName = [panelWrapperClassName(variant, spacing), className]
    .filter(Boolean)
    .join(' ');
  const headingEl = (
    <h5 className={panelHeadingClassName(variant)}>
      <span className="text-lg" aria-hidden="true">🔬</span>
      {heading}
    </h5>
  );

  if (variant === 'divider') {
    return (
      <div className={wrapperClassName}>
        {headingEl}
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">{children}</div>
      </div>
    );
  }

  return (
    <div className={wrapperClassName}>
      {headingEl}
      {children}
    </div>
  );
}

interface SuperuserQuestionMetadataPanelProps {
  variant: 'standalone' | 'divider';
  spacing?: 'sm' | 'lg';
  className?: string;
  questionTypeLabel: string;
  writingTypeLabel?: string | null;
  difficulty: string;
  topic?: string | null;
  topicColSpan?: boolean;
}

export function SuperuserQuestionMetadataPanel({
  variant,
  spacing,
  className,
  questionTypeLabel,
  writingTypeLabel,
  difficulty,
  topic,
  topicColSpan = false,
}: SuperuserQuestionMetadataPanelProps) {
  return (
    <SuperuserMetadataWrapper
      variant={variant}
      spacing={spacing}
      className={className}
      heading="Question Metadata (Superuser)"
    >
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="font-semibold text-purple-900 dark:text-purple-200">Question Type:</span>
          <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
            {questionTypeLabel}
          </span>
        </div>
        {writingTypeLabel && (
          <div>
            <span className="font-semibold text-purple-900 dark:text-purple-200">Writing Type:</span>
            <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">
              {writingTypeLabel}
            </span>
          </div>
        )}
        <div>
          <span className="font-semibold text-purple-900 dark:text-purple-200">Difficulty:</span>
          <span className="ml-2 text-purple-800 dark:text-purple-300 capitalize">{difficulty}</span>
        </div>
        {topic !== undefined && topic !== null && (
          <div className={topicColSpan ? 'col-span-2' : undefined}>
            <span className="font-semibold text-purple-900 dark:text-purple-200">Topic:</span>
            <span className="ml-2 text-purple-800 dark:text-purple-300">{topic}</span>
          </div>
        )}
      </div>
    </SuperuserMetadataWrapper>
  );
}

interface SuperuserEvaluationMetadataPanelProps {
  variant: 'standalone' | 'divider';
  spacing?: 'sm' | 'lg';
  className?: string;
  fields: SuperuserMetadataField[];
}

export function SuperuserEvaluationMetadataPanel({
  variant,
  spacing,
  className,
  fields,
}: SuperuserEvaluationMetadataPanelProps) {
  return (
    <SuperuserMetadataWrapper
      variant={variant}
      spacing={spacing}
      className={className}
      heading="Evaluation Metadata (Superuser)"
    >
      <div className="grid grid-cols-2 gap-4 text-sm">
        {fields.map((field) => (
          <div key={field.label} className={field.fullWidth ? 'col-span-2' : undefined}>
            <span className="font-semibold text-purple-900 dark:text-purple-200">{field.label}:</span>
            <span
              className={[
                'ml-2 text-purple-800 dark:text-purple-300',
                field.mono ? 'font-mono text-xs' : '',
                field.capitalize ? 'capitalize' : '',
              ].join(' ')}
            >
              {field.value}
            </span>
          </div>
        ))}
      </div>
    </SuperuserMetadataWrapper>
  );
}
