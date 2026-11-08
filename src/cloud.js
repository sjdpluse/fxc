import { createClient } from '../vendor/supabase.js';
import { cloudConfig } from './cloud-config.js';

export const cloudClient = createClient(cloudConfig.url, cloudConfig.publishableKey, {
  auth: { storageKey: 'fxc.auth.cvernmhpnsgdtegvblyc', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: {
    fetch(input, init = {}) {
      const timeout = AbortSignal.timeout(20000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return fetch(input, { ...init, signal, referrerPolicy: 'no-referrer' });
    }
  }
});

export function parseEmailLink(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Paste the complete confirmation or recovery link from your email.'); }
  if (url.origin !== cloudConfig.url || url.pathname !== '/auth/v1/verify') throw new Error('Use the original verification link from your Supabase email.');
  const type = url.searchParams.get('type');
  const tokenHash = url.searchParams.get('token') || url.searchParams.get('token_hash');
  if (!['signup', 'email', 'recovery', 'magiclink'].includes(type) || !tokenHash || tokenHash.length > 4096) throw new Error('This verification link is incomplete or unsupported.');
  return { token_hash: tokenHash, type };
}
