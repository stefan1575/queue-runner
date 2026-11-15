// The providers' marks, drawn by hand for the prototype (the real build would use the official SVGs).
// Brand colour lives here and on the provider's name, nowhere else.
import { cn } from "@/lib/cn";

export type Provider = "claude" | "chatgpt";

export function ClaudeMark({ className }: { className?: string }) {
  // Claude's spark: tapered rays around a centre.
  const rays = [0, 32, 61, 95, 128, 152, 184, 215, 243, 272, 304, 333];
  return (
    <svg viewBox="0 0 24 24" className={cn("text-claude", className)} aria-hidden>
      {rays.map((a, i) => (
        <path key={a} d={`M12 12 L${i % 2 ? 11.2 : 11} ${i % 3 ? 3.2 : 2} L12.9 ${i % 3 ? 3.4 : 2.2} Z`} fill="currentColor" transform={`rotate(${a} 12 12)`} strokeLinejoin="round" stroke="currentColor" strokeWidth="1.1" />
      ))}
    </svg>
  );
}

export function OpenAIMark({ className }: { className?: string }) {
  // OpenAI's knot, approximated: six rounded links turning around a hexagon.
  return (
    <svg viewBox="0 0 24 24" className={cn("text-openai", className)} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7">
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <rect key={a} x="9.2" y="2.6" width="5.6" height="11" rx="2.8" transform={`rotate(${a} 12 12)`} />
      ))}
    </svg>
  );
}

export const PROVIDER: Record<Provider, { name: string; Mark: typeof ClaudeMark; text: string; model: string }> = {
  claude: { name: "Claude", Mark: ClaudeMark, text: "text-claude", model: "Opus 5.5" },
  chatgpt: { name: "ChatGPT", Mark: OpenAIMark, text: "text-openai", model: "GPT-6.1 Sol" },
};

export function ProviderName({ p, className, mark = "size-[18px]" }: { p: Provider; className?: string; mark?: string }) {
  const { name, Mark, text } = PROVIDER[p];
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold", text, className)}>
      <Mark className={mark} />
      {name}
    </span>
  );
}
