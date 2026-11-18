// Which model does each kind of job (#152, #120's shape on #36's page): Default gives every kind
// its provider, model and effort unless the kind names its own, and any kind may name a fallback
// for while its own provider is out of usage. The choices are T3's: the providers it has
// connected, their models and each model's efforts (`src/t3/catalog.ts`). No provider or model is
// named here: they all come from T3 and the settings. Shared with the renderer, so nothing here
// touches Node.

export const JOB_KINDS = [
  { id: 'build', label: 'Build', does: 'Builds a ticket and opens its pull request.' },
  { id: 'fix', label: 'Fix', does: 'Fixes what a review found on a pull request.' },
  { id: 'conflict', label: 'Conflict', does: 'Merges the base into a pull request that conflicts with it.' },
  { id: 'decision', label: 'Decision', does: "Decides a case the flow doesn't cover." },
  { id: 'review', label: 'Review', does: 'Reviews every pull request.' },
  { id: 'ask', label: 'Ask', does: 'Answers a question from the Inbox.' },
] as const;
export type JobKind = (typeof JOB_KINDS)[number]['id'];

/** A provider instance (T3's `instanceId`), one of its models, and an effort that model offers
 *  (null for a model with none to choose). */
export type ModelChoice = { provider: string; model: string; effort: string | null };
/** A kind's own model (null follows Default) and its fallback (null: the job waits for the reset). */
export type KindJob = { own: ModelChoice | null; fallback: ModelChoice | null };
/** Default (null follows T3's own default until it's chosen or kept) and each kind. */
export type Jobs = { default: ModelChoice | null } & Record<JobKind, KindJob>;

export const DEFAULT_JOBS: Jobs = {
  default: null,
  ...(Object.fromEntries(JOB_KINDS.map((k) => [k.id, { own: null, fallback: null }])) as Record<JobKind, KindJob>),
};

export type Effort = { id: string; label: string };
export type CatalogModel = {
  id: string;
  label: string;
  isDefault: boolean;
  /** The option T3 reads this model's effort from: its driver's id for it. Null: no effort. */
  effortOption: string | null;
  efforts: Effort[];
  defaultEffort: string | null;
};
export type CatalogProvider = { id: string; label: string; models: CatalogModel[] };
/** What T3 offers: its connected providers, and the model it starts a thread on by default. */
export type Catalog = { providers: CatalogProvider[]; t3Default: ModelChoice | null };

export const provider = (c: Catalog, id: string) => c.providers.find((p) => p.id === id);
export const model = (c: Catalog, choice: { provider: string; model: string }) =>
  provider(c, choice.provider)?.models.find((m) => m.id === choice.model);
export const defaultModelOf = (p: CatalogProvider) => p.models.find((m) => m.isDefault) ?? p.models[0];

/** The choice as T3 can run it: its provider connected and its model listed, with an effort the
 *  model offers (else its default). Null when T3 can't run it. */
export function usable(choice: ModelChoice | null, c: Catalog): ModelChoice | null {
  if (!choice) return null;
  const m = model(c, choice);
  if (!m) return null;
  const effort = m.efforts.some((e) => e.id === choice.effort) ? choice.effort : m.defaultEffort;
  return { provider: choice.provider, model: m.id, effort };
}

/** Default's model: the one chosen, else T3's own default (`followsT3`, which the page nudges). */
export function defaultModel(jobs: Jobs, c: Catalog): { choice: ModelChoice | null; followsT3: boolean } {
  const chosen = usable(jobs.default, c);
  return { choice: chosen ?? c.t3Default, followsT3: chosen === null };
}

/** The model a kind runs on (its own, else Default's) and its fallback, each one T3 can run. */
export function kindModels(jobs: Jobs, kind: JobKind, c: Catalog): { choice: ModelChoice | null; fallback: ModelChoice | null; followsDefault: boolean } {
  const k = jobs[kind];
  return {
    choice: usable(k.own, c) ?? defaultModel(jobs, c).choice,
    fallback: usable(k.fallback, c),
    followsDefault: k.own === null,
  };
}

const keepEffort = (m: CatalogModel, effort: string | null) =>
  (m.efforts.some((e) => e.id === effort) ? effort : m.defaultEffort);

/** The choice on another provider: its default model, keeping the effort if that model offers it. */
export function withProvider(from: ModelChoice, providerId: string, c: Catalog): ModelChoice {
  const p = provider(c, providerId);
  const m = p && defaultModelOf(p);
  if (!m) return { provider: providerId, model: from.model, effort: from.effort };
  return { provider: providerId, model: m.id, effort: keepEffort(m, from.effort) };
}

/** The choice on another model of the same provider, keeping the effort if it offers it. */
export function withModel(from: ModelChoice, modelId: string, c: Catalog): ModelChoice {
  const m = model(c, { provider: from.provider, model: modelId });
  return { provider: from.provider, model: modelId, effort: m ? keepEffort(m, from.effort) : from.effort };
}

const isChoice = (v: unknown): v is ModelChoice => {
  const x = v as ModelChoice;
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && typeof x.provider === 'string' && x.provider !== '' && typeof x.model === 'string' && x.model !== ''
    && (x.effort === null || typeof x.effort === 'string') && Object.keys(v).length === 3;
};
const choiceOrNull = (v: unknown): ModelChoice | null | undefined =>
  (v === null || v === undefined ? null : isChoice(v) ? { provider: v.provider, model: v.model, effort: v.effort } : undefined);

/** The jobs setting, checked: undefined for anything that isn't one. A kind it doesn't name has
 *  nothing of its own. */
export function checkJobs(v: unknown): Jobs | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  const kinds = JOB_KINDS.map((k) => k.id) as string[];
  if (Object.keys(raw).some((k) => k !== 'default' && !kinds.includes(k))) return undefined;
  const def = choiceOrNull(raw.default);
  if (def === undefined) return undefined;
  const out: Jobs = { ...DEFAULT_JOBS, default: def };
  for (const k of JOB_KINDS) {
    const kind = raw[k.id];
    if (kind === undefined) continue;
    if (typeof kind !== 'object' || kind === null || Array.isArray(kind)) return undefined;
    const { own, fallback, ...rest } = kind as Record<string, unknown>;
    const o = choiceOrNull(own), f = choiceOrNull(fallback);
    if (o === undefined || f === undefined || Object.keys(rest).length) return undefined;
    out[k.id] = { own: o, fallback: f };
  }
  return out;
}
