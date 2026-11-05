import { isWindows } from "./platform";

/** Path separators: Windows takes `\` and `/`; elsewhere only `/` (a `\` can be part of a name). */
const SEPARATOR = isWindows ? /[\\/]/ : /\//;

/** The last part of a path: the file (or folder) name. */
export const basename = (path: string) => path.split(SEPARATOR).pop() || path;

/** The folder a path is in. */
export const dirname = (path: string) => {
  const parts = path.split(SEPARATOR);
  return parts.length > 1 ? path.slice(0, path.length - parts[parts.length - 1].length - 1) : "";
};

/** `name` in `folder`, joined with the separator the folder already uses. */
export const joinPath = (folder: string, name: string) => `${folder}${isWindows && folder.includes("\\") ? "\\" : "/"}${name}`;
