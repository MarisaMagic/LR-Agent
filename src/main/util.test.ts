import { isAppOwnedNavigation } from './util';

describe('isAppOwnedNavigation', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('allows same-origin app routes in development', () => {
    process.env.NODE_ENV = 'development';
    expect(isAppOwnedNavigation('http://localhost:1212/')).toBe(true);
    expect(isAppOwnedNavigation('http://localhost:1212/auth')).toBe(true);
    expect(isAppOwnedNavigation('http://localhost:1212/index.html')).toBe(true);
    expect(isAppOwnedNavigation('https://example.com/docs')).toBe(false);
  });

  it('allows file: urls in production and rejects http(s)', () => {
    process.env.NODE_ENV = 'production';
    expect(isAppOwnedNavigation('file:///C:/app/index.html')).toBe(true);
    expect(isAppOwnedNavigation('https://example.com')).toBe(false);
  });
});
