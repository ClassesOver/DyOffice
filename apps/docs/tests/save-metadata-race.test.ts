import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Editor } from "@tiptap/core";
import { parseDocx, readSections, readPageColor } from "@genoffice/docx-engine";
import { buildDocx } from "../../../packages/docx-engine/tests/helpers/build-docx";
import { editorExtensions } from "../src/renderer/editor/extensions";
import { blocksToPmDoc, pmDocOptions } from "../src/renderer/editor/convert";
import {
  noteDocumentSwapped,
  save,
  type FileActionContext,
} from "../src/renderer/file-actions";
import { createEvenOddHfState } from "../src/renderer/even-odd-hf-state";
import { createMirrorMarginsState } from "../src/renderer/mirror-margins-state";
import { EMPTY_HF_VARIANTS } from "../src/renderer/doc-state";

(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

const SETTINGS_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml";
const settingsPart = (inner: string) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:settings>`;

const dirs: string[] = [];
const editors: Editor[] = [];
afterEach(async () => {
  for (const editor of editors.splice(0)) editor.destroy();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function fixture(
  settingsInner: string,
  trackChanges: boolean,
  dirty: boolean,
) {
  noteDocumentSwapped();
  const bytes = await buildDocx({
    bodyXml: "<w:p><w:r><w:t>body</w:t></w:r></w:p>",
    extraParts: [
      {
        path: "word/settings.xml",
        xml: settingsPart(settingsInner),
        contentType: SETTINGS_TYPE,
      },
    ],
  });
  const parsed = await parseDocx(bytes);
  const dir = await mkdtemp(join(tmpdir(), "genoffice-track-flag-"));
  dirs.push(dir);
  const path = join(dir, "fixture.docx");
  await writeFile(path, bytes);
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: editorExtensions,
    editorProps: { handleScrollToSelection: () => true },
    content: blocksToPmDoc(
      parsed.blocks,
      readSections(parsed),
      pmDocOptions(parsed),
    ),
  });
  editors.push(editor);
  const state = {
    editor,
    doc: {
      parsed,
      filePath: path as string | undefined,
      fileName: "fixture.docx",
      hash: "fixture",
    },
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    inkAnnotations: [],
    sections: readSections(parsed),
    sectionsDirty: [],
    pgNumDirtySections: [],
    hfVariants: EMPTY_HF_VARIANTS,
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    styleUpserts: {},
    pendingNumbering: { newDefs: [], restartNums: [] },
    pageColor: null as string | null,
    pageColorDirty: false,
    trackChanges,
    trackRevisionsDirty: dirty,
  };
  const noop = () => {};
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === "getCurrentSaveContext") return () => ctx;
      if (prop === "setPageColor")
        return (v: string | null) => {
          target.pageColor = v;
        };
      if (prop === "setPageColorDirty")
        return (v: boolean) => {
          target.pageColorDirty = v;
        };
      if (prop === "setDoc")
        return (updater: (prev: typeof state.doc) => typeof state.doc) => {
          target.doc = updater(target.doc);
        };
      if (prop in target) return Reflect.get(target, prop);
      if (
        typeof prop === "string" &&
        (/^set[A-Z]/.test(prop) || /^on[A-Z]/.test(prop))
      )
        return noop;
      return undefined;
    },
  }) as unknown as FileActionContext;
  window.desktop = {
    saveDocx: async (target: string, data: ArrayBuffer) => {
      await writeFile(target, new Uint8Array(data));
      return { ok: true };
    },
  } as unknown as typeof window.desktop;
  return { parsed, ctx, path, state };
}

it("preserves newer page-color state while an older native save is in flight", async () => {
  const { ctx, state, path } = await fixture("", false, false);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  window.desktop.saveDocx = async (target, data) => {
    await writeFile(target, new Uint8Array(data));
    entered();
    await gate;
    return { ok: true };
  };
  const saving = save(ctx, false, false);
  await waiting;
  state.pageColor = "FF0000";
  state.pageColorDirty = true;
  release();
  expect(await saving).toBe(true);
  expect(state.pageColor).toBe("FF0000");
  expect(state.pageColorDirty).toBe(true);
  expect(state.saveIncompleteRef.current).toBe(true);
  expect(readPageColor(await parseDocx(await readFile(path)))).not.toBe(
    "FF0000",
  );
  // A subsequent save captures the newer metadata and may then clear dirty.
  expect(await save(ctx, false, false)).toBe(true);
  expect(readPageColor(await parseDocx(await readFile(path)))).toBe("FF0000");
  expect(state.pageColorDirty).toBe(false);
  expect(state.saveIncompleteRef.current).toBe(false);
});

it.each([
  ["section", { pageWidth: 10000 }],
  ["sections", []],
  ["trailingStartType", "oddPage"],
  ["header", { text: "new header" }],
  ["footer", { text: "new footer" }],
  ["hfVariants", { headerFirst: { text: "first" } }],
  ["sectionHfEdits", { "0:header": { text: "new" } }],
  ["hfLinks", { "0:header": true }],
  ["pgNumEdit", { start: 10 }],
  ["pendingNumbering", { newDefs: [], restartNums: [] }],
  ["styleUpserts", { NewStyle: {} }],
  ["defaultFonts", { ascii: "Arial" }],
  ["titlePg", true],
  ["evenOddHf", true],
  ["mirrorMargins", true],
  ["trackChanges", true],
  ["comments", [{ id: "new" }]],
  ["watermark", "new watermark"],
  ["watermarkStyle", { color: "FF0000" }],
  ["watermarkPicture", { data: "new picture" }],
  ["inkAnnotations", [{ id: "new" }]],
  ["footnotes", [{ id: "new" }]],
  ["endnotes", [{ id: "new" }]],
  ["sources", [{ id: "new" }]],
  ["zoteroDocumentData", "new data"],
  ["themeFonts", { major: "Arial" }],
  ["themeColors", { accent1: "FF0000" }],
  ["protection", { enforced: true }],
  ["writeProtection", { hash: "new" }],
  ["removePersonalInfo", true],
] as const)(
  "keeps a later %s value instead of rebasing it from old bytes",
  async (key, value) => {
    const { ctx, state } = await fixture("", false, false);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    window.desktop.saveDocx = async () => {
      entered();
      await gate;
      return { ok: true };
    };
    // React passes an old render snapshot; only the live accessor sees the new render.
    const snapshot = new Proxy(
      { ...state },
      {
        get: (target, prop) =>
          prop in target ? Reflect.get(target, prop) : Reflect.get(ctx, prop),
      },
    ) as unknown as FileActionContext;
    const saving = save(snapshot, false, false);
    await waiting;
    Object.assign(state, { [key]: value });
    release();
    expect(await saving).toBe(true);
    expect(state.saveIncompleteRef.current).toBe(true);
    expect(Reflect.get(state, key)).toBe(value);
  },
);

it("does not apply an old native save receipt to a newly opened document", async () => {
  const { ctx, state } = await fixture("", false, false);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  window.desktop.saveDocx = async () => {
    entered();
    await gate;
    return { ok: true };
  };
  let afterSaveCalls = 0;
  Object.assign(state, {
    hostLifecycle: {
      beforeSave: async () => {},
      afterSave: () => {
        afterSaveCalls++;
      },
    },
  });
  const saving = save(ctx, false, false);
  await waiting;
  noteDocumentSwapped();
  const next = {
    ...state.doc,
    filePath: "/different.docx",
    fileName: "different.docx",
  };
  state.doc = next;
  state.pageColor = "00FF00";
  state.pageColorDirty = true;
  release();
  expect(await saving).toBe(false);
  expect(afterSaveCalls).toBe(0);
  expect(state.doc).toBe(next);
  expect(state.doc.filePath).toBe("/different.docx");
  expect(state.pageColor).toBe("00FF00");
  expect(state.pageColorDirty).toBe(true);
});

it("does not reuse a completed old Save New path for a replacement pathless document", async () => {
  const { ctx, state } = await fixture("", false, false);
  state.doc = { ...state.doc, filePath: undefined };
  let entered!: () => void,
    release!: () => void,
    creations = 0;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  window.desktop.saveDocxNew = async () => {
    creations++;
    if (creations === 1) {
      entered();
      await gate;
    }
    return {
      ok: true,
      path: creations === 1 ? "/old-created.docx" : "/new-created.docx",
    };
  };
  window.desktop.saveDocx = async () => {
    throw new Error("must create, not overwrite old path");
  };
  const saving = save(ctx, false, false);
  await waiting;
  noteDocumentSwapped();
  const next = { ...state.doc, filePath: undefined, fileName: "new.docx" };
  state.doc = next;
  release();
  expect(await saving).toBe(false);
  expect(state.doc).toBe(next);
  expect(await save(ctx, false, false)).toBe(true);
  expect(creations).toBe(2);
  expect(state.doc.filePath).toBe("/new-created.docx");
});

it("failed saves leave newer metadata dirty without rebasing state", async () => {
  const { ctx, state } = await fixture("", false, false);
  window.desktop.saveDocx = async () => {
    state.pageColor = "FF0000";
    state.pageColorDirty = true;
    return { ok: false, error: "controlled write failure" };
  };
  expect(await save(ctx, false, false)).toBe(false);
  expect(state.pageColor).toBe("FF0000");
  expect(state.pageColorDirty).toBe(true);
});

it("does not write stale paths when the document changes while beforeSave reconciles", async () => {
  const { ctx, state } = await fixture("", false, false);
  let entered!: () => void,
    release!: () => void,
    writes = 0;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  Object.assign(state, {
    hostLifecycle: {
      beforeSave: async () => {
        entered();
        await gate;
      },
      afterSave: () => {},
    },
  });
  window.desktop.saveDocx = async () => {
    writes++;
    return { ok: true };
  };
  const saving = save(ctx, false, false);
  await waiting;
  noteDocumentSwapped();
  state.doc = { ...state.doc, filePath: "/new-document.docx" };
  release();
  expect(await saving).toBe(false);
  expect(writes).toBe(0);
});

it('does not mark clean when page-color intent is pending before React context updates', async () => {
  const { ctx, state } = await fixture('', false, false)
  let token = {},
    ready = true
  Object.assign(state, { getPageColorSaveState: () => ({ token, ready }) })
  window.desktop.saveDocx = async () => {
    token = {}
    ready = false
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
})
it('keeps a save incomplete if page-color input was unrendered when capture began', async () => {
  const { ctx, state } = await fixture('', false, false)
  const token = {}
  let ready = false
  Object.assign(state, { getPageColorSaveState: () => ({ token, ready }) })
  window.desktop.saveDocx = async () => {
    ready = true
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(false)
})

it('does not mark clean when mirror-margins intent is pending before React context updates', async () => {
  const { ctx, state } = await fixture('', false, false)
  let token = {},
    ready = true
  Object.assign(state, { getMirrorMarginsSaveState: () => ({ token, ready }) })
  window.desktop.saveDocx = async () => {
    token = {}
    ready = false
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
})
it('keeps a save incomplete if mirror-margins input was unrendered when capture began', async () => {
  const { ctx, state } = await fixture('', false, false)
  const token = {}
  let ready = false
  Object.assign(state, { getMirrorMarginsSaveState: () => ({ token, ready }) })
  window.desktop.saveDocx = async () => {
    ready = true
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(false)
})

it('retries pending mirror-margin intent into actual DOCX settings bytes', async () => {
  const { ctx, state, path } = await fixture('', false, false)
  const input = createMirrorMarginsState()
  const render = () => {
    Object.assign(state, {
      mirrorMargins: input.getSnapshot().enabled,
      mirrorMarginsDirty: input.getSnapshot().dirty,
    })
    input.markRendered(input.getSnapshot().token)
  }
  Object.assign(state, {
    getMirrorMarginsSaveState: input.getSaveState,
    setMirrorMargins: input.setEnabled,
    setMirrorMarginsDirty: input.setDirty,
  })
  render()
  let writes = 0
  window.desktop.saveDocx = async (target, data) => {
    await writeFile(target, new Uint8Array(data))
    if (++writes === 1) {
      input.setEnabled(true)
      input.setDirty(true)
    }
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
  expect(input.getSnapshot()).toMatchObject({ enabled: true, dirty: true })
  expect((await parseDocx(await readFile(path))).mirrorMargins ?? false).toBe(false)
  render()
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(false)
  expect((await parseDocx(await readFile(path))).mirrorMargins).toBe(true)
  expect(input.getSnapshot()).toMatchObject({ enabled: true, dirty: false })
})

it('does not mark clean when even-odd-header intent is pending before React context updates', async () => {
  const { ctx, state } = await fixture('', false, false)
  let token = {},
    ready = true
  Object.assign(state, { getEvenOddHfSaveState: () => ({ token, ready }) })
  window.desktop.saveDocx = async () => {
    token = {}
    ready = false
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
})
it('keeps a save incomplete if even-odd-header input was unrendered when capture began', async () => {
  const { ctx, state } = await fixture('', false, false)
  const token = {}
  let ready = false
  Object.assign(state, { getEvenOddHfSaveState: () => ({ token, ready }) })
  window.desktop.saveDocx = async () => {
    ready = true
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(false)
})


it('retries pending even/odd header intent into actual DOCX settings bytes', async () => {
  const { ctx, state, path } = await fixture('', false, false)
  const input = createEvenOddHfState()
  const render = () => {
    Object.assign(state, {
      evenOddHf: input.getSnapshot().enabled,
      evenOddHfDirty: input.getSnapshot().dirty,
    })
    input.markRendered(input.getSnapshot().token)
  }
  Object.assign(state, {
    getEvenOddHfSaveState: input.getSaveState,
    setEvenOddHf: input.setEnabled,
    setEvenOddHfDirty: input.setDirty,
  })
  render()
  let writes = 0
  window.desktop.saveDocx = async (target, data) => {
    await writeFile(target, new Uint8Array(data))
    if (++writes === 1) {
      input.setEnabled(true)
      input.setDirty(true)
    }
    return { ok: true }
  }
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(true)
  expect(input.getSnapshot()).toMatchObject({ enabled: true, dirty: true })
  expect((await parseDocx(await readFile(path))).evenAndOddHeaders ?? false).toBe(false)
  render()
  expect(await save(ctx, false, false)).toBe(true)
  expect(state.saveIncompleteRef.current).toBe(false)
  expect((await parseDocx(await readFile(path))).evenAndOddHeaders).toBe(true)
  expect(input.getSnapshot()).toMatchObject({ enabled: true, dirty: false })
})

