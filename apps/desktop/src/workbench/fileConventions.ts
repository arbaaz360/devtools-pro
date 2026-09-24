/**
 * A file's own encoding marker and line-ending style, kept through an edit and a save.
 *
 * The editor is a <textarea>, whose value turns every CRLF into LF, and the host reads a
 * file's text without its BOM. So the text a tab holds has neither, and writing it back
 * as it stands rewrote every line of a Windows file and dropped its BOM (the review's
 * AST-026). The owner's decision: Save writes the file's own conventions back. A file
 * with mixed line endings gets its dominant one, and the Saved notice says so. A tab with
 * no file of its own is saved as UTF-8 with LF.
 *
 * Only UTF-8 files are editable (`editable` in the host), so a BOM flag and an ending are
 * everything a file can carry here.
 */

export interface FileConventions {
  /** The file starts with EF BB BF. */
  bom: boolean;
  /** The line ending Save writes. */
  eol: "\n" | "\r\n";
  /** The file had both kinds; Save made them all `eol`. */
  mixed: boolean;
}

export const PLAIN: FileConventions = { bom: false, eol: "\n", mixed: false };

/** The conventions of the text a file was opened or last saved with. */
export function conventionsOf(file: { encoding: string; preview: string } | null | undefined): FileConventions {
  if (!file) return PLAIN;
  let crlf = 0;
  let lf = 0;
  for (let at = file.preview.indexOf("\n"); at !== -1; at = file.preview.indexOf("\n", at + 1)) {
    if (at > 0 && file.preview[at - 1] === "\r") crlf += 1;
    else lf += 1;
  }
  return { bom: file.encoding === "UTF-8 BOM", eol: crlf > lf ? "\r\n" : "\n", mixed: crlf > 0 && lf > 0 };
}

/** `text` as the file writes it: every line ending made `eol`, and the BOM if it had one. */
export function applyConventions(text: string, conventions: FileConventions): string {
  const lines = text.replace(/\r\n?/g, "\n");
  const body = conventions.eol === "\r\n" ? lines.replace(/\n/g, "\r\n") : lines;
  return conventions.bom && !body.startsWith("\ufeff") ? `\ufeff${body}` : body;
}

/** What the Saved notice adds, if anything: only a change the user did not make is news. */
export function conventionsNotice(conventions: FileConventions): string {
  return conventions.mixed ? ` (line endings made ${conventions.eol === "\r\n" ? "CRLF" : "LF"} throughout)` : "";
}
