// What T3 offers for a job (#152): its connected providers, their models and each model's
// efforts, read from `subscribeServerConfig`'s `providers` (docs/app.md, Job models). Each model
// carries its options (`capabilities.optionDescriptors`); its effort is the select option whose id
// names an effort (`effort`, `reasoningEffort`: the driver's own id, which a launch must send) or,
// failing that, the one T3 labels Reasoning. T3's default is its `defaultModelSelection` when
// that's connected, else the first connected provider's default model. Pure: no Node.
import { defaultModelOf, usable, type Catalog, type CatalogModel, type CatalogProvider, type ModelChoice } from '../jobs.ts';

/** A provider T3 can start a thread on now: switched on and ready. */
const connected = (p: any) => p && p.enabled !== false && p.status === 'ready' && typeof p.instanceId === 'string';

function effortOf(m: any): Pick<CatalogModel, 'effortOption' | 'efforts' | 'defaultEffort'> {
  const opts: any[] = (m?.capabilities?.optionDescriptors ?? []).filter((o: any) => o?.type === 'select' && Array.isArray(o.options));
  const o = opts.find((x) => /effort/i.test(String(x.id))) ?? opts.find((x) => /reason/i.test(String(x.label)));
  if (!o) return { effortOption: null, efforts: [], defaultEffort: null };
  const efforts = o.options.filter((e: any) => typeof e?.id === 'string').map((e: any) => ({ id: e.id, label: String(e.label ?? e.id) }));
  const def = o.options.find((e: any) => e?.isDefault)?.id ?? o.currentValue;
  return { effortOption: String(o.id), efforts, defaultEffort: efforts.some((e: any) => e.id === def) ? def : efforts[0]?.id ?? null };
}

function providerOf(p: any): CatalogProvider {
  const models = (Array.isArray(p.models) ? p.models : [])
    .filter((m: any) => typeof m?.slug === 'string')
    .map((m: any): CatalogModel => ({ id: m.slug, label: String(m.name ?? m.slug), isDefault: m.isDefault === true, ...effortOf(m) }));
  return { id: p.instanceId, label: String(p.displayName ?? p.instanceId), models };
}

/** The catalog from T3's server config (`config` of the snapshot: `providers` and `settings`). */
export function catalogFromConfig(config: { providers?: unknown; settings?: any }): Catalog {
  const providers = (Array.isArray(config.providers) ? config.providers : []).filter(connected).map(providerOf)
    .filter((p: CatalogProvider) => p.models.length > 0);
  const c: Catalog = { providers, t3Default: null };
  const sel = config.settings?.defaultModelSelection;
  let t3Default: ModelChoice | null = null;
  if (sel && typeof sel.instanceId === 'string' && typeof sel.model === 'string') {
    const m = providers.find((p: CatalogProvider) => p.id === sel.instanceId)?.models.find((x: CatalogModel) => x.id === sel.model);
    const effort = (Array.isArray(sel.options) ? sel.options : []).find((o: any) => o?.id === m?.effortOption)?.value ?? null;
    t3Default = usable({ provider: sel.instanceId, model: sel.model, effort }, c);
  }
  if (!t3Default && providers[0]) {
    const m = defaultModelOf(providers[0])!;
    t3Default = { provider: providers[0].id, model: m.id, effort: m.defaultEffort };
  }
  return { providers, t3Default };
}
