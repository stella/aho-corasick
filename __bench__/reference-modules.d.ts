// Reference implementation compared against in the benchmarks; the package
// ships no type declarations.

declare module "ahocorasick" {
  export default class AhoCorasick {
    constructor(keywords: readonly string[]);
    /** Each hit is the end index and the keywords that end there. */
    search(text: string): [number, string[]][];
  }
}
