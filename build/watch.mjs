import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  build,
  outputDirectory,
  sourceDirectory,
  staticFiles,
} from "./build.mjs";
import { startDevServer } from "./serve.mjs";

const devServerHost = "127.0.0.1";
const devServerPort = Number(process.env.PORT ?? 8080);

const rebuildDelayInMilliseconds = 100;

const directoryWatchers = new Map();

const devServer = startDevServer({
  rootDirectory: outputDirectory,
  host: devServerHost,
  port: devServerPort,
});

let rebuildTimer;
let isBuilding = false;
let hasPendingChanges = false;

async function listSourceDirectories() {
  const entries = await readdir(sourceDirectory, {
    recursive: true,
    withFileTypes: true,
  });

  const subdirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name));

  return [sourceDirectory, ...subdirectories];
}

function watchDirectoryNonRecursively(directory) {
  const watcher = watch(directory, scheduleRebuild);

  watcher.on("error", () => {
    watcher.close();
    directoryWatchers.delete(directory);
  });

  directoryWatchers.set(directory, watcher);
}

async function watchNewSourceDirectories() {
  const directories = await listSourceDirectories();
  const unwatchedDirectories = directories.filter(
    (directory) => !directoryWatchers.has(directory),
  );

  for (const directory of unwatchedDirectories) {
    watchDirectoryNonRecursively(directory);
  }
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, rebuildDelayInMilliseconds);
}

async function buildAndReloadBrowsers() {
  try {
    await build();
    devServer.reload();
  } catch (error) {
    console.error(`build failed: ${error.message}`);
  }
}

async function rebuild() {
  if (isBuilding) {
    hasPendingChanges = true;
    return;
  }

  isBuilding = true;

  await buildAndReloadBrowsers();
  await watchNewSourceDirectories();

  isBuilding = false;

  if (!hasPendingChanges) return;

  hasPendingChanges = false;
  scheduleRebuild();
}

function watchStaticFiles() {
  watch(".", (_eventType, fileName) => {
    if (!staticFiles.includes(fileName)) return;

    scheduleRebuild();
  });
}

await rebuild();

watchStaticFiles();

console.log("watching for changes");
