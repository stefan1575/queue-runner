// The window: a sidebar (the repo switcher, a footer row with Settings and Setup) beside the main
// area, which stays empty until later tickets fill it. Settings and Setup open as pop-ups over
// the page. Setup opens by itself on the first start (#162). The page's address can open either:
// `#settings=<page>`, `#q=<search>` or `#setup` (the screenshots use it).
import { useEffect, useRef, useState } from 'react';
import { PAGES, type PageId } from '../../src/settings-search.ts';
import { runner, useView } from './runner.ts';
import { Settings } from './Settings.tsx';
import { Setup } from './Setup.tsx';
import { Sidebar } from './Sidebar.tsx';

export type Open = { page: PageId; query: string } | null;

function fromAddress(): Open {
  const p = new URLSearchParams(location.hash.slice(1));
  const page = PAGES.find((x) => x.id === p.get('settings'))?.id;
  const query = p.get('q') ?? '';
  return page || query ? { page: page ?? 'name', query } : null;
}

const setupInAddress = () => new URLSearchParams(location.hash.slice(1)).has('setup');

export function App() {
  const view = useView();
  const [open, setOpen] = useState<Open>(fromAddress);
  const [setup, setSetup] = useState(setupInAddress);
  // The first start opens Setup, once: it's seen from then on, and later opened from the sidebar.
  const firstLook = useRef(false);
  useEffect(() => {
    if (!view || firstLook.current) return;
    firstLook.current = true;
    if (!view.settings.setupSeen) {
      setSetup(true);
      void runner().set({ setupSeen: true }).catch(() => {});
    }
  }, [view]);
  useEffect(() => {
    const follow = () => { setOpen(fromAddress()); setSetup(setupInAddress()); };
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);
  return (
    <div className="flex h-full">
      <aside className="flex w-[272px] shrink-0 flex-col border-r border-line bg-side">
        <Sidebar onSettings={() => setOpen({ page: 'name', query: '' })} settingsOpen={!!open} repos={view?.repos ?? null}
          onSetup={() => setSetup(true)} setupOpen={setup} view={view} />
      </aside>
      <main className="min-w-0 flex-1" aria-label="Main" />
      {open && view && <Settings view={view} open={open} onOpen={setOpen} onClose={() => setOpen(null)} />}
      {setup && !open && view && <Setup view={view} onClose={() => setSetup(false)} />}
    </div>
  );
}
