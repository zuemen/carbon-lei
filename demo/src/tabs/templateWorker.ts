// Web Worker for the Communication Template panel: parses the xlsx off the main thread with the SDK's importer.
// Loaded only when a file is read; exceljs (its prebuilt browser file) and fflate are bundled into this worker only.
import ExcelJS from "exceljs";
import { draftCredentialFields, parseTemplate, type CredentialDraft, type ExcelModule, type ParsedTemplate } from "../../../sdk/template.ts";

export type TemplateRequest = { bytes: ArrayBuffer };
export type TemplateResponse =
  | { ok: true; t: ParsedTemplate; drafts: CredentialDraft[] }
  | { ok: false; message: string };

const excel = async () => ExcelJS as unknown as ExcelModule;

self.onmessage = async (e: MessageEvent<TemplateRequest>) => {
  let res: TemplateResponse;
  try {
    const t = await parseTemplate(new Uint8Array(e.data.bytes), { excel });
    res = { ok: true, t, drafts: t.products.map((_, i) => draftCredentialFields(t, i)) };
  } catch (err) {
    res = { ok: false, message: (err as Error).message };
  }
  self.postMessage(res);
};
