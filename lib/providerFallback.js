"use strict";

async function runProviderFallback(
  providers,
  { unavailableProviders = new Map(), onAttempt = () => {}, onLimited = () => {} } = {},
) {
  const limitedProviders = [];
  for (const provider of providers) {
    if (!provider.configured || unavailableProviders.has(provider.name)) continue;
    onAttempt(provider);
    try {
      return { result: await provider.generate(), providerName: provider.name };
    } catch (providerErr) {
      if (!providerErr.dailyQuotaExhausted &&
          !providerErr.providerLimitReached && providerErr.status !== 429) {
        throw providerErr;
      }
      unavailableProviders.set(provider.name, providerErr);
      limitedProviders.push(providerErr);
      const reason = providerErr.dailyQuotaExhausted
        ? "daily quota exhausted"
        : "rate limit reached";
      onLimited(provider, providerErr, reason);
    }
  }

  const cascadeErr = new Error(
    "All configured image providers have exhausted their quota or rate limit.",
  );
  cascadeErr.providerCascadeExhausted = true;
  const exhaustedProviders = Array.from(unavailableProviders.values());
  cascadeErr.allDailyQuotas = exhaustedProviders.length > 0 &&
    exhaustedProviders.every((item) => item.dailyQuotaExhausted);
  cascadeErr.cause = limitedProviders[limitedProviders.length - 1];
  throw cascadeErr;
}

module.exports = { runProviderFallback };
