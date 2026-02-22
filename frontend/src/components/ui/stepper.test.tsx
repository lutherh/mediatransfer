import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stepper } from '@/components/ui/stepper';

const steps = [
  { label: 'Connect', description: 'Google account' },
  { label: 'Select', description: 'Pick photos' },
  { label: 'Review', description: 'Confirm transfer' },
  { label: 'Transfer', description: 'Upload to cloud' },
];

describe('Stepper', () => {
  it('renders all steps', () => {
    render(<Stepper steps={steps} currentStep={0} />);
    expect(screen.getByText('Connect')).toBeInTheDocument();
    expect(screen.getByText('Select')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('marks current step with aria-current', () => {
    render(<Stepper steps={steps} currentStep={1} />);
    const currentIndicator = screen.getByText('2');
    expect(currentIndicator).toHaveAttribute('aria-current', 'step');
  });

  it('shows checkmark for completed steps', () => {
    render(<Stepper steps={steps} currentStep={2} />);
    // Steps 0 and 1 should be completed (show ✓)
    const checkmarks = screen.getAllByText('✓');
    expect(checkmarks).toHaveLength(2);
  });

  it('shows step numbers for upcoming steps', () => {
    render(<Stepper steps={steps} currentStep={0} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders descriptions', () => {
    render(<Stepper steps={steps} currentStep={0} />);
    expect(screen.getByText('Google account')).toBeInTheDocument();
    expect(screen.getByText('Pick photos')).toBeInTheDocument();
  });

  it('has navigation aria label', () => {
    render(<Stepper steps={steps} currentStep={0} />);
    expect(screen.getByRole('navigation', { name: 'Transfer progress' })).toBeInTheDocument();
  });
});
