import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const directiveComment =
  /^\s*(?:\/\/|\/\*)\s*(?:eslint-disable(?:-next-line)?|oxlint-disable(?:-next-line)?|@ts-(?:nocheck|ignore|expect-error)|prettier-ignore)(?:\s+.*?)?(?:\*\/)?\s*$/u;

const cleanupHandshakeStart = `function __prepareWasmEnvCleanupWithTurns() {
  if (__emnapiWasmEnvCleanupPrepared || __emnapiWasmEnvCleanupPreparing) {
    return
  }`;
const retryableCleanupHandshakeStart = `function __prepareWasmEnvCleanupWithTurns() {
  if (__emnapiWasmEnvCleanupPrepared) {
    return
  }
  if (__emnapiWasmEnvCleanupPreparing) {
    return __finishParkedWasmEnvCleanup?.retry?.()
  }`;
const cleanupPollStart = `  return (async () => {`;
const retryableCleanupPollStart = `  const pollCleanup = () => (async () => {`;
const nodeCleanupPollEnd = `  })().then(finishCleanupUnlessCrashed, finishCleanupUnlessCrashed)`;
const retryableNodeCleanupPollEnd = `  })().then(finishCleanupUnlessCrashed)
  finishCleanup.retry = pollCleanup
  return pollCleanup()`;
const browserCleanupPollEnd = `  })().then(finishCleanup, finishCleanup)`;
const retryableBrowserCleanupPollEnd = `  })().then(finishCleanup)
  finishCleanup.retry = pollCleanup
  return pollCleanup()`;

export const normalizeGeneratedLoader = (content) =>
  content
    .split("\n")
    .filter((line) => !directiveComment.test(line))
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(
      cleanupHandshakeStart,
      retryableCleanupHandshakeStart,
    )
    .replace(cleanupPollStart, retryableCleanupPollStart)
    .replace(
      nodeCleanupPollEnd,
      retryableNodeCleanupPollEnd,
    )
    .replace(
      browserCleanupPollEnd,
      retryableBrowserCleanupPollEnd,
    );

export const normalizeGeneratedLoaderFile = async (
  file,
) => {
  const content = await readFile(file, "utf8");
  await writeFile(file, normalizeGeneratedLoader(content));
};

if (
  process.argv.at(1) !== undefined &&
  import.meta.url === pathToFileURL(process.argv.at(1)).href
) {
  await Promise.all(
    process.argv
      .slice(2)
      .map((file) => normalizeGeneratedLoaderFile(file)),
  );
}
