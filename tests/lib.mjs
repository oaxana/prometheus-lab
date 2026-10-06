// Shared test helpers.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
fs.mkdirSync(path.join(HERE, 'screens'), { recursive: true });

// Uses your installed Google Chrome. No Chrome? Run `npx playwright install chromium` and set PW_CHANNEL=chromium.
export const launch = () => chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', headless: true });
