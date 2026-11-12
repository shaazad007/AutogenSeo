"use strict";

const fs = require("fs");
const path = require("path");

const { sleep, log, todayDateString, nowIso, csvEscape } = require("./util");
const { generateProductContent } = require("./generate");
const { generateWithGroq } = require("./groq");
const { generateWithCloudflare } = require("./cloudflare");
const { runProviderFallback } = require("./providerFallback");
const { githubRunIdentity, updateCurrentRun } = require("./runTelemetry");

/**
 * Load progress.json, resetting the "today" counter if the date has rolled over.
 */
function loadProgress(progressPath) {
  const raw = JSON.parse(fs.readFileSync(progressPath, "utf8"));
  const today = todayDateString();
  if (raw.today_date !== today) {
    raw.today_date = today;
    raw.today_done = 0;
  }
  return raw;
}

function saveProgress(progressPath, progress) {
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

function appendFailedRow(failedCsvPath, row) {
  const line = [row.product_id, row.title, row.handle, row.error, row.timestamp]
    .map(csvEscape)
    .join(",");
  fs.appendFileSync(failedCsvPath, line + "\n");
}

function ensureDesignProfileRetry(progress, product, profile) {
  progress.design_profile_retries = Array.isArray(progress.design_profile_retries)
    ? progress.design_profile_retries
    : [];
  let retry = progress.design_profile_retries.find(
    (item) => item.product_id === product.id,
  );
  if (!retry) {
    retry = {
      product_id: product.id,
      product_title: product.title,
      profile,
      attempts: 0,
      created_at: nowIso(),
      last_error: null,
    };
    progress.design_profile_retries.push(retry);
  } else {
    retry.profile = profile;
    retry.product_title = product.title;
  }
  return retry;
}

function removeDesignProfileRetry(progress, productId) {
  progress.design_profile_retries = (progress.design_profile_retries || [])
    .filter((item) => item.product_id !== productId);
}

async function retryDesignProfileWrites(shopify, progress, progressPath, runLog) {
  const retries = Array.isArray(progress.design_profile_retries)
    ? [...progress.design_profile_retries]
    : [];
  for (const retry of retries) {
    try {
      await shopify.writeDesignProfile(retry.product_id, retry.profile);
      removeDesignProfileRetry(progress, retry.product_id);
      saveProgress(progressPath, progress);
      runLog.push(log(`Design Profile retry verified for: ${retry.product_title}`));
    } catch (error) {
      const current = progress.design_profile_retries.find(
        (item) => item.product_id === retry.product_id,
      );
      if (current) {
        current.attempts = (current.attempts || 0) + 1;
        current.last_attempt_at = nowIso();
        current.last_error = String(error.message || error).slice(0, 500);
      }
      saveProgress(progressPath, progress);
      runLog.push(log(`Design Profile retry remains queued for ${retry.product_title}: ${error.message}`));
    }
  }
}

/**
 * Append one entry per run to history.json (capped at the last 90 entries)
 * so the dashboard can draw a "progress over time" chart. Kept separate
 * from progress.json so that file stays small and fast to fetch.
 */
function appendHistoryEntry(historyPath, progress, { processed, failed }) {
  let history = [];
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      if (!Array.isArray(history)) history = [];
    } catch (err) {
      history = [];
    }
  }

  history.push({
    at: nowIso(),
    total_done: progress.total_done,
    total_products: progress.total_products,
    today_done: progress.today_done,
    processed_this_run: processed,
    failed_this_run: failed,
  });

  if (history.length > 90) {
    history = history.slice(history.length - 90);
  }

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

function writePreviewFile(previewDir, index, product, result) {
  if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
  const safeHandle = (product.handle || product.id).replace(/[^a-z0-9-]/gi, "_");
  const filePath = path.join(previewDir, `${String(index).padStart(2, "0")}-${safeHandle}.txt`);

  const content = `PRODUCT: ${product.title}
URL HANDLE (unchanged): ${product.handle}
TITLE: unchanged — this system never edits the product title
--------------------------------------------------
META DESCRIPTION (${result.meta_description.length} chars):
${result.meta_description}

TAGS:
${result.tags.join(", ")}

IMAGE ALT TEXT:
${result.image_alt_text}

AI DESIGN PROFILE:
${result.design_profile ? JSON.stringify(result.design_profile, null, 2) : result.design_profile_error ? `Unavailable: ${result.design_profile_error}` : "Not requested"}

DESCRIPTION HTML:
${result.description_html}
`;
  fs.writeFileSync(filePath, content);
}

