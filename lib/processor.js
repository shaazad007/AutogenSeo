"use strict";

const fs = require("fs");
const path = require("path");

const { sleep, log, todayDateString, nowIso, csvEscape } = require("./util");
const { generateProductContent } = require("./generate");
const { generateWithGroq } = require("./groq");

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

DESCRIPTION HTML:
${result.description_html}
`;
  fs.writeFileSync(filePath, content);
}

/**
 * Process up to `limit` unprocessed products.
 * mode: "preview" (writes to /preview, touches nothing on Shopify) or "live".
 * deadlineMs: absolute Date.now() timestamp — the run stops cleanly (never
 *   mid-product) once this is reached, well before GitHub's hard 6-hour job
 *   limit, so progress is always committed instead of the job getting killed.
 */
async function runBatch({ shopify, config, mode, limit, runLog, deadlineMs = Infinity }) {
  const { promptConfig, designers, models, env, paths } = config;

  const progress = loadProgress(paths.progress);
  progress.status = "running";
  progress.last_run_started_at = nowIso();
  saveProgress(paths.progress, progress);

  const dailyCap = promptConfig.daily_cap || 1000;
  const delaySeconds = promptConfig.delay_seconds || 7;
  const effectiveLimit = Math.min(limit, mode === "preview" ? limit : dailyCap - progress.today_done);

  if (effectiveLimit <= 0) {
    log("Today's cap is already reached. Nothing to do — try again tomorrow.");
    progress.status = "idle";
    saveProgress(paths.progress, progress);
    return { processed: 0, failed: 0 };
  }

  let processed = 0;
  let failed = 0;
  let stopReason = null; // set to "time_budget" or "daily_quota" (only when no Groq fallback available) if we stop early
  let geminiExhausted = false; // once true, every remaining product this run uses Groq instead
  let usedGroqCount = 0;

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
   * budget, or Gemini's daily quota is exhausted.
   * `collectionHandle` = null means no collection restriction at all.
   */
  async function drainQueue(collectionHandle) {
    let cursor = null;
    let hasMore = true;

    while (hasMore && !stopReason && processed + failed < effectiveLimit) {
      const batchSize = Math.min(25, effectiveLimit - processed - failed);
      const { products, hasNextPage, endCursor } = await shopify.fetchUnprocessedProducts({
        first: batchSize,
        cursor,
        collectionHandles: collectionHandle ? [collectionHandle] : [],
      });

      // Note: we deliberately do NOT break here just because this page is
      // empty — when filtering a collection, a page can come back empty
      // (all already tagged) while later pages still have work to do.
      // The while-loop condition (hasMore) handles stopping correctly.
      for (const product of products) {
        if (stopReason || processed + failed >= effectiveLimit) break;

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

          const hasGroq = !!env.GROQ_API_KEY;
          let result;

          if (!geminiExhausted) {
            try {
              runLog.push(log(`Analyzing + writing (Gemini, 1 combined call) for: ${product.title}`));
              result = await generateProductContent({
                apiKey: env.GEMINI_API_KEY,
                visionModel: promptConfig.gemini_model_vision,
                textModel: promptConfig.gemini_model_text,
                product,
                imageUrls,
                promptConfig,
                designers,
                models,
              });
            } catch (geminiErr) {
              if (geminiErr.dailyQuotaExhausted && hasGroq) {
                geminiExhausted = true;
                runLog.push(
                  log(
                    `Gemini's daily quota is used up for now — switching to Groq for the rest of this run (and it'll keep using Groq until Gemini's quota resets). (${geminiErr.message})`
                  )
                );
                // fall through to the Groq branch below for THIS product too — not counted as a failure
              } else {
                throw geminiErr;
              }
            }
          }

          if (geminiExhausted) {
            runLog.push(log(`Analyzing + writing (Groq fallback, 1 combined call) for: ${product.title}`));
            result = await generateWithGroq({
              apiKey: env.GROQ_API_KEY,
              model: promptConfig.groq_model,
              product,
              imageUrls,
              promptConfig,
              designers,
              models,
            });
            usedGroqCount += 1;
          }

          if (mode === "preview") {
            writePreviewFile(paths.preview, processed + 1, product, result);
            runLog.push(log(`Preview written for: ${product.title}`));
          } else {
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

            runLog.push(log(`Success! Updated Shopify product: '${product.title}'`));
          }

          processed += 1;
          progress.today_done += 1;
          progress.last_product_id = product.id;
          progress.last_product_title = product.title;
          saveProgress(paths.progress, progress);
        } catch (err) {
          if (err.dailyQuotaExhausted) {
            // Gemini's daily quota is exhausted AND there's no Groq key
            // configured to fall back to — stop the whole run cleanly here
            // rather than burning through every remaining product as a
            // "failure". The next scheduled run (a few hours later) will
            // simply continue from here automatically.
            stopReason = "daily_quota";
            runLog.push(
              log(
                `Gemini's daily quota is used up for now (no GROQ_API_KEY configured to fall back to). Stopping this run cleanly — it will resume automatically on the next scheduled run. (${err.message})`
              )
            );
            break;
          }

          failed += 1;
          runLog.push(log(`FAILED: '${product.title}' — ${err.message}`));
          appendFailedRow(paths.failedCsv, {
            product_id: product.id,
            title: product.title,
            handle: product.handle,
            error: err.message,
            timestamp: nowIso(),
          });
        }

        if (!stopReason && delaySeconds > 0) {
          runLog.push(log(`Waiting ${delaySeconds}s for rate-limit guard...`));
          await sleep(delaySeconds * 1000);
        }
      }

      cursor = endCursor;
      hasMore = hasNextPage;
    }
  }

  // collection_filter in config.json is an ORDERED list — each collection is
  // fully drained (or hits the run's limit) before moving to the next one.
  // Leave it empty ([]) to process the whole catalog with no particular order.
  const collectionQueue = promptConfig.collection_filter || [];

  if (collectionQueue.length === 0) {
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
  if (collectionQueue.length > 0) {
    progress.collections = progress.collections || {};
    for (const handle of collectionQueue) {
      try {
        const stats = await shopify.getCollectionStats(handle);
        if (stats) progress.collections[handle] = stats;
      } catch (err) {
        log(`Could not refresh stats for collection "${handle}" (non-fatal): ${err.message}`);
      }
    }
  }

  progress.status = stopReason ? `paused_${stopReason}` : "completed_for_today";
  progress.last_run_finished_at = nowIso();
  saveProgress(paths.progress, progress);
  appendHistoryEntry(paths.history, progress, { processed, failed });

  return { processed, failed, stopReason, usedGroqCount };
}

module.exports = { runBatch };
