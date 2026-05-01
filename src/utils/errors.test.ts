import { toErrorMessage, isFileNotFoundError, isCrossDeviceError } from './errors.js';

describe('toErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('extracts message from a subclass of Error', () => {
    class CustomError extends Error {}
    expect(toErrorMessage(new CustomError('nested'))).toBe('nested');
  });

  it('returns string values as-is', () => {
    expect(toErrorMessage('plain string')).toBe('plain string');
  });

  it('coerces numbers to their string form', () => {
    expect(toErrorMessage(42)).toBe('42');
  });

  it('returns "null" for null and "undefined" for undefined', () => {
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });

  it('coerces a plain object to "[object Object]"', () => {
    expect(toErrorMessage({ a: 1 })).toBe('[object Object]');
  });
});

describe('isFileNotFoundError', () => {
  it('returns true for an Error tagged with code ENOENT', () => {
    const err = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(isFileNotFoundError(err)).toBe(true);
  });

  it('returns true for a plain object with code ENOENT', () => {
    expect(isFileNotFoundError({ code: 'ENOENT' })).toBe(true);
  });

  it('returns false for other error codes', () => {
    expect(isFileNotFoundError({ code: 'EACCES' })).toBe(false);
    expect(isFileNotFoundError({ code: 'EXDEV' })).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isFileNotFoundError('ENOENT')).toBe(false);
    expect(isFileNotFoundError(42)).toBe(false);
    expect(isFileNotFoundError(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isFileNotFoundError(null)).toBe(false);
  });

  it('returns false for objects without a code property', () => {
    expect(isFileNotFoundError(new Error('no code'))).toBe(false);
    expect(isFileNotFoundError({})).toBe(false);
  });
});

describe('isCrossDeviceError', () => {
  it('returns true for code EXDEV', () => {
    const err = Object.assign(new Error('cross device'), { code: 'EXDEV' });
    expect(isCrossDeviceError(err)).toBe(true);
  });

  it('returns true for plain object with code EXDEV', () => {
    expect(isCrossDeviceError({ code: 'EXDEV' })).toBe(true);
  });

  it('returns false for ENOENT', () => {
    expect(isCrossDeviceError({ code: 'ENOENT' })).toBe(false);
  });

  it('returns false for non-objects and null', () => {
    expect(isCrossDeviceError('EXDEV')).toBe(false);
    expect(isCrossDeviceError(null)).toBe(false);
    expect(isCrossDeviceError(undefined)).toBe(false);
  });
});
