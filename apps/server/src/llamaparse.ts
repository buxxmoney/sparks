/**
 * LlamaParse (LlamaCloud) client — used ONLY to ingest reference tariff schedules
 * (Eskom / municipal published prices), whose rate TABLES are images that plain
 * pdftotext can't read. Runs once per schedule at upload, never per invoice. If
 * LLAMA_CLOUD_API_KEY is unset (or a parse fails), callers fall back to pdftotext.
 *
 * Env:
 *   LLAMA_CLOUD_API_KEY  — the `llx-...` key (required to enable).
 *   LLAMA_CLOUD_BASE_URL — override the API base (e.g. EU region). Default US.
 *   LLAMA_PARSE_PREMIUM  — "false" to disable premium (table-accurate) mode.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL =
  process.env.LLAMA_CLOUD_BASE_URL?.replace(/\/$/, "") ??
  "https://api.cloud.llamaindex.ai/api/parsing";

export function llamaParseConfigured(): boolean {
  return Boolean(process.env.LLAMA_CLOUD_API_KEY);
}

export interface LlamaParseResult {
  markdown: string | null;
  /** Human-readable reason when markdown is null (for surfacing "LlamaParse broke"). */
  error: string | null;
}

/**
 * Parse a PDF to Markdown (tables preserved) via LlamaParse. Submits the job, polls
 * to completion, and returns the markdown OR a reason it failed. Never throws — so
 * the caller can fall back to pdftotext AND report the failure to operators.
 */
export async function parsePdfToMarkdown(
  pdf: Buffer,
  filename: string,
): Promise<LlamaParseResult> {
  const key = process.env.LLAMA_CLOUD_API_KEY;
  if (!key) return { markdown: null, error: "LLAMA_CLOUD_API_KEY not set" };
  const auth = { Authorization: `Bearer ${key}` };
  const fail = (error: string): LlamaParseResult => {
    console.error(`[llamaparse] ${error}`);
    return { markdown: null, error };
  };

  try {
    // 1) Submit the document.
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
    // Premium mode is markedly better at image-based/dense rate tables.
    if (process.env.LLAMA_PARSE_PREMIUM !== "false") form.append("premium_mode", "true");

    const submit = await fetch(`${BASE_URL}/upload`, { method: "POST", headers: auth, body: form });
    if (!submit.ok) {
      return fail(`upload failed: HTTP ${submit.status} ${(await submit.text()).slice(0, 200)}`);
    }
    const { id } = (await submit.json()) as { id: string };
    if (!id) return fail("upload returned no job id");

    // 2) Poll for completion (schedules are big; allow up to 5 minutes).
    const deadline = Date.now() + 5 * 60_000;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await fetch(`${BASE_URL}/job/${id}`, { headers: auth });
      if (!st.ok) continue;
      const { status } = (await st.json()) as { status: string };
      if (status === "SUCCESS" || status === "PARTIAL_SUCCESS") {
        done = true;
        break;
      }
      if (status === "ERROR" || status === "CANCELED") return fail(`job ${id} ended ${status}`);
    }
    if (!done) return fail(`job ${id} did not finish within 5 minutes`);

    // 3) Fetch the markdown result.
    const res = await fetch(`${BASE_URL}/job/${id}/result/markdown`, { headers: auth });
    if (!res.ok) return fail(`result fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { markdown?: string };
    const markdown = body.markdown?.trim() || null;
    return markdown ? { markdown, error: null } : fail("job succeeded but returned empty markdown");
  } catch (err) {
    return fail(`request error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── PDF chunking (poppler) ───────────────────────────────────────────────────
// LlamaParse premium on a large doc (e.g. the 57-page Eskom schedule) can hang for
// 20+ min, but a few pages parse in ~30s. So we split big schedules into small
// page-range chunks and parse them with limited concurrency, then concatenate.

function spawnOk(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr?.on("data", (d) => {
      err += d;
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`)),
    );
  });
}

function pdfPageCount(path: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn("pdfinfo", [path]);
    let out = "";
    p.stdout?.on("data", (d) => {
      out += d;
    });
    p.on("error", () => resolve(0));
    p.on("close", () => {
      const m = out.match(/Pages:\s+(\d+)/);
      resolve(m ? Number.parseInt(m[1], 10) : 0);
    });
  });
}

/** Split a PDF into chunks of `pagesPerChunk` pages via poppler. Returns [pdf] if it
 *  can't split (small doc, or poppler missing) so the caller still parses the whole. */
async function splitPdfIntoChunks(pdf: Buffer, pagesPerChunk: number): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "sched-split-"));
  try {
    const src = join(dir, "src.pdf");
    await writeFile(src, pdf);
    const pages = await pdfPageCount(src);
    if (pages <= pagesPerChunk || pages === 0) return [pdf];
    await spawnOk("pdfseparate", [src, join(dir, "p-%d.pdf")]);
    const chunks: Buffer[] = [];
    for (let start = 1; start <= pages; start += pagesPerChunk) {
      const end = Math.min(start + pagesPerChunk - 1, pages);
      const files: string[] = [];
      for (let i = start; i <= end; i++) files.push(join(dir, `p-${i}.pdf`));
      const chunkPath = join(dir, `chunk-${start}.pdf`);
      await spawnOk("pdfunite", [...files, chunkPath]);
      chunks.push(await readFile(chunkPath));
    }
    return chunks;
  } catch {
    return [pdf];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse a (possibly large) schedule PDF to Markdown. Splits into page-range chunks
 * and parses them with limited concurrency so premium mode doesn't hang on the full
 * document. Returns partial content WITH an error note if some chunks fail (better
 * than nothing, and the failure is still surfaced).
 */
export async function parseScheduleToMarkdown(
  pdf: Buffer,
  filename: string,
): Promise<LlamaParseResult> {
  if (!process.env.LLAMA_CLOUD_API_KEY) return { markdown: null, error: "LLAMA_CLOUD_API_KEY not set" };
  const pagesPerChunk = Number.parseInt(process.env.LLAMA_PAGES_PER_CHUNK ?? "6", 10) || 6;
  const chunks = await splitPdfIntoChunks(pdf, pagesPerChunk);
  if (chunks.length === 1) return parsePdfToMarkdown(chunks[0], filename);

  const parts: string[] = [];
  const errors: string[] = [];
  // Default sequential (1): LlamaParse's free tier has low concurrency, so parallel
  // chunks just queue and time out. Bump LLAMA_CONCURRENCY on a paid plan for speed.
  const concurrency = Number.parseInt(process.env.LLAMA_CONCURRENCY ?? "1", 10) || 1;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((c, j) => parsePdfToMarkdown(c, `${filename}.chunk${i + j + 1}.pdf`)),
    );
    results.forEach((r, j) => {
      if (r.markdown) parts.push(r.markdown);
      else errors.push(`chunk ${i + j + 1}: ${r.error}`);
    });
  }
  if (parts.length === 0) {
    return { markdown: null, error: `all ${chunks.length} chunks failed — ${errors[0] ?? "unknown"}` };
  }
  return {
    markdown: parts.join("\n\n"),
    error: errors.length
      ? `${errors.length}/${chunks.length} chunks failed: ${errors.join("; ").slice(0, 200)}`
      : null,
  };
}
