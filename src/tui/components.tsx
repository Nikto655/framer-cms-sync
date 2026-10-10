// Small building blocks for the terminal app.

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface Choice<T = string> { label: string; value: T; hint?: string; disabled?: boolean; color?: string }

export function Select<T>({ items, onSelect, onCancel, onHighlight, active = true, initial = 0 }: { items: Choice<T>[]; onSelect: (v: T) => void; onCancel?: () => void; onHighlight?: (v: T) => void; active?: boolean; initial?: number }) {
  // Disabled rows (e.g. group headings) are skipped when moving.
  const step = (from: number, dir: 1 | -1) => {
    for (let n = 1; n <= items.length; n++) { const j = (from + dir * n + items.length * n) % items.length; if (!items[j]?.disabled) return j; }
    return from;
  };
  const [i, setI] = useState(() => { const start = Math.min(initial, Math.max(0, items.length - 1)); return items[start]?.disabled ? step(start, 1) : start; });
  useEffect(() => { if (onHighlight && items[i]) onHighlight(items[i].value); }, [i]);
  useInput((input, key) => {
    if (key.upArrow || input === "k") setI((x) => step(x, -1));
    else if (key.downArrow || input === "j") setI((x) => step(x, 1));
    else if (key.return && items[i] && !items[i].disabled) onSelect(items[i].value);
    else if (key.escape && onCancel) onCancel();
  }, { isActive: active && items.length > 0 });
  if (!items.length) return <Text dimColor>(nothing here)</Text>;
  return (
    <Box flexDirection="column">
      {items.map((it, n) => (
        <Box key={n}>
          {it.disabled ? <Text bold>{it.label}</Text> : <Text color={it.color ?? (n === i ? "cyan" : undefined)} bold={!!it.color && n === i}>{n === i ? "› " : "  "}{it.label}</Text>}
          {it.hint ? <Text dimColor>  {it.hint}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

/** Complete a path on Tab: extend to the longest common prefix of matching entries. */
export function completePath(value: string, baseDir: string): string {
  const abs = path.resolve(baseDir, value || ".");
  const endsWithSep = value.endsWith("/") || value === "";
  const dir = endsWithSep ? abs : path.dirname(abs);
  const partial = endsWithSep ? "" : path.basename(abs);
  let entries: string[];
  try { entries = readdirSync(dir).filter((e) => e.startsWith(partial) && !e.startsWith(".")); } catch { return value; }
  if (!entries.length) return value;
  let common = entries[0];
  for (const e of entries) while (!e.startsWith(common)) common = common.slice(0, -1);
  const head = endsWithSep ? value : value.slice(0, value.length - partial.length);
  let out = head + common;
  if (entries.length === 1) { try { if (statSync(path.join(dir, common)).isDirectory()) out += "/"; } catch { /* ignore */ } }
  return out;
}

export function Field({ label, initial = "", mask, placeholder, pathBase, onSubmit, onCancel, validate, hint }: {
  label: string; initial?: string; mask?: boolean; placeholder?: string; pathBase?: string; hint?: string;
  onSubmit: (v: string) => void; onCancel?: () => void; validate?: (v: string) => string | null | Promise<string | null>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [gen, setGen] = useState(0);
  useInput((_input, key) => {
    if (key.escape && onCancel) onCancel();
    if (key.tab && pathBase !== undefined) { setValue((v) => completePath(v, pathBase)); setGen((g) => g + 1); }
  });
  const submit = async (v: string) => {
    if (validate) {
      setChecking(true);
      const err = await validate(v.trim());
      setChecking(false);
      if (err) { setError(err); return; }
    }
    onSubmit(v.trim());
  };
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{label} › </Text>
        <TextInput key={gen} value={value} onChange={(v) => { setValue(v); setError(null); }} onSubmit={submit} mask={mask ? "•" : undefined} placeholder={placeholder} />
      </Box>
      {checking ? <Text color="yellow">  checking…</Text> : null}
      {error ? <Text color="red">  ✗ {error}</Text> : null}
      {hint && !error ? <Text dimColor>  {hint}{pathBase !== undefined ? " · Tab completes paths" : ""}</Text> : null}
    </Box>
  );
}

export function Confirm({ message, note, onYes, onNo }: { message: string; note?: string; onYes: () => void; onNo: () => void }) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onYes();
    else if (input === "n" || input === "N" || key.escape) onNo();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>{message} <Text bold>(y/n)</Text></Text>
      {note ? <Text color="yellow">{note}</Text> : null}
    </Box>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function Spinner({ label }: { label: string }) {
  const [f, setF] = useState(0);
  useEffect(() => { const t = setInterval(() => setF((x) => (x + 1) % FRAMES.length), 80); return () => clearInterval(t); }, []);
  return <Text color="cyan">{FRAMES[f]} {label}</Text>;
}

export function Keys({ keys }: { keys: [string, string][] }) {
  return (
    <Box marginTop={1} flexWrap="wrap">
      {keys.map(([k, d]) => <Box key={k} marginRight={2}><Text color="cyan">[{k}]</Text><Text dimColor> {d}</Text></Box>)}
    </Box>
  );
}

export function Command({ cmd }: { cmd: string }) {
  return <Text dimColor>$ {cmd}</Text>;
}

export function ErrorBox({ error }: { error: { message: string; fix?: string } }) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="red">✗ {error.message}</Text>
      {error.fix ? <Text dimColor>  fix: {error.fix}</Text> : null}
    </Box>
  );
}

/** Explanatory text shown under a step: what it is, why it matters, what happens next. */
export function Help({ children, marginTop = 0 }: { children: React.ReactNode; marginTop?: number }) {
  return <Box marginTop={marginTop} marginBottom={1} flexDirection="column"><Text dimColor>{children}</Text></Box>;
}

/** A short "label  value" summary row. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <Box><Box width={14}><Text dimColor>{label}</Text></Box><Text>{children}</Text></Box>;
}

/** Pick several: space toggles, enter confirms. */
export function MultiSelect<T>({ items, onSubmit, onCancel, min = 1 }: { items: Choice<T>[]; onSubmit: (v: T[]) => void; onCancel?: () => void; min?: number }) {
  const [i, setI] = useState(0);
  const [on, setOn] = useState<Set<number>>(new Set());
  const [warn, setWarn] = useState(false);
  useInput((input, key) => {
    if (key.upArrow) setI((x) => (x - 1 + items.length) % items.length);
    else if (key.downArrow) setI((x) => (x + 1) % items.length);
    else if (input === " ") { setWarn(false); setOn((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); }
    else if (key.return) { if (on.size < min) setWarn(true); else onSubmit([...on].sort().map((n) => items[n].value)); }
    else if (key.escape && onCancel) onCancel();
  });
  return (
    <Box flexDirection="column">
      {items.map((it, n) => (
        <Box key={n}><Text color={n === i ? "cyan" : undefined}>{n === i ? "› " : "  "}{on.has(n) ? "[x] " : "[ ] "}{it.label}</Text>{it.hint ? <Text dimColor>  {it.hint}</Text> : null}</Box>
      ))}
      {warn ? <Text color="yellow">  pick at least {min} (space to select)</Text> : null}
      <Box marginTop={1}><Text color="cyan">[space]</Text><Text dimColor> select  </Text><Text color="cyan">[enter]</Text><Text dimColor> done  </Text><Text color="cyan">[esc]</Text><Text dimColor> back</Text></Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces used across screens, so every screen reads the same way:
// header · step progress · a question with its explanation · the choices · the key bar.

/** Progress through a multi-step flow: ✓ done · ● current · ○ to do. */
export function StepBar({ steps, current }: { steps: string[]; current: number }) {
  return (
    <Box marginBottom={1} flexWrap="wrap">
      {steps.map((label, i) => (
        <Box key={label} marginRight={1}>
          {i < current ? <Text color="green">✓ {label}</Text>
            : i === current ? <Text color="cyan" bold>● {label}</Text>
            : <Text dimColor>○ {label}</Text>}
          {i < steps.length - 1 ? <Text dimColor>  ─ </Text> : null}
        </Box>
      ))}
    </Box>
  );
}

/** A titled box for a group of information (summaries, results, instructions). */
export function Panel({ title, color = "gray", children }: { title?: string; color?: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      {title ? <Text bold color={color === "gray" ? undefined : color}>{title}</Text> : null}
      {children}
    </Box>
  );
}

/** The question a step asks, with a short explanation underneath. */
export function Question({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      {children ? <Text dimColor>{children}</Text> : null}
    </Box>
  );
}

/** A finished action, shown as a green tick line. */
export function Done({ children }: { children: React.ReactNode }) {
  return <Text color="green">✓ <Text color={undefined}>{children}</Text></Text>;
}
