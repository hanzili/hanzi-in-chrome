import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { detectCredentialSources } from '../src/cli/detect-credentials.js';

describe('detectCredentialSources', () => {
  describe('Claude Code credentials', () => {
    it('detects credentials file when it exists', () => {
      const claudePath = join('/Users/test', '.claude', '.credentials.json');
      const sources = detectCredentialSources({
        platform: 'darwin',
        homedir: '/Users/test',
        fileExists: (p) => p === claudePath,
        keychainHas: () => false,
      });

      const claude = sources.find(s => s.slug === 'claude');
      expect(claude).toEqual({
        name: 'Claude Code',
        slug: 'claude',
        path: claudePath,
      });
    });

    it('detects macOS Keychain when credentials file is absent', () => {
      const sources = detectCredentialSources({
        platform: 'darwin',
        homedir: '/Users/test',
        fileExists: () => false,
        keychainHas: (s) => s === 'Claude Code-credentials',
      });

      expect(sources.find(s => s.slug === 'claude')).toEqual({
        name: 'Claude Code',
        slug: 'claude',
        path: 'macOS Keychain',
      });
    });

    it('prefers credentials file over Keychain when both exist', () => {
      const claudePath = join('/Users/test', '.claude', '.credentials.json');
      const sources = detectCredentialSources({
        platform: 'darwin',
        homedir: '/Users/test',
        fileExists: (p) => p === claudePath,
        keychainHas: () => true,
      });

      expect(sources.find(s => s.slug === 'claude')!.path)
        .toBe(claudePath);
    });

    it('skips Keychain check on Linux', () => {
      let keychainChecked = false;
      const sources = detectCredentialSources({
        platform: 'linux',
        homedir: '/home/test',
        fileExists: () => false,
        keychainHas: () => { keychainChecked = true; return true; },
      });

      expect(sources.find(s => s.slug === 'claude')).toBeUndefined();
      expect(keychainChecked).toBe(false);
    });

    it('returns nothing when no credentials exist anywhere', () => {
      const sources = detectCredentialSources({
        platform: 'darwin',
        homedir: '/Users/test',
        fileExists: () => false,
        keychainHas: () => false,
      });

      expect(sources.find(s => s.slug === 'claude')).toBeUndefined();
    });
  });

  describe('Codex CLI credentials', () => {
    it('detects auth.json when it exists', () => {
      const codexPath = join('/Users/test', '.codex', 'auth.json');
      const sources = detectCredentialSources({
        platform: 'darwin',
        homedir: '/Users/test',
        fileExists: (p) => p === codexPath,
        keychainHas: () => false,
      });

      expect(sources.find(s => s.slug === 'codex')).toEqual({
        name: 'Codex CLI',
        slug: 'codex',
        path: codexPath,
      });
    });

    it('returns nothing when auth.json is absent', () => {
      const sources = detectCredentialSources({
        platform: 'darwin',
        homedir: '/Users/test',
        fileExists: () => false,
        keychainHas: () => false,
      });

      expect(sources.find(s => s.slug === 'codex')).toBeUndefined();
    });
  });

  describe('combined detection', () => {
    it('detects both Claude (Keychain) and Codex together', () => {
      const codexPath = join('/Users/test', '.codex', 'auth.json');
      const sources = detectCredentialSources({
        platform: 'darwin',
        homedir: '/Users/test',
        fileExists: (p) => p === codexPath,
        keychainHas: (s) => s === 'Claude Code-credentials',
      });

      expect(sources).toHaveLength(2);
      expect(sources[0]).toMatchObject({ slug: 'claude', path: 'macOS Keychain' });
      expect(sources[1]).toMatchObject({ slug: 'codex', path: codexPath });
    });

    it('returns empty array when nothing is found', () => {
      const sources = detectCredentialSources({
        platform: 'linux',
        homedir: '/home/test',
        fileExists: () => false,
        keychainHas: () => false,
      });

      expect(sources).toEqual([]);
    });
  });
});
