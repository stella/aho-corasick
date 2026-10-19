import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const directiveComment =
  /^\s*(?:\/\/|\/\*)\s*(?:eslint-disable(?:-next-line)?|oxlint-disable(?:-next-line)?|@ts-(?:nocheck|ignore|expect-error)|prettier-ignore)(?:\s+.*?)?(?:\*\/)?\s*$/u;

export const normalizeGeneratedLoader = (content) =>
  content
    .split("\n")
    .filter((line) => !directiveComment.test(line))
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");

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
