#!/usr/bin/env node

/**
 * OmniFocus semantic index — standalone entry point.
 *
 * Run manually:  node dist/indexer/index.js
 * Via npm:       npm run index
 * Via launchd:   WatchPaths triggers on OmniFocus data changes
 */

import { syncIndex } from './sync.js';

async function main() {
  const start = Date.now();
  console.error(`[${new Date().toISOString()}] OmniFocus semantic index starting...`);

  try {
    const stats = await syncIndex();
    const elapsed = Date.now() - start;
    console.error(
      `[${new Date().toISOString()}] Index complete in ${elapsed}ms: ` +
      `${stats.total} items, ${stats.added} added, ${stats.updated} updated, ` +
      `${stats.deleted} deleted, ${stats.embedded} embedded`
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Index failed:`, err);
    process.exit(1);
  }
}

main();
