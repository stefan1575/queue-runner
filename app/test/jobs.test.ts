// Which model does each kind of job (#152): Default gives every kind its provider, model and
// effort unless the kind names its own, the choices are the ones T3 has connected, and a new
// install follows T3's own default until it's chosen or kept.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEFAULT_JOBS, JOB_KINDS, kindModels, defaultModel, withProvider, withModel, checkJobs, type Jobs } from '../src/jobs.ts';
import { catalogFromConfig } from '../src/t3/catalog.ts';

const config = JSON.parse(readFileSync(new URL('./fixtures/server-config.json', import.meta.url), 'utf8')).config;
const catalog = catalogFromConfig(config);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const a = catalog.providers[0]!;
const b = catalog.providers[1]!;
const choice = (p: typeof a, m = p.models.at(-1)!, effort = m.efforts.at(-1)?.id ?? null) => ({ provider: p.id, model: m.id, effort });
const jobs = (part: Partial<Jobs>): Jobs => ({ ...DEFAULT_JOBS, ...part });

describe("T3's catalog", () => {
  test('lists only the providers T3 has connected, with their models and each model\'s efforts', () => {
    const connected = config.providers.filter((p: any) => p.enabled && p.status === 'ready');
    expect(ids(catalog.providers)).toEqual(connected.map((p: any) => p.instanceId));
    expect(config.providers.length).toBeGreaterThan(connected.length);
    const raw = connected[0].models[0];
    const model = catalog.providers[0]!.models[0]!;
    expect(model).toMatchObject({ id: raw.slug, label: raw.name });
    const option = raw.capabilities.optionDescriptors.find((o: any) => o.type === 'select' && o.label === 'Reasoning');
    expect(model.effortOption).toBe(option.id);
    expect(ids(model.efforts)).toEqual(option.options.map((o: any) => o.id));
  });

  test("each provider's effort option keeps the id its driver reads", () => {
    const options = new Set(catalog.providers.flatMap((p) => p.models.map((m) => m.effortOption)).filter(Boolean));
    expect(options.size).toBeGreaterThan(1);
  });

  test('a model with no effort to choose has none', () => {
    const plain = catalog.providers.flatMap((p) => p.models).find((m) => m.efforts.length === 0)!;
    expect(plain).toBeDefined();
    expect(plain.effortOption).toBeNull();
    expect(plain.defaultEffort).toBeNull();
  });

  test("T3's default is its default model selection when that's connected", () => {
    const m = b.models[1]!;
    const sel = { instanceId: b.id, model: m.id, options: [{ id: m.effortOption, value: m.efforts[0]!.id }] };
    const withDefault = catalogFromConfig({ ...config, settings: { defaultModelSelection: sel } });
    expect(withDefault.t3Default).toEqual({ provider: b.id, model: m.id, effort: m.efforts[0]!.id });
  });

  test("with no default model selection, T3's default is the first connected provider's default model at its default effort", () => {
    const m = a.models.find((x) => x.isDefault) ?? a.models[0]!;
    expect(catalog.t3Default).toEqual({ provider: a.id, model: m.id, effort: m.defaultEffort });
  });

  test('nothing connected is an empty catalog with no default', () => {
    expect(catalogFromConfig({ providers: [], settings: {} })).toEqual({ providers: [], t3Default: null });
  });
});

