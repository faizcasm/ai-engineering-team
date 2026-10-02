/** Product identity and version information. */

export const NAME = "AI Engineering Team";
export const CLI_NAME = "aet";
export const VERSION = "1.0.0";

export const AUTHOR = "Faizan Hameed";
export const AUTHOR_URL = "https://faizcasm.me";
export const ORGANIZATION = "Ryuksaidso";
export const REPO_URL = "https://github.com/faizcasm/ai-engineering-team";
export const LICENSE = "MIT";

/** Long-form author credit used in `--version`, `about` and docs. */
export const CREDIT = `${AUTHOR} (${AUTHOR_URL}) - Founder of ${ORGANIZATION}`;

export function versionString(): string {
  return `${CLI_NAME}/${VERSION} (${process.platform}-${process.arch}) node-${process.versions.node}`;
}
