import type { FileActionContext } from "./file-actions";

/** All non-PM inputs to native serialization, including their write-intent flags.
 * React replaces these state values rather than mutating them in place. Capture
 * the values now, not the context object: refs expose the next render's values.
 * Keep this list aligned with buildDocBytes and doc-dirty when adding inputs.
 * Body edits, password intents and font-settling retain their existing fences.
 */
export const saveMetadataKeys = [
  "doc",
  "section",
  "sectionDirty",
  "sections",
  "sectionsDirty",
  "trailingStartType",
  "pageCount",
  "pageColor",
  "pageColorDirty",
  "header",
  "headerDirty",
  "footer",
  "footerDirty",
  "hfVariants",
  "hfVariantsDirty",
  "sectionHfEdits",
  "hfLinks",
  "titlePg",
  "titlePgDirty",
  "evenOddHf",
  "evenOddHfDirty",
  "mirrorMargins",
  "mirrorMarginsDirty",
  "pgNumEdit",
  "pgNumDirtySections",
  "pendingNumbering",
  "numberingDirty",
  "defaultFonts",
  "styleUpserts",
  "comments",
  "commentsDirty",
  "watermark",
  "watermarkDirty",
  "watermarkStyle",
  "watermarkPicture",
  "inkAnnotations",
  "inksDirty",
  "footnotes",
  "endnotes",
  "notesDirty",
  "sources",
  "sourcesDirty",
  "zoteroDocumentData",
  "zoteroDocumentDataDirty",
  "themeFonts",
  "themeFontsDirty",
  "themeColors",
  "themeColorsDirty",
  "trackChanges",
  "trackRevisionsDirty",
  "protection",
  "protectionDirty",
  "writeProtection",
  "writeProtectionDirty",
  "removePersonalInfo",
  "removePersonalInfoDirty",
] as const satisfies readonly (keyof FileActionContext)[];

export function captureSaveMetadata(ctx: FileActionContext) {
  const values = saveMetadataKeys.map((key) => ctx[key]);
  const color = ctx.getPageColorSaveState?.();
  const margins = ctx.getMirrorMarginsSaveState?.();
  const evenOddHf = ctx.getEvenOddHfSaveState?.();
  return {
    // Field names only; never return document/user values in diagnostics.
    changedFields(current: FileActionContext) {
      return saveMetadataKeys.filter((key, index) => !Object.is(values[index], current[key]));
    },
    changed(current: FileActionContext): boolean {
      const latestColor = current.getPageColorSaveState?.();
      if (color && (!color.ready || !latestColor?.ready || color.token !== latestColor.token)) return true;
      const latestMargins = current.getMirrorMarginsSaveState?.();
      if (margins && (!margins.ready || !latestMargins?.ready || margins.token !== latestMargins.token)) return true;
      const latestEvenOddHf = current.getEvenOddHfSaveState?.();
      if (evenOddHf && (!evenOddHf.ready || !latestEvenOddHf?.ready || evenOddHf.token !== latestEvenOddHf.token)) return true;
      return saveMetadataKeys.some(
        (key, index) => !Object.is(values[index], current[key]),
      );
    },
  };
}