describe('the model each kind runs on', () => {
  test('the kinds', () => {
    expect(JOB_KINDS.map((k) => k.id)).toEqual(['build', 'fix', 'conflict', 'decision', 'review', 'ask']);
  });

  test("a new install follows T3's default for every kind", () => {
    expect(defaultModel(DEFAULT_JOBS, catalog)).toEqual({ choice: catalog.t3Default, followsT3: true });
    for (const k of JOB_KINDS) {
      expect(kindModels(DEFAULT_JOBS, k.id, catalog)).toEqual({ choice: catalog.t3Default, fallback: null, followsDefault: true });
    }
  });

  test('a kind with no settings of its own runs on Default; one with its own on those', () => {
    const def = choice(b), own = choice(a);
    const j = jobs({ default: def, review: { own, fallback: def } });
    expect(defaultModel(j, catalog)).toEqual({ choice: def, followsT3: false });
    expect(kindModels(j, 'build', catalog)).toEqual({ choice: def, fallback: null, followsDefault: true });
    expect(kindModels(j, 'review', catalog)).toEqual({ choice: own, fallback: def, followsDefault: false });
  });

  test("a choice whose provider isn't connected falls back to the next one up", () => {
    const gone = { provider: 'gone', model: 'x', effort: null };
    const j = jobs({ default: gone, fix: { own: gone, fallback: gone } });
    expect(defaultModel(j, catalog).choice).toEqual(catalog.t3Default);
    expect(kindModels(j, 'fix', catalog)).toEqual({ choice: catalog.t3Default, fallback: null, followsDefault: false });
  });

  test("an effort the model doesn't offer is the model's default", () => {
    const m = a.models.find((x) => x.efforts.length)!;
    const j = jobs({ default: { provider: a.id, model: m.id, effort: 'not-an-effort' } });
    expect(defaultModel(j, catalog).choice).toEqual({ provider: a.id, model: m.id, effort: m.defaultEffort });
  });

  test('with one provider connected, every kind offers and runs on only that one', () => {
    const one = catalogFromConfig({ ...config, providers: config.providers.filter((p: any) => p.instanceId === b.id) });
    expect(ids(one.providers)).toEqual([b.id]);
    const j = jobs({ default: choice(a), build: { own: choice(a), fallback: choice(a) } });
    for (const k of JOB_KINDS) expect(kindModels(j, k.id, one).choice?.provider).toBe(b.id);
    expect(kindModels(j, 'build', one).fallback).toBeNull();
  });
});

describe('choosing', () => {
  test("a new provider takes its default model and keeps the effort when that model offers it", () => {
    const from = { provider: a.id, model: a.models[0]!.id, effort: a.models[0]!.efforts[0]?.id ?? null };
    const to = withProvider(from, b.id, catalog);
    const m = b.models.find((x) => x.isDefault) ?? b.models[0]!;
    expect(to.provider).toBe(b.id);
    expect(to.model).toBe(m.id);
    expect(to.effort).toBe(ids(m.efforts).includes(from.effort!) ? from.effort : m.defaultEffort);
  });

  test("a new model keeps the effort it offers, else takes its default", () => {
    const p = catalog.providers.find((x) => x.models.some((m) => m.efforts.length === 0))!;
    const plain = p.models.find((m) => m.efforts.length === 0)!;
    const from = { provider: p.id, model: p.models[0]!.id, effort: p.models[0]!.efforts.at(-1)!.id };
    expect(withModel(from, plain.id, catalog)).toEqual({ provider: p.id, model: plain.id, effort: null });
    expect(withModel(from, p.models[1]!.id, catalog).effort).toBe(from.effort);
  });
});

describe('the jobs setting', () => {
  test('keeps well-formed choices and refuses anything else', () => {
    const def = { provider: 'p', model: 'm', effort: 'e' };
    expect(checkJobs({ ...DEFAULT_JOBS, default: def, ask: { own: null, fallback: { ...def, effort: null } } }))
      .toEqual({ ...DEFAULT_JOBS, default: def, ask: { own: null, fallback: { ...def, effort: null } } });
    expect(checkJobs({ ...DEFAULT_JOBS, default: { provider: 'p' } })).toBeUndefined();
    expect(checkJobs({ ...DEFAULT_JOBS, live: { own: null, fallback: null } })).toBeUndefined();
    expect(checkJobs('x')).toBeUndefined();
  });

  test('a saved file missing a kind keeps the rest and gives that one none of its own', () => {
    const def = { provider: 'p', model: 'm', effort: 'e' };
    expect(checkJobs({ default: def, review: { own: def, fallback: null } }))
      .toEqual({ ...DEFAULT_JOBS, default: def, review: { own: def, fallback: null } });
  });
});
