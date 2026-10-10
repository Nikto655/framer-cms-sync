// The new-sync wizard: collection → data source → connect → review.
// Answers are collected first; nothing is written (config, files, Framer) until the review is confirmed,
// except a Google Sheets import file, which the person needs in order to create the sheet.

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { editConfig, relPath, setEnv, setIn } from "../config/write.ts";
import { loadConfig } from "../config/load.ts";
import { NAME_RE, syncSchema } from "../config/schema.ts";
import { createSync, type CollectionView } from "../engine.ts";
import { loadSource } from "../sources/index.ts";
import { inspectSource } from "../inspect.ts";
import { excelSheets, isGoogleSheet } from "../formats.ts";
import { inferFields } from "../core/infer.ts";
import { slugify } from "../core/identity.ts";
import { detectOrder, isSlashDate, type DateOrder } from "../core/dates.ts";
import { type Ctx, Header, errInfo, siteName, configSource, SECRET_QUERY } from "./shared.tsx";
import { Command, Done, ErrorBox, Field, Keys, Panel, Question, Row, Select, Spinner, StepBar } from "./components.tsx";
import { formatFromPath } from "../core/filetypes.ts";

type Target =
  | { kind: "new"; name: string; mode: "managed" | "unmanaged" }
  | { kind: "existing"; col: CollectionView }
  | { kind: "copy"; col: CollectionView; name: string };
type SourceKind = "file" | "markdown" | "gsheet" | "endpoint" | "none";
type Step =
  | "start" | "pickExisting" | "newName" | "kind" | "copyName" | "sourceKind"
  | "fileHow" | "fileFormat" | "filePath" | "sheet" | "mdHow" | "mdPath"
  | "gsHow" | "gsLink" | "epUrl" | "epAuth" | "epHeader" | "epRows"
  | "dateOrder" | "key" | "fields" | "syncName" | "review" | "working" | "done";

const STEP_GROUP: Record<Step, number> = {
  start: 0, pickExisting: 0, newName: 0, kind: 0, copyName: 0,
  sourceKind: 1,
  fileHow: 2, fileFormat: 2, filePath: 2, sheet: 2, mdHow: 2, mdPath: 2, gsHow: 2, gsLink: 2, epUrl: 2, epAuth: 2, epHeader: 2, epRows: 2, dateOrder: 2, key: 2, fields: 2,
  syncName: 3, review: 3, working: 3, done: 3,
};

interface Probe { records: Record<string, unknown>[]; columns: string[] }

const columnsOf = (records: Record<string, unknown>[]) => { const k = new Set<string>(); for (const r of records.slice(0, 300)) for (const c of Object.keys(r)) k.add(c); return [...k]; };
const probeSync = (source: Record<string, unknown>) => syncSchema.parse({ collection: { name: "probe" }, source, ...(source.type === "markdown" ? {} : { key: { field: "_" } }) });

function suggestKey(p: Probe): string | undefined {
  const pref = ["slug", "id", "name", "title", "handle", "sku"];
  const unique = p.columns.filter((c) => { const vals = p.records.map((r) => r[c]); return vals.every((v) => v !== "" && v != null) && new Set(vals.map(String)).size === vals.length; });
  return unique.sort((a, b) => { const i = (x: string) => { const n = pref.indexOf(x.toLowerCase()); return n < 0 ? 99 : n; }; return i(a) - i(b); })[0];
}

