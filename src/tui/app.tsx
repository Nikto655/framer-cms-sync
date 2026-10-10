// The terminal app: `framer-cms-sync` with no arguments in an interactive terminal.
// It adds no capabilities of its own: every action calls the same engine as the CLI,
// and each screen shows the equivalent command.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_NAMES, loadConfig, findConfig } from "../config/load.ts";
import { addProject, initConfig, deleteSite, deleteSync, editConfig, renameProject, setIn, setProjectLabel, type DeleteResult } from "../config/write.ts";
import { readState, writeState } from "../core/state.ts";
import { slugify } from "../core/identity.ts";
import { createSync, type Sync, type CollectionView } from "../engine.ts";
import { framerConnector } from "../framer/adapter.ts";
import type { SyncReport } from "../core/report.ts";
import type { Issue } from "../core/issues.ts";
import type { RunLogEntry } from "../core/runtime.ts";
import { type Choice, Command, Confirm, ErrorBox, Field, Help, Keys, MultiSelect, Panel, Question, Row, Select, Spinner, StepBar } from "./components.tsx";
import { addToken, revokeToken } from "../config/write.ts";
import { SCOPE_HELP, tokenSnippets } from "../core/snippets.ts";
import { NewSyncWizard } from "./wizard.tsx";
import { type Ctx, type Screen, siteColor, siteName, errInfo, Header, ProjectPicker, useProject, saveSource, validateSource, discoverColumns } from "./shared.tsx";
import { isGoogleSheet } from "../formats.ts";
import { NAME_RE, type Scope } from "../config/schema.ts";

