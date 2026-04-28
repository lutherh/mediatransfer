import { Alert } from '@/components/ui/alert';
import type { ValidationIssue } from '@/lib/api';

type Props = {
  /** Top-level error message (shown when there are no per-field issues). */
  message?: string | null;
  /** Field-level validation issues from the server. */
  issues?: ValidationIssue[];
};

/**
 * Renders all server-side validation problems at once. Surfaces the full set
 * of Zod issues (rather than just the first) when the API response includes
 * an `issues` array; otherwise falls back to the single `message` string.
 */
export function ValidationIssues({ message, issues }: Props) {
  const items = issues ?? [];
  if (!message && items.length === 0) return null;

  if (items.length > 0) {
    return (
      <Alert variant="error" className="mt-3">
        <p className="font-medium mb-1">Please fix the following:</p>
        <ul className="list-disc list-inside space-y-0.5">
          {items.map((issue, i) => {
            const fieldPath = issue.path.length > 0 ? issue.path.join('.') : null;
            return (
              <li key={`${fieldPath ?? 'root'}-${i}`}>
                {fieldPath && (
                  <code className="text-xs bg-red-100 px-1 rounded mr-1">{fieldPath}</code>
                )}
                {issue.message}
              </li>
            );
          })}
        </ul>
      </Alert>
    );
  }

  return <Alert variant="error" className="mt-3">{message}</Alert>;
}
