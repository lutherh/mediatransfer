import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md bg-slate-900 px-3 py-2 sm:px-4 text-sm font-medium text-white hover:bg-slate-700 active:bg-slate-800 disabled:opacity-50 transition-colors',
        className,
      )}
      {...props}
    />
  );
}
