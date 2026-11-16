// PROTOTYPE (throwaway): three layouts of the Settings page on the existing /settings route,
// switched by ?variant=A|B|C (and ?data=new for a new install). The content is #36's decision; the
// question is only how it's laid out. State is shared and in memory (state.ts); the floating bar
// switches layout and data set and shows what the runner would store.
//
//   A  one long page of stacked sections
//   B  categories on the left that stay put, every section on one scrolling page, with search
//      (picked by Stefan on 2026-11-16; reworked from his feedback)
//   C  the settings written as plain sentences with the choices inline
//
// Three rounds are kept side by side, switched from the bar or with the 1, 2 and 3 keys:
//   ?round=1  every layout as first shown
//   ?round=2  after Stefan's first feedback (B became one scrolling page)
//   default   round 3: B remade as a copy of T3 Code's own settings (A and C are as in round 2)
import { useUrl } from "@/lib/router";
import { PrototypeBar } from "./PrototypeBar";
import { VariantA as A1 } from "./round1/VariantA";
import { VariantB as B1 } from "./round1/VariantB";
import { VariantC as C1 } from "./round1/VariantC";
import { VariantB as B2 } from "./round2/VariantB";
import { useSettings } from "./state";
import { VariantA, name as nameA } from "./VariantA";
import { VariantB, name as nameB } from "./VariantB";
import { VariantC, name as nameC } from "./VariantC";

const VARIANTS = [
  { key: "A", name: nameA, views: [A1, VariantA, VariantA] },
  { key: "B", name: nameB, views: [B1, B2, VariantB] },
  { key: "C", name: nameC, views: [C1, VariantC, VariantC] },
];

export function SettingsPrototype() {
  const { params } = useUrl();
  const st = useSettings();
  const current = VARIANTS.find((v) => v.key === (params.get("variant") ?? "A").toUpperCase()) ?? VARIANTS[0];
  const r = params.get("round");
  const round = r === "1" ? 1 : r === "2" ? 2 : 3;
  const View = current.views[round - 1];
  return (
    <>
      {/* Room at the bottom so the bar never covers the last setting. */}
      <div className="pb-28"><View st={st} /></div>
      <PrototypeBar variants={VARIANTS} current={current} round={round} st={st} />
    </>
  );
}
