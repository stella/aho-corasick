const GENERATOR_DIRECTIVE =
  /^\s*(?:\/\/\s*@ts-nocheck\b.*|\/\*\s*eslint-disable(?:\s+[^*]*)?\*\/|\/\/\s*(?:eslint|prettier|biome)-disable\b.*)\r?\n?/gmu;

const UNSAFE_CLEANUP_HANDSHAKE = `await new Promise((resolve) => {
        __scheduleMacrotask(resolve)
      })`;

const SAFE_CLEANUP_HANDSHAKE = `await new Promise((resolve, reject) => {
        let finishedDuringScheduling = false
        let scheduling = true
        const finish = () => {
          if (scheduling) {
            finishedDuringScheduling = true
            return
          }
          resolve()
        }
        try {
          __scheduleMacrotask(finish)
        } catch (error) {
          reject(error)
          return
        }
        scheduling = false
        if (finishedDuringScheduling) {
          resolve()
        }
      })`;

/** Normalize directives and cleanup scheduling emitted by the NAPI generator. */
export const normalizeGeneratedLoader = (source) =>
  source
    .replace(GENERATOR_DIRECTIVE, "")
    .replaceAll(
      UNSAFE_CLEANUP_HANDSHAKE,
      SAFE_CLEANUP_HANDSHAKE,
    )
    .replace(/[ \t]+$/gmu, "");
