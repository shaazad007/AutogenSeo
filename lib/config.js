"use strict";

const fs = require("fs");
const path = require("path");

// Load .env for local runs only. In GitHub Actions the secrets are already
// present as real environment variables, so this is a harmless no-op there.
try {
  require("dotenv").config();
} catch (e) {
  // dotenv not installed / not needed — fine in CI.
}

const ROOT = path.resolve(__dirname, "..");

function readJson(fileName, fallback) {
  const filePath = path.join(ROOT, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${fileName}: ${err.message}`);
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in your .env file locally, or as a GitHub Actions secret.`
    );
  }
  return value;
}

const promptConfig = readJson("config.json", {});
const designers = readJson("designers.json", []);
const models = readJson("models.json", []);

const env = {
  SHOPIFY_STORE: requireEnv("SHOPIFY_STORE"),
  SHOPIFY_CLIENT_ID: requireEnv("SHOPIFY_CLIENT_ID"),
  SHOPIFY_CLIENT_SECRET: requireEnv("SHOPIFY_CLIENT_SECRET"),
  GEMINI_API_KEY: requireEnv("GEMINI_API_KEY"),
};

module.exports = {
  ROOT,
  env,
  promptConfig,
  designers,
  models,
  paths: {
    progress: path.join(ROOT, "progress.json"),
    failedCsv: path.join(ROOT, "failed.csv"),
    preview: path.join(ROOT, "preview"),
    runLog: path.join(ROOT, "docs", "last-run-log.json"),
  },
};
