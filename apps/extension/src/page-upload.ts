import { type ElementRefs, refError } from "./element-refs.ts";
import { isRecord, ownField, PageError } from "./page-messages.ts";

// Firefox's waiver of Xray vision and its copy into another realm, in content scripts only.
declare const window: Window & { wrappedJSObject: PageRealm };
declare function cloneInto<T>(value: T, target: object): T;

interface PageRealm {
  DataTransfer: typeof DataTransfer;
  File: typeof File;
}

interface PageFile {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * upload_file in the page: sets the files of the file field `ref` names, or drops them on any
 * other element, which takes them only when its page cancels `dragover`, as in a real drag.
 */
export function uploadFile(
  params: Record<string, unknown>,
  page: { refs: ElementRefs<Element> },
): { target: "input" | "drop" } {
  const ref = ownField(params, "ref");
  if (typeof ref !== "string") {
    throw new PageError("invalid_params", "upload_file needs ref to be a string.");
  }
  const files = pageFiles(ownField(params, "files"));
  const lookup = page.refs.resolve(ref);
  if ("error" in lookup) throw refError(ref, lookup.error);
  const element = lookup.element;
  if (element instanceof HTMLInputElement && element.type === "file") {
    return intoField(element, files);
  }
  return dropOn(element, files);
}

function pageFiles(value: unknown): PageFile[] {
  if (!Array.isArray(value)) {
    throw new PageError("invalid_params", "upload_file needs files to be a list.");
  }
  return value.map((file: unknown) => {
    const name = isRecord(file) ? ownField(file, "name") : undefined;
    const type = isRecord(file) ? ownField(file, "type") : undefined;
    const bytes = isRecord(file) ? ownField(file, "bytes") : undefined;
    if (typeof name !== "string" || typeof type !== "string" || !(bytes instanceof Uint8Array)) {
      throw new PageError("invalid_params", "upload_file got a file it cannot read.");
    }
    // A copy on an ArrayBuffer of its own, which is what File takes.
    return { name, type, bytes: new Uint8Array(bytes) };
  });
}

/** Sets the field's files, once it is known to take them. */
function intoField(input: HTMLInputElement, files: readonly PageFile[]): { target: "input" } {
  // Also true inside a disabled fieldset.
  if (input.matches(":disabled")) {
    throw new PageError("invalid_target", "That file field is disabled.");
  }
  if (!input.multiple && files.length > 1) {
    throw new PageError(
      "invalid_target",
      `That file field takes one file, and ${files.length} were given.`,
    );
  }
  input.files = pageTransfer(files).files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { target: "input" };
}

/** Drops the files on the element, and only when the page canceled dragover, as in a real drag. */
function dropOn(element: Element, files: readonly PageFile[]): { target: "drop" } {
  const transfer = pageTransfer(files);
  element.dispatchEvent(drag("dragenter", transfer));
  if (element.dispatchEvent(drag("dragover", transfer))) {
    // A real drag that ends where dragover was not canceled leaves with dragleave.
    element.dispatchEvent(drag("dragleave", transfer));
    throw new PageError(
      "invalid_target",
      "That element is neither a file field nor a place that takes dropped files.",
    );
  }
  element.dispatchEvent(drag("drop", transfer));
  return { target: "drop" };
}

/**
 * The files in a DataTransfer made in the page's realm: Firefox hides from the page the items
 * another principal added.
 */
function pageTransfer(files: readonly PageFile[]): DataTransfer {
  const pageWindow = window.wrappedJSObject;
  const transfer = new pageWindow.DataTransfer();
  for (const { name, type, bytes } of files) {
    transfer.items.add(
      new pageWindow.File(cloneInto([bytes], window), name, cloneInto({ type }, window)),
    );
  }
  return transfer;
}

function drag(type: string, dataTransfer: DataTransfer): DragEvent {
  return new DragEvent(type, {
    bubbles: true,
    cancelable: type !== "dragleave",
    composed: true,
    dataTransfer,
  });
}
