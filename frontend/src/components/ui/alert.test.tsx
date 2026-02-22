import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Alert } from '@/components/ui/alert';

describe('Alert', () => {
  it('renders children', () => {
    render(<Alert>Test message</Alert>);
    expect(screen.getByText('Test message')).toBeInTheDocument();
  });

  it('has alert role', () => {
    render(<Alert>Test</Alert>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('applies info variant by default', () => {
    render(<Alert>Info alert</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-blue-50');
  });

  it('applies success variant', () => {
    render(<Alert variant="success">Success</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-green-50');
  });

  it('applies warning variant', () => {
    render(<Alert variant="warning">Warning</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-amber-50');
  });

  it('applies error variant', () => {
    render(<Alert variant="error">Error</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-red-50');
  });

  it('merges custom className', () => {
    render(<Alert className="custom-class">Test</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('custom-class');
  });
});
