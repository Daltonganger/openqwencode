#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { linkDevice } from './plugin.js';

async function main() {
  const command = process.argv[2] ?? 'link';
  if (command !== 'link') {
    console.error('Usage: openqwencode link');
    process.exitCode = 1;
    return;
  }

  await linkDevice();
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { linkDevice };
