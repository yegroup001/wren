/**
 * Factory for a no-op replacement of `src/utils/auth.js`, used via
 * `mock.module("src/utils/auth.js", authMock)` in tests that want to bypass
 * real credential handling. `mock.module` requires a function factory; the
 * returned object matches the named exports consumers import.
 */
export const authMock = () => ({
  isAnthropicAuthEnabled: (): boolean => false,
  getAuthTokenSource: () => null,
  getAnthropicApiKey: (): null | string => null,
  hasAnthropicApiKeyAuth: (): boolean => false,
  getAnthropicApiKeyWithSource: () => null,
  getConfiguredApiKeyHelper: (): string | undefined => undefined,
  isAwsAuthRefreshFromProjectSettings: (): boolean => false,
  isAwsCredentialExportFromProjectSettings: (): boolean => false,
  calculateApiKeyHelperTTL: (): number => 0,
  getApiKeyHelperElapsedMs: (): number => 0,
  getApiKeyFromApiKeyHelper: async (): Promise<string | null> => null,
  getApiKeyFromApiKeyHelperCached: (): string | null => null,
  clearApiKeyHelperCache: () => {},
  prefetchApiKeyFromApiKeyHelperIfSafe: () => {},
  checkAndRefreshOAuthTokenIfNeeded: async (): Promise<void> => {},
  getClaudeAIOAuthTokens: () => ({ accessToken: "test-access-token" }),
  getAccountInformation: () => null,
  getOauthAccountInfo: () => null,
  hasProfileScope: (): boolean => false,
  isClaudeAISubscriber: (): boolean => false,
  getSubscriptionType: () => null,
})
