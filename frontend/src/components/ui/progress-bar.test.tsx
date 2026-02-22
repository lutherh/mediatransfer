import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from '@/components/ui/progress-bar';

describe('ProgressBar', () => {
  it('renders with correct percentage', () => {
    render(<ProgressBar value={0.75} label="Upload progress" />);
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Upload progress')).toBeInTheDocument();
  });

  it('sets aria attributes correctly', () => {
    render(<ProgressBar value={0.5} />);
    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toHaveAttribute('aria-valuenow', '50');
    expect(progressBar).toHaveAttribute('aria-valuemin', '0');
    expect(progressBar).toHaveAttribute('aria-valuemax', '100');
  });

  it('clamps value between 0 and 100', () => {
    render(<ProgressBar value={1.5} label="Test" />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('handles value of 0', () => {
    render(<ProgressBar value={0} label="Test" />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('handles value of 1 (100%)', () => {
    render(<ProgressBar value={1} label="Test" />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders without label', () => {
    render(<ProgressBar value={0.3} />);
    const progressBar = screen.getByRole('progressbar');
    expect(progressBar).toBeInTheDocument();
  });
});
