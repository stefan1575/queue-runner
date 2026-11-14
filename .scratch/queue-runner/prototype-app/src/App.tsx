// PROTOTYPE (throwaway): the queue runner's dashboard on fake data. Nothing here reads or writes
// the runner, GitHub or T3. Question: does this navigation and state model work for Stefan?
import { useEffect } from "react";
import { Toaster } from "sonner";
import { Shell } from "./components/Shell";
import { PrototypeBar } from "./components/PrototypeBar";
import { Overview } from "./pages/Overview";
import { NeedsYou } from "./pages/NeedsYou";
import { Queue } from "./pages/Queue";
import { PrDetail } from "./pages/PrDetail";
import { Activity } from "./pages/Activity";
import { Usage } from "./pages/Usage";
import { Settings } from "./pages/Settings";
import { A } from "./components/ui";
import { StoreProvider, useScoped, useStore } from "./store";

function Routes() {
  const { path, world, repo } = useStore();
  const { asks } = useScoped();
  const scope = repo ?? "all repositories";

  useEffect(() => {
    document.title = `${world.asks.length ? `(${world.asks.length}) ` : ""}Queue runner`;
  }, [world.asks.length]);

  const pr = path.match(/^\/pr\/([^/]+)\/(\d+)/);
  if (pr) {
    const p = world.prs.find((x) => x.repo === pr[1] && x.n === Number(pr[2]));
    return (
      <Shell
        crumb={<><A to="/queue" className="hover:text-ink">Queue</A> <span className="text-faint">/</span> {pr[1]}</>}
        title={<>{p?.title ?? "Pull request"} <span className="font-normal text-mute">#{pr[2]}</span></>}
      >
        <PrDetail repo={pr[1]} n={Number(pr[2])} />
      </Shell>
    );
  }
  switch (path) {
    case "/needs-you":
      return <Shell title="Needs you" subtitle={`Only what the runner can't do without you, in ${scope}. ${asks.length ? `${asks.length} open.` : ""}`}><NeedsYou /></Shell>;
    case "/queue":
      return <Shell title="Queue" subtitle="What the Claude lane does next, then every issue the runner can see and why it's where it is."><Queue /></Shell>;
    case "/activity":
      return <Shell title="Activity" subtitle="Every job, review, merge and stop, newest first."><Activity /></Shell>;
    case "/usage":
      return <Shell title="Usage" subtitle="Claude's windows as the gate reads them before each job. Account-wide, whatever repo you're looking at."><Usage /></Shell>;
    case "/settings":
      return <Shell title="Settings" subtitle="What the runner reads before each job. Changes apply from the next job; a running one keeps going."><Settings /></Shell>;
    default:
      return <Shell title="Overview" subtitle={repo ? `${repo}. The two lanes serve every repository.` : undefined}><Overview /></Shell>;
  }
}

export function App() {
  return (
    <StoreProvider>
      <Routes />
      <PrototypeBar />
      <Toaster position="top-right" toastOptions={{ style: { fontFamily: "var(--font-sans)" } }} />
    </StoreProvider>
  );
}
