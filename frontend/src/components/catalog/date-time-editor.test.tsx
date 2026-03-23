/**
 * @file Tests for the DateTimeEditor component.
 *
 * Validates:
 *   • Renders date fields from capturedAt
 *   • Save button appears when date differs from S3 path
 *   • Save button hidden when date matches S3 path
 *   • Calls onSave with correct YYYY/MM/DD prefix
 *   • Shows saving/success/error states
 *   • Handles unknown-date paths (save always available)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateTimeEditor } from './date-time-editor';

describe('DateTimeEditor', () => {
  const defaultProps = {
    capturedAt: '2024-03-10T14:30:00Z',
    itemKey: '2024/03/10/photo.jpg',
    onSave: vi.fn(),
    isSaving: false,
    saveResult: null as 'success' | 'error' | null,
  };

  it('renders day, month, and year fields from capturedAt', () => {
    render(<DateTimeEditor {...defaultProps} />);

    const day = screen.getByLabelText('Day') as HTMLInputElement;
    const month = screen.getByLabelText('Month') as HTMLSelectElement;
    const year = screen.getByLabelText('Year') as HTMLInputElement;

    expect(day.value).toBe('10');
    expect(month.value).toBe('2'); // March = 2 (0-indexed)
    expect(year.value).toBe('2024');
  });

  it('displays read-only time from capturedAt', () => {
    render(<DateTimeEditor {...defaultProps} />);
    // Time is 14:30 UTC
    expect(screen.getByText('14')).toBeDefined();
    expect(screen.getByText('30')).toBeDefined();
  });

  it('hides save button when date matches S3 path', () => {
    render(<DateTimeEditor {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /save date/i })).toBeNull();
  });

  it('shows save button when user changes the day', () => {
    render(<DateTimeEditor {...defaultProps} />);
    const day = screen.getByLabelText('Day') as HTMLInputElement;
    fireEvent.change(day, { target: { value: '15' } });
    expect(screen.getByRole('button', { name: /save date/i })).toBeDefined();
  });

  it('shows save button when user changes the month', () => {
    render(<DateTimeEditor {...defaultProps} />);
    const month = screen.getByLabelText('Month') as HTMLSelectElement;
    fireEvent.change(month, { target: { value: '5' } }); // June (0-indexed)
    expect(screen.getByRole('button', { name: /save date/i })).toBeDefined();
  });

  it('shows save button when user changes the year', () => {
    render(<DateTimeEditor {...defaultProps} />);
    const year = screen.getByLabelText('Year') as HTMLInputElement;
    fireEvent.change(year, { target: { value: '2023' } });
    expect(screen.getByRole('button', { name: /save date/i })).toBeDefined();
  });

  it('calls onSave with correct YYYY/MM/DD prefix when save is clicked', () => {
    const onSave = vi.fn();
    render(<DateTimeEditor {...defaultProps} onSave={onSave} />);

    const day = screen.getByLabelText('Day') as HTMLInputElement;
    fireEvent.change(day, { target: { value: '22' } });

    const saveBtn = screen.getByRole('button', { name: /save date/i });
    fireEvent.click(saveBtn);

    expect(onSave).toHaveBeenCalledWith('2024/03/22');
  });

  it('shows "Moving…" text while saving', () => {
    render(
      <DateTimeEditor
        {...defaultProps}
        itemKey="2024/03/10/photo.jpg"
        capturedAt="2023-06-15T10:00:00Z"
        isSaving={true}
      />,
    );
    expect(screen.getByRole('button', { name: /moving/i })).toBeDefined();
  });

  it('shows success message after save', () => {
    render(
      <DateTimeEditor
        {...defaultProps}
        itemKey="2024/03/10/photo.jpg"
        capturedAt="2023-06-15T10:00:00Z"
        saveResult="success"
      />,
    );
    expect(screen.getByText(/moved to/i)).toBeDefined();
  });

  it('shows error message on save failure', () => {
    render(
      <DateTimeEditor
        {...defaultProps}
        itemKey="2024/03/10/photo.jpg"
        capturedAt="2023-06-15T10:00:00Z"
        saveResult="error"
        errorMessage="S3 copy failed"
      />,
    );
    expect(screen.getByText('S3 copy failed')).toBeDefined();
  });

  it('shows save button for unknown-date paths', () => {
    render(
      <DateTimeEditor
        {...defaultProps}
        itemKey="unknown-date/photo.jpg"
        capturedAt="2023-06-15T10:00:00Z"
      />,
    );
    // unknown-date has no YYYY/MM/DD prefix, so save should always be available
    expect(screen.getByRole('button', { name: /save date/i })).toBeDefined();
  });

  it('calls onSave with correct prefix for unknown-date items', () => {
    const onSave = vi.fn();
    render(
      <DateTimeEditor
        {...defaultProps}
        itemKey="unknown-date/photo.jpg"
        capturedAt="2023-06-15T10:00:00Z"
        onSave={onSave}
      />,
    );

    const saveBtn = screen.getByRole('button', { name: /save date/i });
    fireEvent.click(saveBtn);

    // Should derive prefix from capturedAt: 2023/06/15
    expect(onSave).toHaveBeenCalledWith('2023/06/15');
  });

  it('clamps day to valid range when month changes', () => {
    // Start with Jan 31
    render(
      <DateTimeEditor
        {...defaultProps}
        capturedAt="2024-01-31T00:00:00Z"
        itemKey="2024/01/31/photo.jpg"
      />,
    );

    // Change month to February (max day = 29 in 2024 leap year)
    const month = screen.getByLabelText('Month') as HTMLSelectElement;
    fireEvent.change(month, { target: { value: '1' } }); // Feb = 1

    // Save should show since date changed
    const saveBtn = screen.getByRole('button', { name: /save date/i });
    fireEvent.click(saveBtn);

    // Day should be clamped to 29 (Feb 2024 is leap year)
    const onSave = defaultProps.onSave;
    expect(onSave).toHaveBeenCalledWith('2024/02/29');
  });
});