/**
 * Process up to `limit` products in preview, live SEO, or profile-only backfill mode.
 * deadlineMs: absolute Date.now() timestamp — the run stops cleanly (never
 *   mid-product) once this is reached, well before GitHub's hard 6-hour job
 *   limit, so progress is always committed instead of the job getting killed.
 */
async function runBatch({ shopify, config, mode, limit, runLog, logicalJobId = "", deadlineMs = Infinity, productIds = null, onProductResult = null }) {
  const { promptConfig, designers, models, env, paths } = config;
  const includeDesignProfile = mode === "preview" || mode === "profile-backfill" || env.AI_DESIGN_PROFILE_ENABLED === true;
  const profileWritesEnabled = (mode === "live" || mode === "profile-backfill") && env.AI_DESIGN_PROFILE_ENABLED === true;
  if (mode === "profile-backfill" && !profileWritesEnabled) {
    throw new Error("Profile backfill requires AI_DESIGN_PROFILE_ENABLED=true.");
  }

  const progress = loadProgress(paths.progress);
  const runIdentity = githubRunIdentity(process.env, logicalJobId);
  progress.status = "running";
  progress.last_run_started_at = nowIso();
  saveProgress(paths.progress, progress);
  if (profileWritesEnabled && mode === "live") {
    await retryDesignProfileWrites(shopify, progress, paths.progress, runLog);
  }

  const dailyCap = promptConfig.daily_cap || 1000;
  const delaySeconds = promptConfig.delay_seconds || 7;
  const effectiveLimit = Math.min(limit, mode === "live" ? dailyCap - progress.today_done : limit);
  updateCurrentRun(progress, {
    identity: runIdentity,
    status: "running",
    total: Math.max(0, effectiveLimit),
    completed: 0,
    failed: 0,
  });
  saveProgress(paths.progress, progress);

  if (effectiveLimit <= 0) {
    log("Today's cap is already reached. Nothing to do — try again tomorrow.");
    progress.status = "idle";
    updateCurrentRun(progress, {
      identity: runIdentity,
      status: "completed",
      total: 0,
      completed: 0,
      failed: 0,
    });
    saveProgress(paths.progress, progress);
    return { processed: 0, failed: 0, stopReason: mode === "live" ? "daily_cap" : null };
  }

  let processed = 0;
  let failed = 0;
  let stopReason = null;
  const unavailableProviders = new Map();
  let usedGroqCount = 0;
  let usedCloudflareCount = 0;

  // Refresh total/remaining counts for the dashboard's "estimated days left",
  // and detect newly-added products since the last run (compares against
  // the total_products figure saved at the end of the previous run).
  const previousTotalProducts = progress.total_products || 0;
  progress.new_products_detected_last_run = 0;

  try {
    const [total, remaining] = await Promise.all([
      shopify.countTotalProducts(),
      shopify.countUnprocessedProducts(),
    ]);
    progress.total_products = total;
    progress.total_done = total - remaining;
    if (dailyCap > 0) {
      progress.estimated_days_left = Math.ceil(remaining / dailyCap);
    }

    if (previousTotalProducts > 0 && total > previousTotalProducts) {
      const newCount = total - previousTotalProducts;
      progress.new_products_detected_last_run = newCount;
      runLog.push(
        log(
          `${newCount} new product${newCount === 1 ? "" : "s"} detected in the store since the last run — they'll be picked up automatically (no "ai-done" tag yet).`
        )
      );
    }
  } catch (err) {
    log(`Could not refresh totals (non-fatal): ${err.message}`);
  }

  /**
   * Process one "queue" of products (either the whole catalog, or a single
   * collection) until it runs out, hits the overall limit, runs out of time
   * budget, or every configured image provider reaches its quota or rate limit.
   * `collectionHandle` = null means no collection restriction at all.
   */
  async function drainQueue(collectionHandle) {
    let cursor = null;
    let hasMore = true;
    let exactQueueIndex = 0;

    while (hasMore && !stopReason && processed + failed < effectiveLimit) {
      const batchSize = Math.min(25, effectiveLimit - processed - failed);
      let products;
      let hasNextPage;
      let endCursor;
      if (Array.isArray(productIds)) {
        const batchIds = productIds.slice(exactQueueIndex, exactQueueIndex + batchSize);
        exactQueueIndex += batchIds.length;
        const exactPage = await shopify.fetchUnprocessedProductsByIds(batchIds);
        products = exactPage.products;
        hasNextPage = exactQueueIndex < productIds.length;
        endCursor = null;
        for (const skippedId of exactPage.skippedProductIds) {
          if (onProductResult) await onProductResult({ productId: skippedId, status: "skipped" });
        }
      } else {
        const fetchPage = mode === "profile-backfill"
          ? shopify.fetchProfileBackfillProducts.bind(shopify)
          : shopify.fetchUnprocessedProducts.bind(shopify);
        ({ products, hasNextPage, endCursor } = await fetchPage({
          first: batchSize,
          cursor,
          collectionHandles: collectionHandle ? [collectionHandle] : [],
        }));
      }

      // Note: we deliberately do NOT break here just because this page is
      // empty — when filtering a collection, a page can come back empty
      // (all already tagged) while later pages still have work to do.
      // The while-loop condition (hasMore) handles stopping correctly.
      for (const product of products) {
        if (stopReason || processed + failed >= effectiveLimit) break;

        product.originalDescriptionHtml = typeof shopify.fetchOriginalDescription === "function"
          ? await shopify.fetchOriginalDescription(product.id)
          : product.descriptionHtml || "";

        if (Date.now() >= deadlineMs) {
          stopReason = "time_budget";
          runLog.push(
            log(
              "Time budget for this run is up — stopping cleanly here (nothing mid-product is left half-done). The next scheduled run will pick up right where this one left off."
            )
          );
          break;
        }

        const imageUrls = ((product.media && product.media.nodes) || [])
          .map((m) => m.image && m.image.url)
          .filter(Boolean);

        try {
          if (!imageUrls.length) {
            throw new Error("Product has no images to analyze.");
          }

          const providers = [
            {
              name: "Gemini",
              configured: !!env.GEMINI_API_KEY,
              generate: () => generateProductContent({
                apiKey: env.GEMINI_API_KEY,
                visionModel: promptConfig.gemini_model_vision,
                textModel: promptConfig.gemini_model_text,
                product,
                imageUrls,
                promptConfig,
                designers,
                models,
                includeDesignProfile,
              }),
            },
            {
              name: "Groq",
              configured: !!env.GROQ_API_KEY,
              generate: () => generateWithGroq({
                apiKey: env.GROQ_API_KEY,
                model: promptConfig.groq_model,
                product,
                imageUrls,
                promptConfig,
                designers,
                models,
                includeDesignProfile,
              }),
            },
            {
              name: "Cloudflare Workers AI",
              configured: !!(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
              generate: () => generateWithCloudflare({
                apiToken: env.CLOUDFLARE_API_TOKEN,
                accountId: env.CLOUDFLARE_ACCOUNT_ID,
                model: promptConfig.cloudflare_model,
                product,
                imageUrls,
                promptConfig,
                designers,
                models,
                includeDesignProfile,
              }),
            },
          ];

          const savedRetry = mode === "profile-backfill"
            ? (progress.design_profile_retries || []).find((item) => item.product_id === product.id)
            : null;
          const { result, providerName } = savedRetry
            ? {
                result: { design_profile: savedRetry.profile },
                providerName: "Saved Design Profile retry",
              }
            : await runProviderFallback(providers, {
                unavailableProviders,
                onAttempt: (provider) => runLog.push(
                  log(`Analyzing + writing (${provider.name}) for: ${product.title}`),
                ),
                onLimited: (provider, providerErr, reason) => runLog.push(
                  log(`${provider.name} ${reason}; trying the next configured provider. (${providerErr.message})`),
                ),
              });
          if (providerName === "Groq") usedGroqCount += 1;
          if (providerName === "Cloudflare Workers AI") usedCloudflareCount += 1;
          if (savedRetry) runLog.push(log(`Retrying saved Design Profile for: ${product.title}`));
          if (includeDesignProfile && result.design_profile_error) {
            const recoveryNote = mode === "profile-backfill"
              ? "the product remains eligible for a later profile backfill"
              : "SEO processing continues";
            runLog.push(log(`Design Profile unavailable for '${product.title}'; ${recoveryNote}. (${result.design_profile_error})`));
          }

          if (mode === "preview") {
            writePreviewFile(paths.preview, processed + 1, product, result);
            runLog.push(log(`Preview written for: ${product.title}`));
          } else if (mode === "profile-backfill") {
            if (!result.design_profile) {
              throw new Error(result.design_profile_error || "AI provider returned no Design Profile.");
            }
            ensureDesignProfileRetry(progress, product, result.design_profile);
            saveProgress(paths.progress, progress);
            try {
              await shopify.writeDesignProfile(product.id, result.design_profile);
              removeDesignProfileRetry(progress, product.id);
              saveProgress(paths.progress, progress);
              runLog.push(log(`Design Profile backfilled without changing SEO for: ${product.title}`));
            } catch (profileError) {
              const retry = progress.design_profile_retries.find((item) => item.product_id === product.id);
              if (retry) {
                retry.attempts = (retry.attempts || 0) + 1;
                retry.last_attempt_at = nowIso();
                retry.last_error = String(profileError.message || profileError).slice(0, 500);
              }
              saveProgress(paths.progress, progress);
              throw profileError;
            }
          } else {
            if (profileWritesEnabled && result.design_profile) {
              ensureDesignProfileRetry(progress, product, result.design_profile);
              saveProgress(paths.progress, progress);
            }
            await shopify.backupOriginalDescription(product.id, product.descriptionHtml);

            // NOTE: "title" is intentionally never sent here — the product title is never touched.
            await shopify.updateProduct(product.id, {
              descriptionHtml: result.description_html,
              seoDescription: result.meta_description,
              tags: [...(product.tags || []), ...result.tags, "ai-done"],
            });

            // Alt text on up to first 4 images.
            const mediaWithIds = ((product.media && product.media.nodes) || []).slice(0, 4);
            for (const media of mediaWithIds) {
              try {
                await shopify.updateMediaAltText(product.id, media.id, result.image_alt_text);
              } catch (altErr) {
                log(`Alt text update failed for one image (non-fatal): ${altErr.message}`);
              }
            }

            if (profileWritesEnabled && result.design_profile) {
              try {
                await shopify.writeDesignProfile(product.id, result.design_profile);
                removeDesignProfileRetry(progress, product.id);
                saveProgress(paths.progress, progress);
                runLog.push(log(`Design Profile verified for: ${product.title}`));
              } catch (profileError) {
                const retry = progress.design_profile_retries.find(
                  (item) => item.product_id === product.id,
                );
                if (retry) {
                  retry.attempts = (retry.attempts || 0) + 1;
                  retry.last_attempt_at = nowIso();
                  retry.last_error = String(profileError.message || profileError).slice(0, 500);
                }
                saveProgress(paths.progress, progress);
                runLog.push(log(`Design Profile write deferred for '${product.title}'; SEO is complete and the profile will retry without another vision request. (${profileError.message})`));
              }
            }

            runLog.push(log(`Success! Updated Shopify product: '${product.title}'`));
          }

          processed += 1;
          if (mode !== "profile-backfill") progress.today_done += 1;
          progress.last_product_id = product.id;
          progress.last_product_title = product.title;
          updateCurrentRun(progress, {
            identity: runIdentity,
            status: "running",
            total: effectiveLimit,
            completed: processed,
            failed,
          });
          saveProgress(paths.progress, progress);
          if (onProductResult) await onProductResult({ productId: product.id, status: "completed" });
        } catch (err) {
          if (err.providerCascadeExhausted) {
            stopReason = err.allDailyQuotas ? "daily_quota" : "provider_limits";
            runLog.push(
              log(`All configured image providers are limited. Stopping cleanly; the unprocessed product will resume on the next run. (${err.message})`)
            );
            break;
          }

          failed += 1;
          updateCurrentRun(progress, {
            identity: runIdentity,
            status: "running",
            total: effectiveLimit,
            completed: processed,
            failed,
          });
          saveProgress(paths.progress, progress);
          runLog.push(log(`FAILED: '${product.title}' — ${err.message}`));
          appendFailedRow(paths.failedCsv, {
            product_id: product.id,
            title: product.title,
            handle: product.handle,
            error: err.message,
            timestamp: nowIso(),
          });
          if (onProductResult) await onProductResult({ productId: product.id, status: "failed", error: err.message });
        }

        if (!stopReason && delaySeconds > 0) {
          runLog.push(log(`Waiting ${delaySeconds}s for rate-limit guard...`));
          await sleep(delaySeconds * 1000);
        }
      }

      if (!Array.isArray(productIds)) cursor = endCursor;
      hasMore = hasNextPage;
    }
  }

  // collection_filter in config.json is an ORDERED list — each collection is
  // fully drained (or hits the run's limit) before moving to the next one.
  // Leave it empty ([]) to process the whole catalog with no particular order.
  const collectionQueue = promptConfig.collection_filter || [];

  if (Array.isArray(productIds)) {
    await drainQueue(null);
  } else if (collectionQueue.length === 0) {
    await drainQueue(null);
  } else {
    for (const handle of collectionQueue) {
      if (stopReason || processed + failed >= effectiveLimit) break;
      runLog.push(log(`Starting collection: ${handle}`));
      await drainQueue(handle);
    }
  }

  // Refresh per-collection stats (name, total, done) for the dashboard's
  // collection breakdown list — only meaningful when collection_filter is
  // in use. Cheap: only fetches {id, tags} per product, not full records.
  // This runs for EVERY configured collection on EVERY run — including
  // collections already fully finished — so if new products land in a
  // collection you already completed (e.g. "Sapphire" going from 5,000 to
  // 5,010), it's detected and surfaced here, and drainQueue() above will
  // naturally pick those new (untagged) products up on the next run since
  // it re-scans the whole collection from scratch each time.
  if (!Array.isArray(productIds) && collectionQueue.length > 0) {
    progress.collections = progress.collections || {};
    for (const handle of collectionQueue) {
      try {
        const stats = await shopify.getCollectionStats(handle);
        if (!stats) continue;

        const previous = progress.collections[handle];
        const previousTotal = previous ? previous.total : stats.total; // first time seeing this collection: no delta yet
        const newInCollection = Math.max(0, stats.total - previousTotal);

        progress.collections[handle] = { ...stats, new_since_last_check: newInCollection };

        if (newInCollection > 0) {
          runLog.push(
            log(
              `${newInCollection} new product${newInCollection === 1 ? "" : "s"} detected in "${stats.name}" — will be processed automatically on an upcoming run.`
            )
          );
        }
      } catch (err) {
        log(`Could not refresh stats for collection "${handle}" (non-fatal): ${err.message}`);
      }
    }
  }

  progress.status = stopReason ? `paused_${stopReason}` : "completed_for_today";
  progress.last_run_finished_at = nowIso();
  updateCurrentRun(progress, {
    identity: runIdentity,
    status: stopReason
      ? "partially_completed"
      : failed > 0 && processed === 0
        ? "failed"
        : failed > 0
          ? "partially_completed"
          : "completed",
    total: effectiveLimit,
    completed: processed,
    failed,
  });
  saveProgress(paths.progress, progress);
  appendHistoryEntry(paths.history, progress, { processed, failed });

  return { processed, failed, stopReason, usedGroqCount, usedCloudflareCount };
}

module.exports = { runBatch };