export function NewSyncWizard({ ctx, firstRun }: { ctx: Ctx; firstRun?: boolean }) {
  const engine = ctx.engine!;
  const cfg = engine.config;
  const project = ctx.site ?? engine.projectNames[0];
  const multi = engine.projectNames.length > 1;
  const [step, setStep] = useState<Step>("start");
  const [history, setHistory] = useState<Step[]>([]);
  const [collections, setCollections] = useState<CollectionView[] | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [kindDraft, setKindDraft] = useState("");
  const [source, setSource] = useState<SourceKind | null>(null);
  const [create, setCreate] = useState(false);
  const [fileFormat, setFileFormat] = useState<"csv" | "excel" | "json">("excel");
  const [filePath, setFilePath] = useState("");
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string | undefined>();
  const [mdPath, setMdPath] = useState("");
  const [gsUrl, setGsUrl] = useState("");
  const [gsExported, setGsExported] = useState<string | null>(null);
  const [epUrl, setEpUrl] = useState("");
  const [epHeader, setEpHeader] = useState<{ name: string; value: string } | null>(null);
  const [epRows, setEpRows] = useState<string | undefined>();
  const [candidates, setCandidates] = useState<{ path: string; count: number }[]>([]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [keyField, setKeyField] = useState<string | undefined>();
  const [keyTransform, setKeyTransform] = useState<"slugify" | "none">("slugify");
  const [fieldsFrom, setFieldsFrom] = useState<string>("data");
  const [dateOrder, setDateOrder] = useState<DateOrder | undefined>();
  const [dateExample, setDateExample] = useState<string>("");
  const [syncName, setSyncName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const [progress, setProgress] = useState<string[]>([]);

  const collectionName = target ? (target.kind === "existing" ? target.col.name : target.name) : "";
  const slug = slugify(collectionName) || "items";
  const isNew = target?.kind === "new";
  const fromCollection = target && target.kind !== "new" ? target.col : null; // where downloads come from
  const steps = firstRun ? ["Site", "Collection", "Data source", "Connect", "Review"] : ["Collection", "Data source", "Connect", "Review"];
  const current = STEP_GROUP[step] + (firstRun ? 1 : 0);

  const go = (s: Step) => { setError(null); setHistory((h) => [...h, step]); setStep(s); };
  const back = () => { setError(null); const h = [...history]; const prev = h.pop(); setHistory(h); if (prev) setStep(prev); else ctx.go({ name: "home" }); };

  useEffect(() => { if (!collections) engine.collections({ project }).then(setCollections).catch((e) => setError(errInfo(e))); }, []);

  // Esc goes back one step on screens whose own input doesn't handle it.
  useInput((_i, key) => {
    if (key.escape) { if (step === "done") ctx.go({ name: "home" }); else back(); }
    if (key.return && step === "review") void finish();
    if (key.return && step === "done") openPreview();
  },
    { isActive: ["start", "pickExisting", "kind", "sourceKind", "fileHow", "fileFormat", "sheet", "mdHow", "gsHow", "epAuth", "epRows", "key", "fields", "review", "done"].includes(step) && !busy });

  const run = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label); setError(null);
    try { return await fn(); } catch (e) { setError(errInfo(e)); return undefined; } finally { setBusy(null); }
  };

  // ---- after the data is connected: key → fields → name
  const afterConnect = (p: Probe | null, opts: { keyKnown?: { field: string; transform: "slugify" | "none" } } = {}, dateChecked = false) => {
    setProbe(p);
    // Dates like 10/08/2026: settle day/month vs month/day before anything else.
    if (p && !dateChecked) {
      const slash = p.records.flatMap((r) => Object.values(r)).filter(isSlashDate);
      const order = detectOrder(slash);
      if (order === "ambiguous") { setDateExample(String(slash.find((v) => { const [a, b] = String(v).split(/[/.-]/).map(Number); return a !== b; }) ?? slash[0])); pendingConnect.current = opts; return go("dateOrder"); }
      if (order) setDateOrder(order);
    }
    if (opts.keyKnown) { setKeyField(opts.keyKnown.field); setKeyTransform(opts.keyKnown.transform); }
    if (source !== "markdown" && !opts.keyKnown && p) { setKeyField(suggestKey(p)); setKeyTransform("slugify"); return go("key"); }
    if (isNew) return go("fields");
    setSyncName(uniqueName(slug)); go("syncName");
  };
  const pendingConnect = useRef<{ keyKnown?: { field: string; transform: "slugify" | "none" } }>({});
  const uniqueName = (base: string) => { let n = base, i = 2; while (cfg.syncs[n]) n = `${base}-${i++}`; return n; };

  // ---- connecting each kind of source
  const loadFile = async (p: string, sh?: string) => {
    const abs = path.resolve(ctx.dir, p);
    if (formatFromPath(abs) === "excel" && sh === undefined) {
      const names = await excelSheets(abs);
      if (names.length > 1) { setSheets(names); setFilePath(p); return go("sheet"); }
    }
    const type = formatFromPath(abs) === "excel" ? "excel" : formatFromPath(abs) === "json" ? "json" : "csv";
    const loaded = await loadSource(probeSync({ type, path: abs, ...(sh ? { sheet: sh } : {}) }), undefined, { baseDir: ctx.dir });
    if (!loaded.records.length) throw Object.assign(new Error("the file has no rows"), { fix: "add a header row and at least one row of data" });
    const recs = loaded.records.map((r) => r.data);
    setFilePath(p); setSheet(sh);
    afterConnect({ records: recs, columns: columnsOf(recs) });
  };
  const loadFolder = async (p: string) => {
    const loaded = await loadSource(probeSync({ type: "markdown", path: path.resolve(ctx.dir, p) }), undefined, { baseDir: ctx.dir });
    if (!loaded.records.length) throw Object.assign(new Error("no .md files in that folder"), { fix: "add posts, or choose to create the folder with an example post" });
    const recs = loaded.records.map((r) => r.data);
    setMdPath(p);
    afterConnect({ records: recs, columns: columnsOf(recs) });
  };
  const loadSheet = async (url: string) => {
    const loaded = await loadSource(probeSync({ type: "csv", url }), undefined, { baseDir: ctx.dir });
    if (!loaded.records.length) throw Object.assign(new Error("the sheet has no rows"), { fix: "add a header row and data in the first tab, or link to the right tab" });
    const recs = loaded.records.map((r) => r.data);
    setGsUrl(url);
    afterConnect({ records: recs, columns: columnsOf(recs) });
  };
  const loadEndpoint = async (url: string, header: { name: string; value: string } | null, rows?: string) => {
    const headers = header ? { [header.name]: header.value } : undefined;
    const ins = await inspectSource({ url, headers, rows });
    if (!ins.ok) {
      if (ins.candidates?.length) { setCandidates(ins.candidates); return go("epRows"); }
      throw Object.assign(new Error(ins.note ?? "no records found at that address"), { fix: "check the URL returns a JSON list (or CSV)" });
    }
    const loaded = await loadSource(probeSync({ type: ins.format === "csv" ? "csv" : "json", url, ...(headers ? { headers } : {}), ...(rows ? { rows } : {}) }), undefined, { baseDir: ctx.dir });
    const recs = loaded.records.map((r) => r.data);
    setEpRows(rows);
    afterConnect({ records: recs, columns: columnsOf(recs) });
  };

  // ---- the Google Sheets "not ready yet" path: write a file to import
  const exportForSheets = async () => {
    const dest = `data/${slug}-for-google-sheets.csv`;
    const r = await run("Preparing a file to import into Google Sheets…", async () =>
      fromCollection ? engine.download({ project, collection: fromCollection.name, format: "csv", dest, overwrite: true })
        : engine.template({ project, format: "csv", dest, overwrite: true }));
    if (r) { setGsExported(dest); go("gsLink"); }
  };

  // ---- finish: write files, config, create the collection
  const finish = async () => {
    setStep("working"); setProgress([]); setError(null);
    const log = (s: string) => setProgress((p) => [...p, s]);
    try {
      const fileDest = source === "file" ? filePath : source === "markdown" ? mdPath : "";
      let keyF = keyField, keyT = keyTransform, bodyField: string | undefined;
      if (create && (source === "file" || source === "markdown")) {
        const format = source === "markdown" ? "markdown" as const : fileFormat;
        if (fromCollection) {
          const r = await engine.download({ project, collection: fromCollection.name, format, dest: fileDest });
          log(`Saved ${r.rows} item${r.rows === 1 ? "" : "s"} from "${fromCollection.name}" to ${fileDest}`);
          keyF = r.keyColumn; keyT = r.keyTransform; bodyField = r.bodyField;
        } else {
          const r = await engine.template({ project, format, dest: fileDest, from: fieldsFrom !== "data" && fieldsFrom !== "template" ? fieldsFrom : undefined });
          log(`Created ${source === "markdown" ? "a folder with an example post" : "a template"} at ${fileDest}`);
          if (source !== "markdown") { keyF = r.keyColumn; keyT = r.keyTransform; }
          bodyField = r.bodyField;
        }
      }
      // source block for the config (secrets go to .env)
      let src: Record<string, unknown>;
      if (source === "file") src = { type: formatFromPath(fileDest) === "excel" ? "excel" : formatFromPath(fileDest) === "json" ? "json" : "csv", path: relPath(ctx.dir, fileDest), ...(sheet ? { sheet } : {}) };
      else if (source === "markdown") src = { type: "markdown", path: relPath(ctx.dir, fileDest) };
      else if (source === "gsheet") src = configSource(ctx, syncName, gsUrl, "csv");
      else if (source === "none") src = { type: "none" };
      else {
        src = SECRET_QUERY.test(epUrl) ? configSource(ctx, syncName, epUrl, "json") : { type: "json", url: epUrl };
        if (epRows) src.rows = epRows;
        if (epHeader) {
          const envVar = `${syncName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_SOURCE_HEADER`;
          setEnv(ctx.dir, { [envVar]: epHeader.value });
          src.headers = { [epHeader.name]: `\${${envVar}}` };
        }
      }
      const collection = target!.kind === "existing" ? { name: target!.col.name } : target!.kind === "new" ? { name: target!.name, create: true, mode: target!.mode } : { name: target!.name, create: true };
      const schemaFrom = target!.kind === "copy" ? target!.col.name : isNew && fieldsFrom !== "data" && fieldsFrom !== "template" ? fieldsFrom : undefined;
      editConfig(ctx.file!, (doc) => setIn(doc, ["syncs", syncName], {
        ...(multi ? { project } : {}),
        collection,
        ...(schemaFrom ? { schemaFrom, ...(target!.kind === "copy" ? { schemaIds: "keep" } : {}) } : {}),
        source: src,
        ...(source !== "markdown" && source !== "none" && keyF ? { key: { field: keyF, transform: keyT } } : {}),
        ...(bodyField || dateOrder ? { fields: { ...(bodyField ? { map: { content: bodyField } } : {}), ...(dateOrder ? { dateOrder } : {}) } } : {}),
      }));
      log(`Saved the sync "${syncName}" to ${path.basename(ctx.file!)}`);
      if (target!.kind !== "existing") {
        const loaded = loadConfig(ctx.file!);
        const r = await createSync({ config: loaded.config, configDir: loaded.dir, configFile: loaded.file, actor: "tui", defaultProject: project }).setup(syncName);
        log(`Created the collection "${collectionName}" (${target!.kind === "new" && target!.mode === "unmanaged" ? "regular" : "managed"}) with ${r.fieldCount} fields`);
      }
      ctx.reload();
      setStep("done");
    } catch (e) { setError(errInfo(e)); setStep("review"); }
  };
  const openPreview = () => ctx.go({ name: "sync", sync: syncName, message: "✓ Set up. Here's what the first sync would do:" });

  const inferred = useMemo(() => (probe && isNew ? inferFields(probe.records.map((r, i) => ({ data: r, origin: `row ${i}` })), probeSync(source === "markdown" ? { type: "markdown" } : { type: "csv" })).fields : []), [probe, isNew]);
  const dataLabel = source === "file" ? `${filePath}${sheet ? ` (sheet "${sheet}")` : ""}` : source === "markdown" ? mdPath : source === "gsheet" ? "Google Sheet" : epUrl;
  const sourceLabel: Record<SourceKind, string> = { file: "Excel / CSV file", markdown: "Folder of Markdown files", gsheet: "Google Sheets", endpoint: "Endpoint (URL)", none: "Nothing: sent in by agents, the HTTP API or commands" };

  // ---------------------------------------------------------------------------
  return (
    <Box flexDirection="column">
      <Header ctx={ctx} title="new sync" />
      <StepBar steps={steps} current={current} />

      {/* what's been chosen so far */}
      {target && STEP_GROUP[step] > 0 ? <Row label="Collection">{collectionName} <Text dimColor>({target.kind === "existing" ? (target.col.ownership === "this" ? "managed by this tool" : "regular, filled as it is") : target.kind === "copy" ? `your managed copy of "${target.col.name}"` : target.mode === "managed" ? "new, managed" : "new, regular"})</Text></Row> : null}
      {source && STEP_GROUP[step] > 1 ? <Row label="Data">{sourceLabel[source]}{dataLabel && step !== "filePath" && step !== "mdPath" ? <Text dimColor>  {dataLabel}{probe ? ` · ${probe.records.length} ${source === "markdown" ? (probe.records.length === 1 ? "post" : "posts") : probe.records.length === 1 ? "row" : "rows"}` : ""}</Text> : null}</Row> : null}
      {STEP_GROUP[step] > 0 ? <Box marginBottom={1} /> : null}

      {busy ? <Spinner label={busy} /> : null}

      {/* ---------------- Collection ---------------- */}
      {step === "start" && !busy ? <>
        <Question title="Which collection should this data go into?">Start a new collection, or use one that already exists in {siteName(ctx, project)}.</Question>
        <Select items={[
          { label: "New collection", value: "new", hint: "create it in Framer, with fields from your data or a template" },
          { label: "Existing collection", value: "existing", hint: `${collections?.length ?? "…"} in this site: fill one, or copy one another plugin owns` },
        ]} onSelect={(v) => go(v === "new" ? "newName" : "pickExisting")} onCancel={back} />
      </> : null}

      {step === "newName" ? <>
        <Question title="What should the new collection be called?">The name you'll see in Framer's CMS panel.</Question>
        <Field label="Collection name" placeholder="Products" onCancel={back}
          validate={(v) => (!v ? "enter a name" : collections?.some((c) => c.name.toLowerCase() === v.toLowerCase()) ? "a collection with that name exists" : null)}
          onSubmit={(v) => { setKindDraft(v); go("kind"); }} />
      </> : null}

      {step === "kind" ? <>
        <Question title={`What kind of collection should "${kindDraft}" be?`}>This decides who's in charge of it. It can't be switched later.</Question>
        <Select items={[
          { label: "Managed", value: "managed", hint: "your data is the source of truth; synced content is read-only in Framer" },
          { label: "Regular", value: "unmanaged", hint: "your team can still edit items and add fields in Framer" },
        ]} onSelect={(v) => { setTarget({ kind: "new", name: kindDraft, mode: v as "managed" | "unmanaged" }); go("sourceKind"); }} onCancel={back} />
        <Box marginTop={1}><Text dimColor>Pick managed for prices, listings and anything generated; regular for blogs and mixed content.</Text></Box>
      </> : null}

      {step === "pickExisting" ? (collections ? <>
        <Question title="Which collection?">Hand-built collections are filled as they are. A collection owned by another plugin can't be written to by anyone else, so you get your own managed copy with the same fields.</Question>
        <Select items={collections.map((c) => ({
          label: c.name.padEnd(24), value: c.id,
          hint: c.ownership === "other" ? "owned by another plugin → copy it" : c.ownership === "this" ? "managed by this tool → use it" : "hand-built → fill it as it is",
        }))} onSelect={(id) => {
          const c = collections.find((x) => x.id === id)!;
          if (c.ownership === "other") { setTarget({ kind: "copy", col: c, name: `${c.name} Synced` }); go("copyName"); }
          else { setTarget({ kind: "existing", col: c }); go("sourceKind"); }
        }} onCancel={back} />
      </> : <Spinner label="Loading collections…" />) : null}

      {step === "copyName" && target?.kind === "copy" ? <>
        <Question title="Name your copy">"{target.col.name}" belongs to another plugin, so Framer won't let this tool change it. You'll get a new collection with the same fields that this tool controls; once it's filled, switch your page template to it in the Framer editor.</Question>
        <Field label="Copy's name" initial={target.name} onCancel={back}
          validate={(v) => (!v ? "enter a name" : collections?.some((c) => c.name.toLowerCase() === v.toLowerCase()) ? "a collection with that name exists" : null)}
          onSubmit={(v) => { setTarget({ ...target, name: v }); go("sourceKind"); }} />
      </> : null}

      {/* ---------------- Data source ---------------- */}
      {step === "sourceKind" ? <>
        <Question title="Where will the data come from?">This is where you'll make changes from now on; each sync copies them into "{collectionName}".</Question>
        <Select items={[
          { label: "Excel / CSV file", value: "file", hint: ".xlsx or .csv on this computer" },
          { label: "Folder of Markdown files", value: "markdown", hint: "one .md file per item, e.g. blog posts" },
          { label: "Google Sheets", value: "gsheet", hint: "a sheet shared with a link" },
          { label: "Endpoint (URL)", value: "endpoint", hint: "an API or URL that returns JSON or CSV" },
          { label: "Nothing: data is sent in", value: "none", hint: "for AI agents, the HTTP API or single commands; nothing is saved on this computer" },
        ]} onSelect={(v) => {
          setSource(v as SourceKind); setCreate(false);
          if (v === "none") { if (isNew) go("fields"); else { setSyncName(uniqueName(slug)); go("syncName"); } return; }
          go(v === "file" ? "fileHow" : v === "markdown" ? "mdHow" : v === "gsheet" ? "gsHow" : "epUrl");
        }} onCancel={back} />
      </> : null}

      {/* ---------------- Connect: file ---------------- */}
      {step === "fileHow" ? <>
        <Question title="Do you already have the file?">{fromCollection ? `Downloading gives you a file with every item from "${fromCollection.name}", so your file and the CMS start out identical.` : "A template has the right columns and one example row to replace."}</Question>
        <Select items={[
          ...(fromCollection ? [{ label: "Download the current items into a new file", value: "create", hint: "recommended: start in sync" }] : [{ label: "Create a template file for me", value: "create", hint: "columns plus one example row" }]),
          { label: "Use a file I already have", value: "have", hint: ".xlsx, .csv or .json" },
        ]} onSelect={(v) => { setCreate(v === "create"); go(v === "create" ? "fileFormat" : "filePath"); }} onCancel={back} />
      </> : null}

      {step === "fileFormat" ? <>
        <Question title="Which format?">Excel keeps formatting and is easiest to edit; CSV works with anything.</Question>
        <Select items={[{ label: "Excel (.xlsx)", value: "excel" }, { label: "CSV (.csv)", value: "csv" }]}
          onSelect={(v) => { setFileFormat(v as "excel" | "csv"); setFilePath(`data/${project}/${slug}.${v === "excel" ? "xlsx" : "csv"}`); go("filePath"); }} onCancel={back} />
      </> : null}

      {step === "filePath" ? <>
        <Question title={create ? "Where should the file go?" : "Where's the file?"}>{create ? "It'll be created there when you confirm at the end." : "Type the path; Tab completes."} Paths start from {ctx.dir.replace(process.env.HOME ?? "\u0000", "~")}.</Question>
        <Field label="File" initial={create ? filePath : ""} pathBase={ctx.dir} placeholder={`./data/${project}/products.xlsx`} onCancel={back}
          validate={(v) => {
            if (!v) return "enter a path";
            const abs = path.resolve(ctx.dir, v);
            if (create) return existsSync(abs) ? "that file already exists; choose another name" : !/\.(xlsx|csv)$/i.test(v) ? "use a .xlsx or .csv name" : null;
            return !existsSync(abs) ? "no such file" : statSync(abs).isDirectory() ? "that's a folder; choose a file" : !/\.(xlsx|csv|json)$/i.test(v) ? "use a .xlsx, .csv or .json file" : null;
          }}
          onSubmit={(v) => {
            if (create) { setFilePath(v); setFileFormat(/\.csv$/i.test(v) ? "csv" : "excel"); afterConnect(null, fromCollection ? { keyKnown: { field: "slug", transform: "none" } } : { keyKnown: { field: "(from the template)", transform: "slugify" } }); }
            else void run("Reading the file…", () => loadFile(v));
          }} />
      </> : null}

      {step === "sheet" ? <>
        <Question title="Which sheet?">The file has several sheets (tabs). Pick the one with the data.</Question>
        <Select items={sheets.map((s) => ({ label: s, value: s }))} onSelect={(s) => void run("Reading the sheet…", () => loadFile(filePath, s))} onCancel={back} />
      </> : null}

      {/* ---------------- Connect: Markdown ---------------- */}
      {step === "mdHow" ? <>
        <Question title="Do you already have the posts?">{fromCollection ? `Downloading writes one .md file per item in "${fromCollection.name}", with the rich text converted to Markdown.` : "One .md file per item: settings at the top (frontmatter), the body below."}</Question>
        <Select items={[
          ...(fromCollection ? [{ label: "Download the current items as Markdown files", value: "create", hint: "recommended: start in sync" }] : [{ label: "Create a folder with an example post", value: "create" }]),
          { label: "Use a folder I already have", value: "have" },
        ]} onSelect={(v) => { setCreate(v === "create"); setMdPath(v === "create" ? `data/${project}/${slug}` : ""); go("mdPath"); }} onCancel={back} />
      </> : null}

      {step === "mdPath" ? <>
        <Question title={create ? "Which folder should the posts go in?" : "Where's the folder?"}>Paths start from {ctx.dir.replace(process.env.HOME ?? "\u0000", "~")}. Tab completes.</Question>
        <Field label="Folder" initial={mdPath} pathBase={ctx.dir} placeholder={`./data/${project}/blog`} onCancel={back}
          validate={(v) => {
            if (!v) return "enter a folder";
            const abs = path.resolve(ctx.dir, v);
            if (create) return existsSync(abs) && readdirSync(abs).some((f) => /\.md$/i.test(f)) ? "that folder already has posts; choose an empty one" : null;
            return !existsSync(abs) || !statSync(abs).isDirectory() ? "no such folder" : null;
          }}
          onSubmit={(v) => { if (create) { setMdPath(v); afterConnect(null, {}); } else void run("Reading the posts…", () => loadFolder(v)); }} />
      </> : null}

      {/* ---------------- Connect: Google Sheets ---------------- */}
      {step === "gsHow" ? <>
        <Question title="Is your Google Sheet ready?">The tool reads the sheet through a share link. It can't write into Google Sheets, so to start from {fromCollection ? "the current items" : "a template"} you import a file into a new sheet first.</Question>
        <Select items={[
          { label: "Yes, I have a sheet with the data", value: "ready" },
          { label: fromCollection ? `Not yet: give me the current items to import` : "Not yet: give me a template to import", value: "export", hint: "a CSV file for File → Import" },
        ]} onSelect={(v) => (v === "ready" ? go("gsLink") : void exportForSheets())} onCancel={back} />
      </> : null}

      {step === "gsLink" ? <>
        {gsExported ? <Panel title="Create the sheet" color="cyan">
          <Text>1. In Google Sheets: <Text bold>File → Import → Upload</Text>, choose <Text bold>{gsExported}</Text>, then <Text bold>Replace spreadsheet</Text>.</Text>
          <Text>2. <Text bold>Share → General access → Anyone with the link → Viewer</Text>.</Text>
          <Text>3. Copy the sheet's address and paste it below.</Text>
        </Panel> : null}
        <Question title="Paste the sheet's link">The normal address from your browser works; the tab you're on is the one that's read. The sheet must be shared so anyone with the link can view it.</Question>
        <Field label="Sheet link" placeholder="https://docs.google.com/spreadsheets/d/…" onCancel={back}
          validate={(v) => (isGoogleSheet(v) ? null : "that's not a Google Sheets link")}
          onSubmit={(v) => void run("Reading the sheet…", () => loadSheet(v))} />
      </> : null}

      {/* ---------------- Connect: endpoint ---------------- */}
      {step === "epUrl" ? <>
        <Question title="What's the address?">A URL that returns JSON or CSV, e.g. an API or an n8n webhook. It's fetched with a simple GET each time you sync; nothing is changed there.</Question>
        <Field label="URL" placeholder="https://api.example.com/products" onCancel={back}
          validate={(v) => (/^https?:\/\//i.test(v) ? null : "start with https:// or http://")}
          onSubmit={(v) => { setEpUrl(v); go("epAuth"); }} />
      </> : null}

      {step === "epAuth" ? <>
        <Question title="Does it need a key or login?">If the API needs a token, it's sent as a header. The value is stored in .env, not in the config.</Question>
        <Select items={[{ label: "No, it's public", value: "none" }, { label: "Yes, send a header", value: "header", hint: "e.g. Authorization: Bearer …" }]}
          onSelect={(v) => (v === "none" ? (setEpHeader(null), void run("Reading the endpoint…", () => loadEndpoint(epUrl, null))) : go("epHeader"))} onCancel={back} />
      </> : null}

      {step === "epHeader" ? <>
        <Question title="The header to send">Type it as Name: value, e.g. Authorization: Bearer abc123</Question>
        <Field label="Header" mask placeholder="Authorization: Bearer …" onCancel={back}
          validate={(v) => (/^[A-Za-z0-9-]+\s*:\s*\S/.test(v) ? null : 'use the form "Name: value"')}
          onSubmit={(v) => { const i = v.indexOf(":"); const h = { name: v.slice(0, i).trim(), value: v.slice(i + 1).trim() }; setEpHeader(h); void run("Reading the endpoint…", () => loadEndpoint(epUrl, h)); }} />
      </> : null}

      {step === "epRows" ? <>
        <Question title="Where are the records?">The response wraps its data. These lists were found in it; pick the one with one entry per item.</Question>
        <Select items={candidates.map((c) => ({ label: c.path, value: c.path, hint: `${c.count} item${c.count === 1 ? "" : "s"}` }))}
          onSelect={(p) => void run("Reading the endpoint…", () => loadEndpoint(epUrl, epHeader, p))} onCancel={back} />
      </> : null}

      {/* ---------------- dates ---------------- */}
      {step === "dateOrder" ? (() => {
        const [a, b, y] = dateExample.split(/[/.-]/).map((x) => Number(x));
        const month = (n: number) => new Date(Date.UTC(2000, n - 1, 1)).toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
        return <>
          <Question title={`How should dates like ${dateExample} be read?`}>Your data writes dates with slashes, and none of them make the order obvious. Choose once; it's saved with this sync and every date is read the same way.</Question>
          <Select items={[
            { label: `Day first: ${a} ${month(b)} ${y}`, value: "DMY", hint: "UK, Europe, most of the world" },
            { label: `Month first: ${month(a)} ${b}, ${y}`, value: "MDY", hint: "US" },
          ]} onSelect={(v) => { setDateOrder(v as DateOrder); afterConnect(probe, pendingConnect.current, true); }} onCancel={back} />
        </>;
      })() : null}

      {/* ---------------- key column ---------------- */}
      {step === "key" && probe ? <>
        <Question title="Which column identifies each item?">Pick one that's different for every row and rarely changes, like a name, title or ID. It becomes the page address ("Pro Monthly" → /pro-monthly) and is how rows are matched to items on every sync.</Question>
        <Select items={probe.columns.map((c) => {
          const vals = probe.records.map((r) => r[c]);
          const unique = vals.every((v) => v !== "" && v != null) && new Set(vals.map(String)).size === vals.length;
          const sample = vals.find((v) => v !== "" && v != null);
          return { label: c.padEnd(22), value: c, hint: `${unique ? "unique ✓" : "has blanks or repeats"}${sample !== undefined ? `   e.g. ${String(sample).slice(0, 28)}` : ""}` };
        })} initial={Math.max(0, probe.columns.indexOf(keyField ?? ""))}
          onSelect={(c) => { setKeyField(c); setKeyTransform(c.toLowerCase() === "slug" ? "none" : "slugify"); if (isNew) go("fields"); else { setSyncName(uniqueName(slug)); go("syncName"); } }} onCancel={back} />
      </> : null}

      {/* ---------------- fields (new collections) ---------------- */}
      {step === "fields" ? <>
        <Question title={`Which fields should "${collectionName}" have?`}>{probe ? "Fields can be worked out from your data, or copied from a collection you already have." : source === "none" ? "Start with a basic set, or copy the fields of a collection you already have." : "The template's columns become the collection's fields."} You can add or rename fields later{target?.kind === "new" && target.mode === "unmanaged" ? " in Framer" : ""}.</Question>
        <Select items={[
          probe ? { label: "Work them out from my data", value: "data", hint: `${inferred.length} fields` }
            : source === "none" ? { label: "Basic fields", value: "template", hint: "Title, Date, Image, Description, Content" }
            : { label: "General template", value: "template", hint: source === "markdown" ? "title, date, author, image, description, body" : "Name, Description, Price, Image, Link, Featured, Date" },
          ...(collections ?? []).map((c) => ({ label: `Copy fields from "${c.name}"`, value: c.name })),
        ]} onSelect={(v) => { setFieldsFrom(v); setSyncName(uniqueName(slug)); go("syncName"); }} onCancel={back} />
        {probe && inferred.length ? <Box marginTop={1}><Text dimColor>From your data: {inferred.map((f) => `${f.name} (${f.type})`).join(", ")}</Text></Box> : null}
      </> : null}

      {/* ---------------- name + review ---------------- */}
      {step === "syncName" ? <>
        <Question title="Name this sync">A short name for the link between your data and the collection. You'll see it on the home screen and use it in commands like `apply {syncName || slug}`.</Question>
        <Field label="Sync name" initial={syncName} onCancel={back}
          validate={(v) => (!NAME_RE.test(v) ? "letters, digits, - and _ only" : cfg.syncs[v] ? "a sync with that name exists" : null)}
          onSubmit={(v) => { setSyncName(v); go("review"); }} />
      </> : null}

      {step === "review" ? <>
        <Panel title="Review" color="cyan">
          {multi ? <Row label="Site">{siteName(ctx, project)}</Row> : null}
          <Row label="Collection">{collectionName}  <Text dimColor>{target?.kind === "existing" ? "existing" : target?.kind === "copy" ? `new managed copy of "${target.col.name}"` : `new, ${target?.kind === "new" && target.mode === "managed" ? "managed" : "regular"}`}</Text></Row>
          {isNew ? <Row label="Fields">{fieldsFrom === "data" ? `worked out from your data (${inferred.length})` : fieldsFrom === "template" ? (source === "none" ? "basic set (Title, Date, Image, Description, Content)" : "from the template") : `copied from "${fieldsFrom}"`}</Row> : null}
          <Row label="Data">{source ? sourceLabel[source] : ""}  <Text dimColor>{dataLabel}</Text></Row>
          {source !== "markdown" && source !== "none" ? <Row label="Key column">{create && fromCollection ? "slug (exact page addresses)" : create ? "from the template (Name or Title)" : keyField}</Row> : null}
          {dateOrder ? <Row label="Dates">{dateOrder === "DMY" ? "day first (10/08 = 10 August)" : "month first (10/08 = October 8)"}</Row> : null}
          <Row label="Sync name">{syncName}</Row>
        </Panel>
        <Question title="When you press Enter">{[
          create && fromCollection ? `• every item in "${fromCollection.name}" is saved to ${source === "markdown" ? mdPath : filePath}` : null,
          create && !fromCollection ? `• a ${source === "markdown" ? "folder with an example post" : "template"} is created at ${source === "markdown" ? mdPath : filePath}` : null,
          target?.kind !== "existing" ? `• the collection "${collectionName}" is created in Framer` : null,
          `• the sync is saved to ${path.basename(ctx.file ?? "the config")}`,
          source === "none" ? "• nothing is saved on this computer: items are only written when data is sent in" : "• you see a preview of the first sync. No items are written and nothing is published until you confirm there.",
        ].filter(Boolean).join("\n")}</Question>
        {error ? <ErrorBox error={error} /> : null}
        <Keys keys={[["enter", "set it up"], ["esc", "back"]]} />
      </> : null}

      {step === "working" ? <Panel title="Setting up" color="cyan">{progress.map((p) => <Done key={p}>{p}</Done>)}<Spinner label="Working…" /></Panel> : null}

      {step === "done" ? <>
        <Panel title="You're set up" color="green">{progress.map((p) => <Done key={p}>{p}</Done>)}</Panel>
        <Question title="How it works from now on">{(source === "none" ? [
          "Nothing is stored here: items are written when an agent, the HTTP API or a command sends them, matched by slug.",
          `• One Markdown post: framer-cms-sync add ${syncName} post.md  (update / remove work the same way)`,
          `• Rows: framer-cms-sync apply ${syncName} rows.json --partial  (or POST /syncs/${syncName}/apply)`,
          `• What's in the collection: framer-cms-sync items ${syncName}`,
          "• AI agents: create an access token (t on the home screen) and connect over MCP. They get add_posts, update_posts, apply_sync and more.",
          target?.kind === "new" ? `In Framer, add a CMS page or list for "${collectionName}" and bind its fields.` : null,
        ] : [
          source === "file" ? `1. Make changes in ${filePath}${sheet ? ` (sheet "${sheet}")` : ""}.` : source === "markdown" ? `1. Add or edit posts in ${mdPath}.` : source === "gsheet" ? "1. Make changes in your Google Sheet." : "1. The endpoint is read fresh each time.",
          `2. Preview what would change, then apply (in this app, or: framer-cms-sync apply ${syncName}).`,
          "3. Publish when you're ready. Applying only updates the CMS.",
          target?.kind === "copy" ? `Before publishing: in the Framer editor, switch your page template from "${target.col.name}" to "${collectionName}".` : target?.kind === "new" ? `In Framer, add a CMS page or list for "${collectionName}" and bind its fields.` : null,
          "To keep it updated automatically, run the apply command on a schedule (cron, GitHub Actions, n8n) or give an AI agent access (t: access tokens).",
        ]).filter(Boolean).join("\n")}</Question>
        <Command cmd={source === "none" ? `framer-cms-sync items ${syncName}` : `framer-cms-sync plan ${syncName}`} />
        <Keys keys={[["enter", source === "none" ? "open it" : "open the preview"], ["esc", "home"]]} />
      </> : null}

      {error && step !== "review" ? <ErrorBox error={error} /> : null}
      {!["review", "done", "working"].includes(step) && !busy ? <Keys keys={[["esc", history.length ? "back" : "cancel"]]} /> : null}
    </Box>
  );
}
