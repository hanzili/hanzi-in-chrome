import { render } from 'preact';
import * as Sentry from '@sentry/browser';
import posthog from 'posthog-js';
import { App } from './App';
import './style.css';

// Placeholder — will be replaced with real values in Task 8
const SENTRY_DSN = '__SENTRY_DSN_DASHBOARD__';
const POSTHOG_KEY = '__POSTHOG_API_KEY__';

if (SENTRY_DSN && !SENTRY_DSN.startsWith('__')) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: location.hostname === 'localhost' ? 'development' : 'production',
  });
}

if (POSTHOG_KEY && !POSTHOG_KEY.startsWith('__')) {
  posthog.init(POSTHOG_KEY, {
    api_host: 'https://us.i.posthog.com',
    autocapture: true,
    capture_pageview: true,
    persistence: 'localStorage',
    loaded: (ph) => {
      if (location.hostname === 'localhost') ph.opt_out_capturing();
    },
  });
}

export { posthog };

render(<App />, document.getElementById('app'));