// ---------------------------------------------------------------------------
function SetupScreen({ ctx }: { ctx: Ctx }) {
  const [step, setStep] = useState<"url" | "key" | "connecting" | "name" | "done">("url");
  const [key, setKey] = useState("");
  const [siteName, setSiteName] = useState("");
  const [url, setUrl] = useState(process.env.FRAMER_PROJECT_URL ?? "");
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const [result, setResult] = useState<{ name: string; count: number } | null>(null);

  const connect = async (k: string) => {
    setKey(k); setStep("connecting"); setError(null);
    try {
      const client = await framerConnector(url, k)();
      const name = await client.projectName();
      const count = (await client.listCollections()).length;
      await client.disconnect();
      setResult({ name, count }); setStep("name");
    } catch (e) { setError(errInfo(e)); setStep("key"); }
  };
  const save = (short: string) => {
    try {
      initConfig(ctx.dir, { url, key, siteName: short, label: result!.name, file: ctx.file ?? undefined });
      writeState(ctx.dir, { currentProject: short });
      setSiteName(short); setStep("done");
      ctx.reload();
    } catch (e) { setError(errInfo(e)); }
  };

  useInput((_i, key) => { if (step === "done" && key.return) ctx.go({ name: "newsync", firstRun: true }); }, { isActive: step === "done" });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}><Text bold>framer-cms-sync</Text><Text dimColor> · setup</Text></Box>
      <StepBar steps={["Site", "Collection", "Data source", "Connect", "Review"]} current={0} />
      <Question title="Welcome. Let's connect your Framer site.">framer-cms-sync keeps a Framer CMS collection in step with your own data: a spreadsheet, a Google Sheet, a folder of Markdown files or an API. First it needs your project's address and an API key.</Question>
      <Box flexDirection="column">
        {step === "url" ? <Help>Step 1 of 3 · Project URL. This is the address of your project in the Framer editor, not your live site. Open the project at framer.com in a browser and copy the address bar. It looks like https://framer.com/projects/My-Site--abc123</Help> : null}
        {step === "url" ? (
          <Field label="Project URL" initial={url} placeholder="https://framer.com/projects/…"
            validate={(v) => (/^https?:\/\/(www\.)?framer\.com\/projects\/[^\s/?#]+\/?([?#]\S*)?$/.test(v) || /^[A-Za-z0-9_-]{8,}$/.test(v) ? null : "that doesn't look like a Framer project URL (https://framer.com/projects/…)")}
            onSubmit={(v) => { setUrl(v); setStep("key"); }} />
        ) : <Text><Text bold>Project URL › </Text>{url}</Text>}
        {step === "key" ? <Help marginTop={1}>Step 2 of 3 · API key. The key lets this tool read and change your CMS. In Framer, open Site Settings → API and create a key, then paste it here. It's saved in a .env file next to the config (kept out of git), never in the config itself.</Help> : null}
        {step === "key" ? <Field label="API key" mask hint="esc to go back" onSubmit={connect} onCancel={() => setStep("url")} /> : null}
        {step === "connecting" ? <Spinner label="Connecting to Framer and checking the key…" /> : null}
        {step === "name" && result ? <>
          <Text color="green">✓ Connected to "{result.name}" ({result.count} collection{result.count === 1 ? "" : "s"})</Text>
          <Help marginTop={1}>Step 3 of 3 · Give this site a short name. It's how you'll refer to it in commands (like `--project shop`) and how sites are told apart if you add more later. The display name "{result.name}" comes from Framer. You can change both any time on the Sites screen.</Help>
          <Field label="Short name" initial={slugify(result.name) || "main"} hint="letters, digits, - and _"
            validate={(v) => (NAME_RE.test(v) ? null : "use letters, digits, - and _ only")} onSubmit={save} />
        </> : null}
        {error ? <ErrorBox error={error} /> : null}
        {step === "done" && result ? (
          <Box flexDirection="column" marginTop={1}>
            <Panel title={`Connected to "${result.name}"`} color="green">
              <Text>Saved as <Text bold>{siteName}</Text>. The URL and key are in .env (kept out of git); settings are in {CONFIG_NAMES[0]}.</Text>
            </Panel>
            <Question title="Next: connect your data">Pick a collection (new or existing) and where its data will come from. You'll review everything before anything is created, and see a preview before anything is written.</Question>
            <Command cmd={`framer-cms-sync init --name ${siteName} --url ${url} --key ••••`} />
            <Keys keys={[["enter", "continue"]]} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
function AddSiteScreen({ ctx }: { ctx: Ctx }) {
  const [step, setStep] = useState<"url" | "key" | "connecting" | "name" | "done">("url");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [framerName, setFramerName] = useState("");
  const [firstName, setFirstName] = useState<string | null>(null);
  const [firstLabel, setFirstLabel] = useState<string | undefined>();
  const [result, setResult] = useState<{ name: string; converted: string | null } | null>(null);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const names = ctx.engine?.projectNames ?? [];
  const single = names.length === 1 && names[0] === "default";

  // If the config has a single unnamed site, it gets a name too. Suggest one from its Framer name.
  useEffect(() => { if (single) ctx.engine!.project().then((r) => { setFirstName(slugify(r.name) || "main"); setFirstLabel(r.name); }).catch(() => setFirstName("main")); }, []);

  const connect = async (k: string) => {
    setKey(k); setStep("connecting"); setError(null);
    try {
      const client = await framerConnector(url, k)();
      setFramerName(await client.projectName());
      await client.disconnect();
      setStep("name");
    } catch (e) { setError(errInfo(e)); setStep("key"); }
  };
  const save = (name: string) => {
    try {
      const r = addProject(ctx.file!, { name, url, apiKey: key, label: framerName, firstName: firstName ?? "main", firstLabel });
      setResult({ name, converted: r.converted }); setStep("done"); ctx.setSite(name);
    } catch (e) { setError(errInfo(e)); }
  };
  useInput((_i, k) => { if (k.return && step === "done") ctx.go({ name: "home" }); if (k.escape && step === "done") ctx.go({ name: "home" }); }, { isActive: step === "done" });

  return (
    <Box flexDirection="column">
      <Header ctx={ctx} title="add a site" />
      <Help>Add another Framer project, so one setup can keep several sites in sync. Each site has its own URL and API key, and each sync belongs to one site.</Help>
      {step === "url" ? <><Help>Step 1 of 3 · Project URL: the address of the other project in the Framer editor (https://framer.com/projects/…).</Help>
        <Field label="Project URL" placeholder="https://framer.com/projects/…" onCancel={() => ctx.go({ name: "home" })}
          validate={(v) => (/^https?:\/\/(www\.)?framer\.com\/projects\/[^\s/?#]+\/?([?#]\S*)?$/.test(v) ? (Object.values(ctx.engine?.config.projects ?? {}).some((p) => p.url === v) ? "that site is already added" : null) : "that doesn't look like a Framer project URL (https://framer.com/projects/…)")}
          onSubmit={(v) => { setUrl(v); setStep("key"); }} /></> : url ? <Row label="Project URL">{url}</Row> : null}
      {step === "key" ? <><Help marginTop={1}>Step 2 of 3 · API key for that project (its Site Settings → API). Each site needs its own key. It's saved in .env, never in the config.</Help>
        <Field label="API key" mask onSubmit={(v) => void connect(v)} onCancel={() => setStep("url")} /></> : null}
      {step === "connecting" ? <Spinner label="Connecting to Framer and checking the key…" /> : null}
      {step === "name" ? <>
        <Text color="green">✓ Connected to "{framerName}"</Text>
        <Help marginTop={1}>Step 3 of 3 · A short name for this site. You'll pick sites by this name, and use it in commands like `--project shop`.{single && firstName ? ` Your current site will be called "${firstName}", and its syncs stay attached to it.` : ""}</Help>
        <Field label="Short name" initial={slugify(framerName) || ""} onCancel={() => ctx.go({ name: "home" })}
          validate={(v) => (!NAME_RE.test(v) ? "letters, digits, - and _ only" : names.includes(v) || v === firstName ? "that name is taken" : null)}
          onSubmit={save} /></> : null}
      {step === "done" && result ? <>
        <Text color="green">✓ Added "{framerName}" as "{result.name}"</Text>
        {result.converted ? <Text dimColor>  Your first site is now called "{result.converted}", and its syncs point at it.</Text> : null}
        <Help marginTop={1}>"{result.name}" is now your current site. New syncs, collections, redirects and publishing use it. Switch sites with Tab on the home screen, or see them all on the Sites screen (w).</Help>
        <Command cmd={`framer-cms-sync init --name ${result.name} --url ${url} --key ••••`} />
        <Keys keys={[["enter", "back to home"]]} />
      </> : null}
      {error ? <ErrorBox error={error} /> : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
/** Deleting from the program: say exactly what goes, ask about source files, then confirm. */
function DeleteFlow({ title, removes, files, onDelete, onCancel }: { title: string; removes: string[]; files: string[]; onDelete: (deleteFiles: boolean) => void; onCancel: () => void }) {
  const [step, setStep] = useState<"files" | "confirm">(files.length ? "files" : "confirm");
  const [deleteFiles, setDeleteFiles] = useState(false);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Panel title={title} color="red">
        <Text>This removes from framer-cms-sync:</Text>
        {removes.map((r) => <Text key={r}>  • {r}</Text>)}
        <Text dimColor>Nothing in Framer is changed: collections, items and the live site stay as they are.</Text>
      </Panel>
      {step === "files" ? <>
        <Question title="What about the source files?">{files.join(", ")}</Question>
        <Select items={[
          { label: "Keep the source files", value: "keep", hint: "recommended" },
          { label: "Delete the source files too", value: "delete", hint: "only files inside this project folder", color: "red" },
        ]} onSelect={(v) => { setDeleteFiles(v === "delete"); setStep("confirm"); }} onCancel={onCancel} />
      </> : <Confirm message={`${title}?`} note={files.length ? (deleteFiles ? `The source files are deleted too: ${files.join(", ")}.` : "The source files are kept.") : "This can't be undone, but you can set it up again any time."}
        onYes={() => onDelete(deleteFiles)} onNo={onCancel} />}
    </Box>
  );
}

const describeDelete = (r: DeleteResult) => [
  r.removedSyncs.length ? `syncs removed: ${r.removedSyncs.join(", ")}` : "",
  r.tokensRevoked.length ? `tokens revoked: ${r.tokensRevoked.join(", ")}` : "",
  r.deletedFiles.length ? `files deleted: ${r.deletedFiles.join(", ")}` : r.keptFiles.length ? `files kept: ${r.keptFiles.join(", ")}` : "",
].filter(Boolean).join(" · ");

// ---------------------------------------------------------------------------
function SitesScreen({ ctx }: { ctx: Ctx }) {
  const names = ctx.engine!.projectNames;
  const cfg = ctx.engine!.config;
  const [selected, setSelected] = useState<string>(ctx.site ?? names[0]);
  const [mode, setMode] = useState<null | "rename" | "label" | "remove">(null);
  const [status, setStatus] = useState<Record<string, string> | null>(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cmd, setCmd] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const syncsOf = (n: string) => Object.entries(cfg.syncs).filter(([, s]) => s.project === n).map(([k]) => k);
  const label = (n: string) => cfg.projects[n]?.label;

  const check = async () => {
    setChecking(true);
    const ps = await ctx.engine!.projects({ check: true });
    setStatus(Object.fromEntries(ps.map((p) => [p.name, (p as { ok?: boolean }).ok ? `✓ connected` : `✗ ${(p as { error?: string }).error}`])));
    setChecking(false);
  };
  const act = (fn: () => void, done: string, command: string) => { setError(null); try { fn(); setMsg(done); setCmd(command); setMode(null); } catch (e) { setError(errInfo(e)); } };

  useInput((input, key) => {
    if (key.escape) ctx.go({ name: "home" });
    else if (input === "r") { setMsg(null); setMode("rename"); }
    else if (input === "l") { setMsg(null); setMode("label"); }
    else if (input === "x") { setMsg(null); setMode("remove"); }
    else if (input === "a") ctx.go({ name: "addsite" });
    else if (input === "c" && !checking) void check();
  }, { isActive: !mode });

  return (
    <Box flexDirection="column">
      <Header ctx={ctx} title="sites" />
      <Help>Each site is one Framer project with its own collections and API key. The current site (●) is the one the home screen, new syncs, collections, redirects and publishing use. Pick a site and press enter to switch to it.</Help>
      {!mode ? <Select items={names.map((n) => ({
        label: `${n === ctx.site ? "● " : "  "}${n.padEnd(16)}`,
        value: n, color: siteColor(ctx, n),
        hint: `${label(n) ?? "(no display name)"} · ${syncsOf(n).length} sync${syncsOf(n).length === 1 ? "" : "s"}${status?.[n] ? ` · ${status[n]}` : ""}`,
      }))} initial={Math.max(0, names.indexOf(selected))} onHighlight={setSelected}
        onSelect={(n) => { ctx.setSite(n); ctx.go({ name: "home" }); }} onCancel={() => ctx.go({ name: "home" })} /> : <Row label="Site">{selected}{label(selected) ? <Text dimColor>  ({label(selected)})</Text> : null}</Row>}

      {mode === "rename" ? <Box flexDirection="column" marginTop={1}>
        <Help>The short name is how you refer to this site in commands (`--project {selected}`) and in the config. Syncs that belong to it follow the new name automatically. Nothing changes in Framer.</Help>
        <Field label="New short name" initial={selected} onCancel={() => setMode(null)}
          validate={(v) => (!NAME_RE.test(v) ? "letters, digits, - and _ only" : v !== selected && names.includes(v) ? "another site already has that name" : null)}
          onSubmit={(v) => act(() => {
            if (v === selected) return;
            renameProject(ctx.file!, selected, v);
            if (ctx.site === selected) ctx.setSite(v); else ctx.reload();
            setSelected(v);
          }, `✓ renamed "${selected}" to "${v}"`, `framer-cms-sync projects rename ${selected} ${v}`)} />
      </Box> : null}

      {mode === "label" ? <Box flexDirection="column" marginTop={1}>
        <Help>The display name is what you see in this app, like "Maya's Shop". It's only used here; your Framer project's own name doesn't change. Leave it empty to clear it.</Help>
        <Field label="Display name" initial={label(selected) ?? ""} onCancel={() => setMode(null)}
          onSubmit={(v) => act(() => { setProjectLabel(ctx.file!, selected, v); ctx.reload(); }, v ? `✓ "${selected}" is now shown as "${v}"` : `✓ cleared the display name of "${selected}"`, `framer-cms-sync projects label ${selected}${v ? ` "${v}"` : ""}`)} />
      </Box> : null}

      {mode === "remove" ? <DeleteFlow
        title={`Delete ${siteName(ctx, selected)}`}
        removes={[
          "the site's connection (its URL and API key in .env)",
          syncsOf(selected).length ? `its ${syncsOf(selected).length} sync${syncsOf(selected).length === 1 ? "" : "s"}: ${syncsOf(selected).join(", ")}` : "it has no syncs",
          "access tokens limited to it",
          ...(names.length === 1 ? ["this is your only site, so the app goes back to first-time setup"] : []),
        ]}
        files={syncsOf(selected).map((n) => cfg.syncs[n].source.path).filter((p): p is string => !!p)}
        onCancel={() => setMode(null)}
        onDelete={(deleteFiles) => {
          try {
            const r = deleteSite(ctx.file!, selected, { deleteFiles });
            if (r.reset) { ctx.reload(); ctx.go({ name: "setup" }); return; }
            if (ctx.site === selected) ctx.setSite(names.find((n) => n !== selected)!); else ctx.reload();
            setMsg(`✓ deleted "${selected}"${describeDelete(r) ? ` · ${describeDelete(r)}` : ""}`); setCmd(`framer-cms-sync projects remove ${selected} --with-syncs${deleteFiles ? " --delete-files" : ""}`); setMode(null);
          } catch (e) { setError(errInfo(e)); setMode(null); }
        }} /> : null}

      {checking ? <Spinner label="Connecting to each site…" /> : null}
      {msg ? <Text color="green">{msg}</Text> : null}
      {error ? <ErrorBox error={error} /> : null}
      {!mode ? <Keys keys={[["enter", "switch to it"], ["r", "rename"], ["l", "display name"], ["a", "add a site"], ["x", "delete"], ["c", "check connections"], ["esc", "back"]]} /> : null}
      {!mode && cmd ? <Command cmd={cmd} /> : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
const TOKEN_USES: { label: string; value: string; scope: Scope; name: string; description: string; hint: string }[] = [
  { label: "AI agent (MCP)", value: "agent", scope: "write", name: "agent", description: "AI agent (MCP)", hint: "Claude, Cursor… can preview and write, not publish" },
  { label: "AI agent that may also publish", value: "agent-publish", scope: "publish", name: "agent", description: "AI agent (MCP), can publish", hint: "can put the site live: only if you trust it to" },
  { label: "Automation that writes", value: "automation", scope: "write", name: "n8n", description: "Automation (writes)", hint: "n8n, Make, cron, CI: syncs data, you publish" },
  { label: "Automation that writes and publishes", value: "automation-publish", scope: "publish", name: "n8n-publish", description: "Automation (writes and publishes)", hint: "e.g. a weekly sync that goes live by itself" },
  { label: "Read-only", value: "read", scope: "read", name: "readonly", description: "Read-only", hint: "dashboards, monitoring, previews; never writes" },
  { label: "Full admin", value: "admin", scope: "admin", name: "admin", description: "Admin", hint: "everything, including creating collections" },
];

function TokensScreen({ ctx }: { ctx: Ctx }) {
  type Step = "list" | "details" | "use" | "name" | "description" | "limit" | "pick" | "summary" | "reveal" | "revoke";
  const cfg = ctx.engine!.config;
  const tokens = [
    ...cfg.server.tokens,
  ];
  const sites = ctx.engine!.projectNames;
  const syncNames = Object.keys(cfg.syncs);
  const [step, setStep] = useState<Step>("list");
  const [selected, setSelected] = useState<string | null>(tokens[0]?.name ?? null);
  const [use, setUse] = useState<(typeof TOKEN_USES)[number] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [limitKind, setLimitKind] = useState<"all" | "sites" | "syncs">("all");
  const [limits, setLimits] = useState<string[]>([]);
  const [created, setCreated] = useState<{ value: string; envVar: string } | null>(null);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const inDocker = existsSync("/.dockerenv");
  const baseUrl = `http://127.0.0.1:${cfg.server.port}`;
  const tok = tokens.find((t) => t.name === selected);
  const limitText = (t: { projects?: string[]; syncs?: string[] }) =>
    [...(t.projects ?? []).map((p) => `site ${p}`), ...(t.syncs ?? []).map((x) => `sync ${x}`)].join(", ") || "everything";

  const reset = () => { setUse(null); setName(""); setDescription(""); setLimitKind("all"); setLimits([]); setCreated(null); setError(null); };
  const create = () => {
    try {
      const r = addToken(ctx.file!, { name, scope: use!.scope, description, ...(limitKind === "sites" ? { projects: limits } : limitKind === "syncs" ? { syncs: limits } : {}) });
      setCreated(r); setStep("reveal");
    } catch (e) { setError(errInfo(e)); }
  };

  useInput((input, key) => {
    if (step === "list") {
      if (key.escape) ctx.go({ name: "home" });
      else if (input === "n") { reset(); setStep("use"); }
      else if (input === "x" && tok) { setMsg(null); setStep("revoke"); }
    } else if (step === "details" && key.escape) setStep("list");
    else if (step === "summary") { if (key.return) create(); else if (key.escape) setStep("list"); }
    else if (step === "reveal" && key.return) { ctx.reload(); reset(); setStep("list"); setMsg(`✓ token "${name}" created`); }
  }, { isActive: ["list", "details", "summary", "reveal"].includes(step) });

  return (
    <Box flexDirection="column">
      <Header ctx={ctx} title="access tokens" />

      {step === "list" ? <>
        <Help>Tokens let other things use framer-cms-sync over the network: AI agents (MCP over HTTP), n8n or Make workflows, scripts and CI. Each token has its own permissions, and you can have as many as you like, one per use. Your Framer API key is never shared; a token only unlocks this tool, and only as far as its scope allows. Local agents started on this machine don't need a token.</Help>
        <Select items={[
          ...tokens.map((t) => ({ label: t.name.padEnd(16), value: t.name, hint: `${t.scope.padEnd(8)} ${limitText(t)}${t.description ? ` · ${t.description}` : ""}${t.created ? ` · ${t.created}` : ""}` })),
          { label: "+ new token", value: "__new" },
        ]} onHighlight={(v) => { if (v !== "__new") setSelected(v); }} onSelect={(v) => { if (v === "__new") { reset(); setStep("use"); } else { setSelected(v); setStep("details"); } }} onCancel={() => ctx.go({ name: "home" })} />
        {!tokens.length ? <Help marginTop={1}>No tokens yet. You don't need one to use this app or the CLI on this machine; create one when something else needs access.</Help> : null}
        {msg ? <Text color="green">{msg}</Text> : null}
        <Keys keys={[["enter", "details"], ["n", "new token"], ...(tok ? [["x", `revoke ${tok.name}`]] as [string, string][] : []), ["esc", "back"]]} />
      </> : null}

      {step === "details" && tok ? <>
        <Row label="Token">{tok.name}</Row>
        <Row label="Scope">{tok.scope}: {SCOPE_HELP[tok.scope]}</Row>
        <Row label="Limited to">{limitText(tok)}</Row>
        {tok.description ? <Row label="Used by">{tok.description}</Row> : null}
        {tok.created ? <Row label="Created">{tok.created}</Row> : null}
        <Help marginTop={1}>The token's value was shown once when it was created and is stored in .env. If it's lost, revoke this token and create a new one. Requests send it in the x-sync-token header.{tok.projects || tok.syncs ? " Tokens limited to some sites or syncs work for the HTTP API but not for MCP." : ""}</Help>
        <Keys keys={[["esc", "back"]]} />
      </> : null}

      {step === "revoke" && tok ? <Confirm message={`Revoke "${tok.name}"?`} note="Anything using it is refused from now on, including a running server. This can't be undone; you'd create a new token instead."
        onYes={() => { try { revokeToken(ctx.file!, tok.name); ctx.reload(); setMsg(`✓ revoked "${tok.name}"`); setSelected(null); } catch (e) { setError(errInfo(e)); } setStep("list"); }}
        onNo={() => setStep("list")} /> : null}

      {step === "use" ? <>
        <Text bold>What will use this token?</Text>
        <Help>This sets what it's allowed to do. Give each thing its own token, with no more access than it needs, so you can revoke one without affecting the others.</Help>
        <Select items={TOKEN_USES.map((u) => ({ label: u.label, value: u.value, hint: `${u.scope} · ${u.hint}` }))} onCancel={() => setStep("list")}
          onSelect={(v) => { const u = TOKEN_USES.find((x) => x.value === v)!; setUse(u); let n = u.name, i = 2; while (tokens.some((t) => t.name === n)) n = `${u.name}-${i++}`; setName(n); setDescription(u.description); setStep("name"); }} />
        <Box flexDirection="column" marginTop={1}>{Object.entries(SCOPE_HELP).map(([k, v]) => <Text key={k} dimColor>{k.padEnd(8)} {v}</Text>)}</Box>
      </> : null}

      {use && !["list", "use", "details", "revoke"].includes(step) ? <Row label="Use">{use.label} <Text dimColor>({use.scope})</Text></Row> : null}

      {step === "name" ? <>
        <Help marginTop={1}>A short name, so you can tell tokens apart and revoke the right one. It appears in the run history next to what this token did.</Help>
        <Field label="Token name" initial={name} onCancel={() => setStep("use")}
          validate={(v) => (!NAME_RE.test(v) ? "letters, digits, - and _ only" : tokens.some((t) => t.name === v) ? "a token with that name exists" : null)}
          onSubmit={(v) => { setName(v); setStep("description"); }} />
      </> : name && !["list", "use", "details", "revoke"].includes(step) ? <Row label="Name">{name}</Row> : null}

      {step === "description" ? <>
        <Help marginTop={1}>What uses it, in your own words, e.g. "Claude on my laptop" or "n8n weekly pricing". Only for you.</Help>
        <Field label="Used by" initial={description} onCancel={() => setStep("name")} onSubmit={(v) => { setDescription(v); setStep("limit"); }} />
      </> : null}

      {step === "limit" ? <>
        <Text bold>What can it reach?</Text>
        <Help>Limiting a token to certain {sites.length > 1 ? "sites or " : ""}syncs means a leaked token can only touch those. Limited tokens work for the HTTP API (n8n, scripts) but not for MCP, so leave AI agents on "everything".</Help>
        <Select items={[
          { label: "Everything", value: "all", hint: sites.length > 1 ? "all sites and syncs" : "all syncs" },
          ...(sites.length > 1 ? [{ label: "Only some sites", value: "sites" }] : []),
          ...(syncNames.length ? [{ label: "Only some syncs", value: "syncs" }] : []),
        ]} onCancel={() => setStep("description")} onSelect={(v) => { setLimitKind(v as "all" | "sites" | "syncs"); setLimits([]); setStep(v === "all" ? "summary" : "pick"); }} />
      </> : null}

      {step === "pick" ? <>
        <Text bold>Which {limitKind}?</Text>
        <MultiSelect items={(limitKind === "sites" ? sites : syncNames).map((n) => ({ label: n, value: n, hint: limitKind === "sites" ? cfg.projects[n].label ?? "" : `${cfg.syncs[n].collection.name ?? ""}${sites.length > 1 ? ` · ${cfg.syncs[n].project}` : ""}` }))}
          onSubmit={(v) => { setLimits(v); setStep("summary"); }} onCancel={() => setStep("limit")} />
      </> : null}

      {step === "summary" && use ? <>
        <Row label="Scope">{use.scope}: {SCOPE_HELP[use.scope]}</Row>
        <Row label="Reaches">{limitKind === "all" ? "everything" : `${limitKind}: ${limits.join(", ")}`}</Row>
        {use.value.startsWith("agent") && limitKind !== "all" ? <Text color="yellow">  Note: limited tokens can't be used for MCP. Pick "Everything" for an AI agent.</Text> : null}
        <Help marginTop={1}>Enter creates the token: a random value is saved in .env and the token is added to the config. It's shown to you once, on the next screen. A running server picks it up straight away.</Help>
        {error ? <ErrorBox error={error} /> : null}
        <Keys keys={[["enter", "create"], ["esc", "cancel"]]} />
      </> : null}

      {step === "reveal" && created && use ? <>
        <Text color="green">✓ Created "{name}"</Text>
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
          <Text bold>Copy this token now. It won't be shown again.</Text>
          <Text>{created.value}</Text>
        </Box>
        {tokenSnippets({ value: created.value, scope: use.scope, limited: limitKind !== "all", baseUrl, exampleSync: limitKind === "syncs" ? limits[0] : syncNames[0] }).map((sn) => (
          <Box key={sn.title} flexDirection="column" marginBottom={1}><Text bold>{sn.title}</Text><Text dimColor>{sn.text}</Text></Box>
        ))}
        <Help>{inDocker ? `You're inside the Docker container. From your computer, replace ${baseUrl} with the address and port you published for the container (the left side of -p, e.g. 127.0.0.1:8080).` : `Change ${baseUrl} if the service runs somewhere else.`} The value is stored in .env as {created.envVar}.</Help>
        <Command cmd={`framer-cms-sync tokens add ${name} --scope ${use.scope}${limitKind === "sites" ? ` --sites ${limits.join(",")}` : limitKind === "syncs" ? ` --syncs ${limits.join(",")}` : ""}`} />
        <Keys keys={[["enter", "done"]]} />
      </> : null}

      {step !== "summary" && error ? <ErrorBox error={error} /> : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
function HomeScreen({ ctx }: { ctx: Ctx }) {
  const { exit } = useApp();
  const [history, setHistory] = useState<RunLogEntry[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [pickPublish, setPickPublish] = useState(false);
  const [publishProject, setPublishProject] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const projectNames = ctx.engine?.projectNames ?? [];
  const multi = projectNames.length > 1;
  const [msg, setMsg] = useState<{ ok: boolean; text: string; fix?: string } | null>(null);
  const syncs = ctx.engine?.syncs() ?? [];
  useEffect(() => { ctx.engine?.history(200).then(setHistory); }, [ctx.engine]);
  const lastRun = (name: string) => history.find((h) => h.sync === name && h.op === "apply");
  const lastPublish = history.find((h) => h.deploymentId);

  const row = (s: (typeof syncs)[number]) => {
    const lr = lastRun(s.name);
    return { label: s.name.padEnd(14), value: s.name, hint: `${s.source} → ${s.collection}${lr ? `   last run ${ago(lr.at)}` : ""}` };
  };
  const site = ctx.site ?? projectNames[0];
  const siteSyncs = syncs.filter((s) => s.project === site);
  const items: Choice<string>[] = [
    ...siteSyncs.map(row),
    { label: "+ new sync", value: "__new" },
    { label: "+ add a site", value: "__site", hint: multi ? "" : "keep another Framer project in sync from here too" },
  ];
  useInput((input, key) => {
    if (input === "q") exit();
    else if (input === "n") ctx.go({ name: "newsync" });
    else if (input === "r") ctx.go({ name: "redirects" });
    else if (input === "c") ctx.go({ name: "collections" });
    else if (input === "h") ctx.go({ name: "history" });
    else if (input === "a") ctx.go({ name: "addsite" });
    else if (input === "w") ctx.go({ name: "sites" });
    else if (input === "t") ctx.go({ name: "tokens" });
    else if (key.tab && multi) ctx.setSite(projectNames[(projectNames.indexOf(site) + 1) % projectNames.length]);
    else if (input === "p") { setPublishProject(site); setConfirm(true); }
  }, { isActive: !confirm && !busy && !pickPublish });

  const publish = async () => {
    setConfirm(false); setBusy("Publishing…");
    try { const r = await ctx.engine!.publish({ project: publishProject ?? undefined }); setMsg({ ok: true, text: `published${r.deployed ? " and deployed" : ""} → ${r.hostnames.join(", ")}` }); }
    catch (e) { const i = errInfo(e); setMsg({ ok: false, text: i.message, fix: i.fix }); }
    setBusy(null);
  };

  return (
    <Box flexDirection="column">
      <Header ctx={ctx} title={lastPublish ? `last published ${ago(lastPublish.at)}` : undefined} />
      {multi ? (
        <Box marginBottom={1}>
          {projectNames.map((p) => <Box key={p} marginRight={2}><Text color={siteColor(ctx, p)} bold={p === site} dimColor={p !== site}>{p === site ? "● " : "○ "}{ctx.engine!.config.projects[p].label ?? p}{ctx.engine!.config.projects[p].label ? <Text dimColor> {p}</Text> : null}</Text></Box>)}
          <Text dimColor>  tab: next site · w: all sites</Text>
        </Box>
      ) : null}
      <Panel title={`Syncs${multi ? ` · ${ctx.engine!.config.projects[site]?.label ?? site}` : ""}`} color={multi ? siteColor(ctx, site) ?? "gray" : "gray"}>
        <Text dimColor>{siteSyncs.length
          ? "Each sync keeps one Framer collection in step with one source of data. Open one to preview its changes; nothing is written until you confirm."
          : `No syncs ${multi ? "for this site " : ""}yet. Create one to connect a spreadsheet, a Google Sheet, Markdown files or an API to a collection.`}</Text>
        <Box marginTop={1}><Select items={items} active={!confirm && !busy && !pickPublish} onSelect={(v) => (v === "__new" ? ctx.go({ name: "newsync" }) : v === "__site" ? ctx.go({ name: "addsite" }) : ctx.go({ name: "sync", sync: v }))} /></Box>
      </Panel>
      {pickPublish ? <Box marginTop={1}><ProjectPicker ctx={ctx} purpose="Publishing puts one site live as it is right now. Pick the site to publish." onPick={(p) => { setPublishProject(p); setPickPublish(false); setConfirm(true); }} onCancel={() => setPickPublish(false)} /></Box> : null}
      {confirm ? <Box marginTop={1}><Confirm message={`Publish ${siteName(ctx, publishProject)} now?`} note={`This puts the whole ${siteName(ctx, publishProject)} site live as it is right now, not just CMS changes.`} onYes={publish} onNo={() => setConfirm(false)} /></Box> : null}
      {busy ? <Spinner label={busy} /> : null}
      {msg ? <Box flexDirection="column" marginTop={1}><Text color={msg.ok ? "green" : "red"}>{msg.ok ? "✓" : "✗"} {msg.text}</Text>{msg.fix ? <Text dimColor>  fix: {msg.fix}</Text> : null}{msg.ok ? <Command cmd={`framer-cms-sync publish${multi ? ` --project ${publishProject}` : ""}`} /> : null}</Box> : null}
      <Keys keys={[["enter", "open"], ["n", "new sync"], ...(multi ? [["tab", "next site"]] as [string, string][] : []), ["w", "sites"], ["t", "access tokens"], ["a", "add a site"], ["r", "redirects"], ["c", "collections"], ["h", "history"], ["p", "publish"], ["q", "quit"]]} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
function IssueList({ issues, max = 8 }: { issues: { errors: Issue[]; warnings: Issue[] }; max?: number }) {
  const block = (arr: Issue[], color: string, icon: string, word: string) => arr.length ? (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color}>{icon} {arr.length} {word}{arr.length === 1 ? "" : "s"}</Text>
      {arr.slice(0, max).map((i, n) => (
        <Box key={n} flexDirection="column">
          <Text>  {i.message}</Text>
          {i.fix ? <Text dimColor>    fix: {i.fix}</Text> : null}
        </Box>
      ))}
      {arr.length > max ? <Text dimColor>  … {arr.length - max} more</Text> : null}
    </Box>
  ) : null;
  return <>{block(issues.errors, "red", "✗", "error")}{block(issues.warnings, "yellow", "⚠", "warning")}</>;
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "(empty)" : typeof v === "string" ? v : JSON.stringify(v));

function Count({ n, label, color }: { n: number; label: string; color?: string }) {
  return <Box marginRight={3} flexDirection="column"><Text bold color={n ? color : undefined} dimColor={!n}>{n}</Text><Text dimColor>{label}</Text></Box>;
}

function ReportView({ r }: { r: SyncReport }) {
  const it = r.items;
  return (
    <Box flexDirection="column">
      <Panel title={r.operation === "apply" && r.applied ? "Applied" : "Preview"} color={r.issues.errors.length ? "red" : r.operation === "apply" && r.applied ? "green" : "cyan"}>
        <Box marginY={0}>
          <Count n={it.create.length} label="new" color="green" />
          <Count n={it.update.length} label="to update" color="cyan" />
          <Count n={it.remove.length} label="to remove" color="red" />
          <Count n={it.unchanged + it.unverified.length} label={it.unverified.length ? "same (or rewritten)" : "unchanged"} />
          {it.skipped.length ? <Count n={it.skipped.length} label="left alone" /> : null}
        </Box>
        <Text dimColor>{r.source.records} record{r.source.records === 1 ? "" : "s"} from {r.source.from === "url" ? "the URL" : r.source.from} → {r.mode === "managed" ? "managed" : "regular"} collection "{r.collection.name}"</Text>
        <Text dimColor>{r.run.description}</Text>
      </Panel>
      {it.create.length ? <Box><Text color="green">new  </Text><Text>{it.create.slice(0, 8).join(", ")}{it.create.length > 8 ? ` … +${it.create.length - 8}` : ""}</Text></Box> : null}
      {it.update.length ? (
        <Box flexDirection="column" marginTop={it.create.length ? 1 : 0}>
          {it.update.slice(0, 8).map((u) => u.changes.slice(0, 3).map((c, n) => (
            <Text key={u.slug + n}>{n === 0 ? u.slug.padEnd(22) : " ".repeat(22)} <Text dimColor>{c.field}</Text>  {show(c.from)} → <Text color="cyan">{show(c.to)}</Text></Text>
          )))}
          {it.update.length > 8 ? <Text dimColor>… {it.update.length - 8} more</Text> : null}
        </Box>
      ) : null}
      {it.missing.length && !it.remove.length ? <Box marginTop={1}><Text dimColor>{it.missing.length} in Framer but not in your data (kept unless you choose "Replace all"): {it.missing.slice(0, 6).join(", ")}{it.missing.length > 6 ? " …" : ""}</Text></Box> : null}
      {it.remove.length ? <Box marginTop={1}><Text color="red">remove  </Text><Text>{it.remove.slice(0, 8).join(", ")}{it.remove.length > 8 ? ` … +${it.remove.length - 8}` : ""}</Text></Box> : null}
      <IssueList issues={r.issues} />
    </Box>
  );
}

type ApplyChoice = "upsert" | "add" | "update" | "replace";
const CHOICE_OPTS: Record<ApplyChoice, { partial?: boolean; createOnly?: boolean; updateOnly?: boolean; replace?: boolean }> = {
  upsert: { partial: true }, add: { createOnly: true }, update: { updateOnly: true }, replace: { replace: true },
};
const CHOICE_FLAG: Record<ApplyChoice, string> = { upsert: " --partial", add: " --create-only", update: " --update-only", replace: " --replace" };

function SyncScreen(props: { ctx: Ctx; name: string; message?: string }) {
  return props.ctx.engine!.config.syncs[props.name]?.source.type === "none" ? <PassThroughScreen {...props} /> : <PreviewScreen {...props} />;
}

/** A sync with no source of its own: nothing to preview, so show what's in the collection and how to send data. */
function PassThroughScreen({ ctx, name, message }: { ctx: Ctx; name: string; message?: string }) {
  const [items, setItems] = useState<{ count: number; items: { slug: string; draft?: boolean }[]; collection: { name: string } } | null>(null);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const load = useCallback(async () => {
    setError(null); setItems(null);
    try { setItems(await ctx.engine!.items(name)); } catch (e) { setError(errInfo(e)); }
  }, [ctx.engine, name]);
  useEffect(() => { void load(); }, [load]);
  useInput((input, key) => {
    if (key.escape) ctx.go({ name: "home" });
    else if (input === "r") void load();
    else if (input === "s") ctx.go({ name: "settings", sync: name });
  });
  const syncSite = ctx.engine!.config.syncs[name]?.project;
  return (
    <Box flexDirection="column">
      <Header ctx={ctx} project={syncSite} title={name} />
      {message ? <Text color="green">{message.replace("Here's what the first sync would do:", "")}</Text> : null}
      <Help>This sync has no source of its own. Its data is sent in by AI agents, the HTTP API or single commands, and written straight away (matched by slug). Nothing is saved on this computer.</Help>
      {error ? <ErrorBox error={error} /> : null}
      {!items && !error ? <Spinner label="Reading the collection…" /> : null}
      {items ? <Panel title={`"${items.collection.name}" · ${items.count} item${items.count === 1 ? "" : "s"}`} color="cyan">
        {items.items.slice(0, 12).map((i) => <Text key={i.slug}>{i.slug}{i.draft ? <Text dimColor>  (draft)</Text> : null}</Text>)}
        {items.count > 12 ? <Text dimColor>…and {items.count - 12} more</Text> : null}
      </Panel> : null}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Sending data</Text>
        <Text>  framer-cms-sync add {name} post.md      <Text dimColor>one Markdown post (update / remove the same way)</Text></Text>
        <Text>  framer-cms-sync apply {name} rows.json  <Text dimColor>rows; add --partial to never remove</Text></Text>
        <Text>  POST /syncs/{name}/apply · /items      <Text dimColor>over HTTP, with an access token</Text></Text>
        <Text>  MCP: add_posts, update_posts, apply_sync <Text dimColor>for AI agents (t: access tokens)</Text></Text>
      </Box>
      <Keys keys={[["r", "refresh"], ["s", "settings"], ["esc", "back"]]} />
    </Box>
  );
}

function PreviewScreen({ ctx, name, message }: { ctx: Ctx; name: string; message?: string }) {
  type State = "loading" | "ready" | "choose" | "overwrite" | "publish" | "confirm" | "mass" | "applying" | "done" | "error";
  const [state, setState] = useState<State>("loading");
  const [report, setReport] = useState<SyncReport | null>(null);
  const [preview, setPreview] = useState<SyncReport | null>(null);
  const [choice, setChoice] = useState<ApplyChoice>("upsert");
  const [publish, setPublish] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const [cmd, setCmd] = useState<string | null>(null);

  const plan = useCallback(async () => {
    setState("loading"); setError(null); setCmd(null);
    try { const r = await ctx.engine!.plan(name, undefined, { full: true }); setReport(r); setPreview(r); setState("ready"); }
    catch (e) { setError(errInfo(e)); setState("error"); }
  }, [ctx.engine, name]);
  useEffect(() => { void plan(); }, [plan]);

  const syncSite = ctx.engine!.config.syncs[name]?.project;
  const syncSourceIsUrl = !!ctx.engine!.config.syncs[name]?.source.url;
  const site = siteName(ctx, syncSite);
  const hasErrors = !!report?.issues.errors.length;
  const it = preview?.items;
  const nNew = it?.create.length ?? 0, nChanged = (it?.update.length ?? 0) + (it?.unverified.length ?? 0), nMissing = it?.missing.length ?? 0;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const describe = (c: ApplyChoice) =>
    c === "add" ? `Add ${plural(nNew, "new item")}` : c === "update" ? `Update ${plural(nChanged, "changed item")}`
      : `${[nNew ? `add ${nNew} new` : "", nChanged ? `update ${nChanged} changed` : "", c === "replace" && nMissing ? `remove ${nMissing}` : ""].filter(Boolean).join(", ") || "Nothing to change"}`.replace(/^./, (x) => x.toUpperCase());

  const apply = async (allowMassRemove = false) => {
    setState("applying"); setError(null);
    try {
      const r = await ctx.engine!.apply(name, undefined, { ...CHOICE_OPTS[choice], publish, allowMassRemove, full: true });
      setReport(r);
      if (!r.applied && r.issues.errors.some((e) => e.code === "PRUNE_GUARD") && choice === "replace" && !allowMassRemove) return setState("mass");
      setState("done"); setCmd(`framer-cms-sync apply ${name}${CHOICE_FLAG[choice]}${publish ? " --publish" : ""}${allowMassRemove ? " --allow-mass-remove" : ""}`);
    } catch (e) { setError(errInfo(e)); setState("error"); }
  };
  useInput((input, key) => {
    if (key.escape) ctx.go({ name: "home" });
    else if (input === "r") void plan();
    else if (input === "s") ctx.go({ name: "settings", sync: name });
    else if (state === "ready" && (input === "a" || key.return) && !hasErrors) setState("choose");
  }, { isActive: state === "ready" || state === "done" || state === "error" });

  return (
    <Box flexDirection="column">
      <Header ctx={ctx} project={syncSite} title={`${name}${state === "done" ? "" : " · preview"}`} />
      {message && state === "ready" ? <Text color="green">{message}</Text> : null}
      {state === "loading" ? <Spinner label="Reading your data and comparing with Framer…" /> : null}
      {state === "applying" ? <Spinner label="Writing to Framer…" /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {report && state !== "loading" && state !== "applying" ? <ReportView r={state === "done" ? report : preview ?? report} /> : null}
      {state === "ready" && report ? <Help marginTop={1}>{hasErrors
        ? "Nothing has been written. Fix the errors in your data (each one says how), then press r to preview again."
        : "Nothing has been written yet. Items are matched by slug. Press a to choose what to apply."}</Help> : null}

      {state === "choose" ? <>
        <Question title="What should this apply do?">Items are matched by slug. Nothing is written until you confirm.</Question>
        <Select items={[
          { label: "Only add new", value: "add", hint: `${nNew} new · existing items untouched` },
          { label: "Only update existing", value: "update", hint: `${nChanged} changed · new items left out` },
          { label: "Add new and update changed", value: "upsert", hint: `${nNew} new · ${nChanged} changed · nothing removed` },
          { label: "Replace all", value: "replace", hint: `${nNew} new · ${nChanged} changed · ${nMissing} removed (in Framer but not in your data)`, color: nMissing ? "red" : undefined },
        ]} onSelect={(c) => {
          setChoice(c as ApplyChoice);
          // Unmanaged collections can be edited in Framer; updating replaces those edits, so say so first.
          setState(preview?.mode === "unmanaged" && nChanged > 0 && c !== "add" ? "overwrite" : "publish");
        }} onCancel={() => setState("ready")} />
      </> : null}

      {state === "overwrite" ? <>
        <Panel title="⚠ Changes made in Framer will be replaced" color="yellow">
          <Text>{plural(nChanged, "item")} in "{preview!.collection.name}" {nChanged === 1 ? "is" : "are"} different in Framer from your data:</Text>
          <Text dimColor>  {[...(it?.update.map((u) => u.slug) ?? []), ...(it?.unverified ?? [])].slice(0, 8).join(", ")}{nChanged > 8 ? ` and ${nChanged - 8} more` : ""}</Text>
          <Text> </Text>
          <Text>Applying replaces them with what's in your data. If anyone edited these items in the Framer editor, those edits will be lost.</Text>
          <Text>{syncSourceIsUrl
            ? "To keep them, copy the changes into your source first (Google Sheets and endpoints can't be downloaded into)."
            : "To keep them, download from Framer first (Settings → Download from Framer). That brings Framer's current content into your file, then preview again."}</Text>
        </Panel>
        <Select items={[
          { label: "Replace with my data", value: "yes", hint: "edits made in Framer to these items are lost", color: "yellow" },
          ...(syncSourceIsUrl ? [] : [{ label: "Download from Framer first", value: "pull", hint: "opens Settings; nothing is written" }]),
          { label: "Go back", value: "no", hint: "nothing is written" },
        ]} onSelect={(v) => (v === "yes" ? setState("publish") : v === "pull" ? ctx.go({ name: "settings", sync: name }) : setState("ready"))} onCancel={() => setState("choose")} />
      </> : null}

      {state === "publish" ? <>
        <Question title="Publish the site afterwards?">Applying only changes the CMS in the Framer editor. Publishing puts the whole site live as it is right then, not just these changes.</Question>
        <Select items={[
          { label: "No, just update the CMS", value: "no", hint: "your live site stays as it is" },
          { label: `Yes, publish ${site}`, value: "yes", hint: "puts the whole site live" },
        ]} onSelect={(v) => { setPublish(v === "yes"); setState("confirm"); }} onCancel={() => setState(preview?.mode === "unmanaged" && nChanged > 0 && choice !== "add" ? "overwrite" : "choose")} />
      </> : null}

      {state === "confirm" ? <Confirm
        message={`${describe(choice)} in "${report!.collection.name}"${publish ? `, then publish ${site}` : ""}?`}
        note={[
          choice === "replace" && nMissing ? `Removes: ${preview!.items.missing.slice(0, 6).join(", ")}${nMissing > 6 ? ` and ${nMissing - 6} more` : ""}.` : "",
          choice === "replace" && nMissing && nMissing > 0.2 * (nChanged + (it?.unchanged ?? 0) + nMissing) ? `⚠ That's a large share of the collection: make sure your data is the complete list.` : "",
          preview?.mode === "unmanaged" && nChanged > 0 && choice !== "add" ? `Framer edits to ${plural(nChanged, "item")} will be replaced.` : "",
          publish ? `Publishing puts the whole ${site} site live as it is now.` : "The live site won't change.",
        ].filter(Boolean).join(" ")}
        onYes={() => void apply(choice === "replace")} onNo={() => setState("ready")} /> : null}

      {state === "mass" ? <Confirm message={`This removes ${nMissing} of the items in "${report!.collection.name}", more than the usual safety limit. Remove them anyway?`}
        note="Only continue if your data really is the complete list. Nothing has been written yet." onYes={() => void apply(true)} onNo={() => setState("ready")} /> : null}

      {state === "done" && report?.applied ? <Panel title="Done" color="green">
        <Text color="green">✓ {report.applied.upserted} written{report.applied.removed ? `, ${report.applied.removed} removed` : ""}{report.applied.upserted + report.applied.removed === 0 ? " (nothing needed changing)" : ""}</Text>
        {report.publish ? <Text color="green">✓ published → {report.publish.hostnames.join(", ")}</Text> : <Text dimColor>Your live site hasn't changed. Publish when you're ready (a → … → publish, or p on the home screen).</Text>}
      </Panel> : null}
      {state === "done" && report && !report.applied ? <Text color="red">Nothing was written: fix the errors above.</Text> : null}
      {cmd ? <Command cmd={cmd} /> : state === "ready" ? <Command cmd={`framer-cms-sync plan ${name}`} /> : null}
      {["ready", "done", "error"].includes(state) ? <Keys keys={[
        ...(state === "ready" && !hasErrors ? [["a", "apply…"]] as [string, string][] : []),
        ["r", state === "done" ? "preview again" : "refresh"], ["s", "settings"], ["esc", "back"],
      ]} /> : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
function EscOnly({ onBack }: { onBack: () => void }) {
  useInput((_i, key) => { if (key.escape) onBack(); });
  return <Text dimColor>esc to go back</Text>;
}

const SETTING_HELP: Record<string, string> = {
  pull: "Brings Framer's current content down into this sync's file or folder, replacing what's there. Use it after editing items in Framer, so your file matches before you make more changes. The sync only ever writes your file into Framer; this is the one way back.",
  source: "Where the data comes from: a CSV or JSON file, a folder of Markdown posts (.md files), or a web address that returns JSON or CSV. Paths start from the folder that holds the config. If a web address contains a secret token, it's moved to .env automatically.",
  key: "Pick the column whose value identifies each row, like a name or title. It becomes the page's URL slug (\"Pro Monthly\" → pro-monthly) and is how rows are matched to items in Framer on every sync, so choose something unique that rarely changes. Changing it later changes every page's URL.",
  collection: "The Framer collection this sync writes to. Hand-built collections are filled as they are. A collection owned by another plugin can't be written to, so choosing one sets up your own copy.",
  publish: "What happens after changes are written to the CMS. Publishing puts your whole site live as it is at that moment, not just this collection.",
  prune: "When on, items that are in Framer but no longer in your data are deleted when you apply. The preview always lists them first, and a single run can't remove more than 20% of the collection unless you confirm it.",
  path: "The address prefix of these pages on your site, such as /blog/. It's used to create redirects when you delete an item, so old links keep working.",
};

function SettingsScreen({ ctx, name }: { ctx: Ctx; name: string }) {
  const sync = ctx.engine!.config.syncs[name];
  const [editing, setEditing] = useState<string | null>(null);
  const [options, setOptions] = useState<Choice<string>[] | null>(null);
  const [collections, setCollections] = useState<CollectionView[] | null>(null);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const done = (what: string) => { ctx.reload(); setEditing(null); setOptions(null); setSaved(what); };
  const set = (keys: string[], value: unknown) => editConfig(ctx.file!, (doc) => setIn(doc, ["syncs", name, ...keys], value));
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setEditing(null); setPulling(true); setError(null);
    try {
      const r = await ctx.engine!.pull(name);
      ctx.reload();
      setSaved(`downloaded ${r.rows} item${r.rows === 1 ? "" : "s"} from "${r.collection.name}" into ${r.dest}${r.backup ? `. Previous version saved as ${r.backup}` : ""}`);
    } catch (e) { setError(errInfo(e)); }
    setPulling(false);
  };

  const open = async (what: string) => {
    setError(null); setSaved(null);
    try {
      if (what === "key") setOptions((await discoverColumns(ctx, name)).map((c) => ({ label: c, value: c })));
      if (what === "collection") setCollections(await ctx.engine!.collections());
      setEditing(what);
    } catch (e) { setError(errInfo(e)); }
  };

  const items: Choice<string>[] = [
    { label: "Source".padEnd(14), value: "source", hint: sync.source.type === "none" ? "nothing: data is sent in" : sync.source.path ?? sync.source.url ?? "(not set)" },
    { label: "Collection".padEnd(14), value: "collection", hint: `${sync.collection.name ?? sync.collection.id}${sync.collection.mode === "auto" ? "" : ` (${sync.collection.mode})`}` },
    ...(sync.source.type !== "markdown" && sync.source.type !== "none" ? [{ label: "Key column".padEnd(14), value: "key", hint: sync.key?.field ?? "(not set)" }] : []),
    { label: "Publish".padEnd(14), value: "publish", hint: sync.publish ?? `${ctx.engine!.config.defaults.publish} (default)` },
    { label: "Remove missing".padEnd(14), value: "prune", hint: sync.prune ? `on (max ${sync.prune.maxRemove} per run)` : "off" },
    { label: "Page path".padEnd(14), value: "path", hint: sync.path ?? "(not set, used by redirects)" },
    { label: "Delete this sync", value: "delete", hint: "remove it from framer-cms-sync; Framer isn't touched" },
    { label: "Download from Framer", value: "pull", hint: sync.source.path ? `replace ${sync.source.path} with everything in "${sync.collection.name ?? sync.collection.id}"` : sync.source.type === "none" ? "not available: this sync stores nothing locally" : "not available for URL sources" },
  ];

  useInput((_i, key) => { if (key.escape) ctx.go({ name: "sync", sync: name }); }, { isActive: !editing });

  return (
    <Box flexDirection="column">
      <Header ctx={ctx} project={ctx.engine!.config.syncs[name]?.project} title={`${name} · settings`} />
      {!editing ? <Help>These settings control where this sync gets its data and how it writes to Framer. Each change is checked when you enter it, and you go back to a fresh preview, so you see its effect before anything is written.</Help> : null}
      {!editing ? <Select items={items} onSelect={(v) => void open(v)} /> : null}
      {editing && SETTING_HELP[editing] ? <Help>{SETTING_HELP[editing]}</Help> : null}
      {editing === "delete" ? <DeleteFlow
        title={`Delete the sync "${name}"`}
        removes={[
          `its settings (source, key, mappings) for "${sync.collection.name ?? sync.collection.id}"`,
          "any secrets saved for its source (a URL token or header) in .env",
          "access tokens limited to it",
        ]}
        files={sync.source.path ? [sync.source.path] : []}
        onCancel={() => setEditing(null)}
        onDelete={(deleteFiles) => {
          try { deleteSync(ctx.file!, name, { deleteFiles }); ctx.reload(); ctx.go({ name: "home" }); }
          catch (e) { setError(errInfo(e)); setEditing(null); }
        }} /> : null}
      {editing === "pull" && sync.source.type === "none" ? <Box flexDirection="column"><ErrorBox error={{ message: "This sync has no source of its own, so there's nothing to download into.", fix: `to keep a copy, run: framer-cms-sync download "${sync.collection.name ?? sync.collection.id}" ./data/${ctx.engine!.syncConfig(name).project}/${name}.csv` }} /><EscOnly onBack={() => setEditing(null)} /></Box> : null}
      {editing === "pull" && sync.source.type !== "none" ? (sync.source.url
        ? <Box flexDirection="column"><ErrorBox error={{ message: "This sync reads from a URL, which the tool can't write to.", fix: isGoogleSheet(sync.source.url) ? `download a CSV from the home screen's collections, or run: framer-cms-sync download "${sync.collection.name ?? sync.collection.id}" ./data/${ctx.engine!.syncConfig(name).project}/${name}.csv, then File → Import it in Google Sheets` : "use framer-cms-sync download to save the collection to a file" }} /><EscOnly onBack={() => setEditing(null)} /></Box>
        : <Confirm message={`Replace ${sync.source.path} with everything in "${sync.collection.name ?? sync.collection.id}"?`}
            note="Your file will match Framer exactly. Edits you haven't applied, and columns that aren't fields in Framer, would be lost, so the current version is saved as a backup next to it first."
            onYes={() => void pull()} onNo={() => setEditing(null)} />) : null}
      {pulling ? <Spinner label="Downloading from Framer…" /> : null}
      {editing === "source" ? (
        <Field label="File, folder or URL" initial={sync.source.path ?? sync.source.url ?? ""} pathBase={ctx.dir}
          hint="secrets in URLs are moved to .env" validate={(v) => validateSource(v, ctx.dir)}
          onSubmit={(v) => { saveSource(ctx, name, v, sync.source.type); done("source"); }} onCancel={() => setEditing(null)} />
      ) : null}
      {editing === "key" && options ? (
        <Box flexDirection="column"><Text bold>Which column identifies each row?</Text>
          <Select items={options} onCancel={() => setEditing(null)} onSelect={(v) => { set(["key"], { field: v, transform: "slugify" }); done("key column"); }} /></Box>
      ) : null}
      {editing === "collection" && collections ? (
        <Box flexDirection="column"><Text bold>Which collection should this sync write to?</Text>
          <Select items={collections.map((c) => ({ label: c.name, value: c.id, hint: c.short }))} onCancel={() => setEditing(null)}
            onSelect={(id) => {
              const c = collections.find((x) => x.id === id)!;
              if (c.ownership === "other") { set(["collection"], { name: `${c.name} Synced`, create: true }); set(["schemaFrom"], c.name); done(`collection: run setup to create "${c.name} Synced", then point your page template at it in Framer`); }
              else { set(["collection"], { name: c.name }); set(["schemaFrom"], undefined); done("collection"); }
            }} /></Box>
      ) : null}
      {editing === "publish" ? (
        <Select items={[{ label: "never", value: "never", hint: "write data only; publish yourself" }, { label: "on-change", value: "on-change", hint: "publish only when something changed" }, { label: "always", value: "always", hint: "publish after every apply" }]}
          onCancel={() => setEditing(null)} onSelect={(v) => { set(["publish"], v); done("publish"); }} />
      ) : null}
      {editing === "prune" ? (
        <Select items={[{ label: "off", value: "off", hint: "never remove items from Framer" }, { label: "on", value: "on", hint: "remove items missing from your data (max 20% per run)" }]}
          onCancel={() => setEditing(null)} onSelect={(v) => { set(["prune"], v === "on" ? { minItems: 1, maxRemove: "20%" } : false); done("remove missing"); }} />
      ) : null}
      {editing === "path" ? (
        <Field label="Page path prefix" initial={sync.path ?? ""} placeholder="/blog/" validate={(v) => (!v || v.startsWith("/") ? null : 'start with "/", e.g. /blog/')}
          onSubmit={(v) => { set(["path"], v || undefined); done("page path"); }} onCancel={() => setEditing(null)} />
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
      {saved ? <Text color="green">✓ {saved.startsWith("downloaded") ? saved : `saved ${saved}`}</Text> : null}
      {editing === "pull" || editing === "delete" || pulling ? null : <Keys keys={editing ? [["enter", "save"], ["esc", "cancel"]] : [["enter", "change"], ["esc", "back to preview"]]} />}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
function RedirectsScreen({ ctx }: { ctx: Ctx }) {
  const [project, setProject] = useProject(ctx);
  const [file, setFile] = useState<string | null>(null);
  const [plan, setPlan] = useState<Awaited<ReturnType<Sync["redirects"]["plan"]>> | null>(null);
  const [state, setState] = useState<"input" | "loading" | "ready" | "confirm" | "applying" | "done">("input");
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async (f: string) => {
    setFile(f); setState("loading"); setError(null);
    try { setPlan(await ctx.engine!.redirects.plan(readFileSync(path.resolve(ctx.dir, f), "utf8"), { project: project! })); setState("ready"); }
    catch (e) { setError(errInfo(e)); setState("input"); }
  };
  const apply = async () => {
    setState("applying");
    try { const r = await ctx.engine!.redirects.apply(readFileSync(path.resolve(ctx.dir, file!), "utf8"), { project: project! }) as { ok: boolean; added?: number; updated?: number }; setDone(r.ok ? `✓ ${r.added} added, ${r.updated} updated (site not published)` : "nothing written"); setState("done"); }
    catch (e) { setError(errInfo(e)); setState("ready"); }
  };
  const errors = plan?.issues.filter((i) => i.level === "error") ?? [];
  useInput((input, key) => {
    if (key.escape) ctx.go({ name: "home" });
    else if (input === "a" && state === "ready" && !errors.length) setState("confirm");
  }, { isActive: state === "ready" || state === "done" });

  return (
    <Box flexDirection="column">
      <Header ctx={ctx} project={project ?? undefined} title="redirects" />
      {!project ? <ProjectPicker ctx={ctx} purpose="Redirects belong to one site. Which site's redirects?" onPick={setProject} onCancel={() => ctx.go({ name: "home" })} /> : null}
      {project && state === "input" ? <Help>Import redirects from a CSV with a header row "from,to" (full URLs or paths like /old-page). You'll see what would be added or changed, and any problems, before anything is written. Redirects go live when you publish.</Help> : null}
      {project && state === "input" ? <Field label="Redirects CSV (from,to)" pathBase={ctx.dir} placeholder="./redirects.csv" validate={(v) => (existsSync(path.resolve(ctx.dir, v)) ? null : "no such file")} onSubmit={(v) => void load(v)} onCancel={() => ctx.go({ name: "home" })} /> : null}
      {state === "loading" || state === "applying" ? <Spinner label={state === "loading" ? "Checking redirects…" : "Writing redirects…"} /> : null}
      {plan && state !== "input" && state !== "loading" ? (
        <Box flexDirection="column">
          <Text><Text color="green">{plan.add.length} to add</Text>   {plan.update.length} to update   {plan.unchanged.length} unchanged</Text>
          <IssueList issues={{ errors, warnings: plan.issues.filter((i) => i.level === "warning") }} />
        </Box>
      ) : null}
      {state === "confirm" ? <Confirm message={`Add ${plan!.add.length} and update ${plan!.update.length} redirects on ${siteName(ctx, project)}?`} note="Redirects take effect when the site is next published." onYes={apply} onNo={() => setState("ready")} /> : null}
      {done ? <><Text color="green">{done}</Text><Command cmd={`framer-cms-sync redirects apply ${file}${(ctx.engine?.projectNames.length ?? 0) > 1 ? ` --project ${project}` : ""}`} /></> : null}
      {error ? <ErrorBox error={error} /> : null}
      <Keys keys={[...(state === "ready" && !errors.length ? [["a", "apply"]] as [string, string][] : []), ["esc", "back"]]} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
function CollectionsScreen({ ctx }: { ctx: Ctx }) {
  const [project, setProject] = useProject(ctx);
  const [cols, setCols] = useState<CollectionView[] | null>(null);
  const [fields, setFields] = useState<{ name: string; fields: { name: string; type: string; id: string }[] } | null>(null);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  useEffect(() => { if (project) { setCols(null); ctx.engine!.collections({ project }).then(setCols).catch((e) => setError(errInfo(e))); } }, [project]);
  useInput((_i, key) => { if (key.escape) (fields ? setFields(null) : ctx.go({ name: "home" })); }, { isActive: !!project && (!!fields || !cols) });
  return (
    <Box flexDirection="column">
      <Header ctx={ctx} project={project ?? undefined} title={fields ? fields.name : "collections"} />
      {!project ? <ProjectPicker ctx={ctx} purpose="Each site has its own collections. Which site do you want to look at?" onPick={setProject} onCancel={() => ctx.go({ name: "home" })} /> : null}
      {project && !cols && !error ? <Spinner label="Loading…" /> : null}
      {cols && !fields ? <Help>The CMS collections in this site and what the tool can do with each. Enter shows a collection's fields.</Help> : null}
      {cols && !fields ? <Select items={cols.map((c) => ({ label: c.name.padEnd(24), value: c.id, hint: `${c.writable ? "" : "✗ "}${c.short}` }))} onCancel={() => ctx.go({ name: "home" })}
        onSelect={async (id) => { const r = await ctx.engine!.fields(id, { project: project! }); setFields({ name: r.collection.name, fields: r.fields }); }} /> : null}
      {fields ? <Box flexDirection="column">{fields.fields.map((f) => <Text key={f.id}>{f.name.padEnd(28)} <Text dimColor>{f.type.padEnd(16)} {f.id}</Text></Text>)}</Box> : null}
      {error ? <ErrorBox error={error} /> : null}
      <Keys keys={fields ? [["esc", "back"]] : [["enter", "fields"], ["esc", "back"]]} />
    </Box>
  );
}

function HistoryScreen({ ctx }: { ctx: Ctx }) {
  const [h, setH] = useState<RunLogEntry[] | null>(null);
  useEffect(() => { ctx.engine!.history(30).then(setH); }, []);
  useInput((_i, key) => { if (key.escape) ctx.go({ name: "home" }); });
  return (
    <Box flexDirection="column">
      <Header ctx={ctx} title="history" />
      {h && !h.length ? <Text dimColor>No runs yet.</Text> : null}
      {h?.map((e, n) => (
        <Text key={n}>
          <Text dimColor>{e.at.replace("T", " ").slice(0, 16)}  {e.actor.padEnd(8)}</Text> {e.ok ? <Text color="green">✓</Text> : <Text color="red">✗</Text>} {`${e.op}${e.sync ? " " + e.sync : ""}`.padEnd(20)} {(ctx.engine?.projectNames.length ?? 0) > 1 ? <Text color={siteColor(ctx, e.project ?? (e.sync ? ctx.engine?.config.syncs[e.sync]?.project : undefined))}>{(e.project ?? (e.sync ? ctx.engine?.config.syncs[e.sync]?.project : "") ?? "").padEnd(14)}</Text> : null}
          <Text dimColor>{e.error ?? (e.counts ? Object.entries(e.counts).map(([k, v]) => `${k} ${v}`).join(", ") : "")}</Text>
        </Text>
      ))}
      <Keys keys={[["esc", "back"]]} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function App({ dir, configFile, initialScreen }: { dir: string; configFile?: string; initialScreen?: "setup" | "addsite" }) {
  const [version, setVersion] = useState(0);
  const file = useMemo(() => (configFile ? path.resolve(configFile) : findConfig(dir)), [dir, configFile, version]);
  const { engine, loadError, site } = useMemo(() => {
    if (!file) return { engine: null, loadError: null, site: null };
    try {
      const loaded = loadConfig(file);
      const names = Object.keys(loaded.config.projects);
      const saved = readState(loaded.dir).currentProject;
      const current = saved && names.includes(saved) ? saved : names[0];
      return { engine: createSync({ config: loaded.config, configDir: loaded.dir, configFile: loaded.file, actor: "tui", defaultProject: current }), loadError: null, site: current };
    } catch (e) { return { engine: null, loadError: errInfo(e), site: null }; }
  }, [file, version]);
  const [screen, setScreen] = useState<Screen>(initialScreen === "setup" || !file ? { name: "setup" } : initialScreen === "addsite" ? { name: "addsite" } : { name: "home" });
  const ctxDir = file ? path.dirname(file) : dir;
  const ctx: Ctx = {
    dir: ctxDir, file, engine, loadError, site,
    setSite: (name) => { writeState(ctxDir, { currentProject: name }); setVersion((v) => v + 1); },
    reload: () => setVersion((v) => v + 1), go: setScreen,
  };

  if (loadError && screen.name !== "setup") {
    return <Box flexDirection="column"><Text bold>framer-cms-sync</Text><ErrorBox error={loadError} /><Text dimColor>Fix the config file and run again (or delete it to start setup over).</Text></Box>;
  }
  switch (screen.name) {
    case "setup": return <SetupScreen ctx={ctx} />;
    case "home": return <HomeScreen ctx={ctx} />;
    case "addsite": return <AddSiteScreen ctx={ctx} />;
    case "sites": return <SitesScreen ctx={ctx} />;
    case "tokens": return <TokensScreen ctx={ctx} />;
    case "sync": return <SyncScreen key={screen.sync + version} ctx={ctx} name={screen.sync} message={screen.message} />;
    case "settings": return <SettingsScreen ctx={ctx} name={screen.sync} />;
    case "newsync": return <NewSyncWizard ctx={ctx} firstRun={screen.firstRun} />;
    case "redirects": return <RedirectsScreen ctx={ctx} />;
    case "collections": return <CollectionsScreen ctx={ctx} />;
    case "history": return <HistoryScreen ctx={ctx} />;
  }
}

export async function runTui(opts: { dir: string; configFile?: string; initialScreen?: "setup" | "addsite" }) {
  const app = render(<App {...opts} />);
  await app.waitUntilExit();
}
