"use strict";

const fs = require("fs");
const path = require("path");

const { sleep, log, todayDateString, nowIso, csvEscape } = require("./util");
const { analyzeImages } = require("./analyzer");
const { generateDescription } = require("./description");

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
 */
async function runBatch({ shopify, config, mode, limit, runLog }) {
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

  // Refresh total/remaining counts for the dashboard's "estimated days left".
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
  } catch (err) {
    log(`Could not refresh totals (non-fatal): ${err.message}`);
  }

  /**
   * Process one "queue" of products (either the whole catalog, or a single
   * collection) until it runs out or the overall limit is reached.
   * `collectionHandle` = null means no collection restriction at all.
   */
  async function drainQueue(collectionHandle) {
    let cursor = null;
    let hasMore = true;

    while (hasMore && processed + failed < effectiveLimit) {
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
        if (processed + failed >= effectiveLimit) break;

        const imageUrls = (product.media || [])
          .map((m) => m.image && m.image.url)
          .filter(Boolean);

        try {
          if (!imageUrls.length) {
            throw new Error("Product has no images to analyze.");
          }

          runLog.push(log(`Fetching + analyzing images for: ${product.title}`));

          const attributes = await analyzeImages(
            env.GEMINI_API_KEY,
            promptConfig.gemini_model_vision,
            imageUrls,
            promptConfig,
            {
              title: product.title,
              vendor: product.vendor,
              existingDescriptionText: (product.descriptionHtml || "").replace(/<[^>]*>/g, " ").slice(0, 400),
            }
          );

          runLog.push(log(`Generating description for: ${product.title}`));

          const result = await generateDescription({
            apiKey: env.GEMINI_API_KEY,
            model: promptConfig.gemini_model_text,
            product,
            attributes,
            promptConfig,
            designers,
            models,
          });

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
            const mediaWithIds = (product.media || []).slice(0, 4);
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

        if (delaySeconds > 0) {
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
      if (processed + failed >= effectiveLimit) break;
      runLog.push(log(`Starting collection: ${handle}`));
      await drainQueue(handle);
    }
  }

  progress.status = "completed_for_today";
  progress.last_run_finished_at = nowIso();
  saveProgress(paths.progress, progress);

  return { processed, failed };
}

module.exports = { runBatch };

