// The window: a sidebar (the repo switcher, a footer row with Settings) beside the main area,
// which stays empty until later tickets fill it. Settings opens as a pop-up over the page.
// The page's address can open it: `#settings=<page>` or `#q=<search>` (the screenshots use it).
import { useEffect, useState } from 'react';
import { PAGES, type PageId } from '../../src/settings-search.ts';
import { useView } from './runner.ts';
import { Settings } from './Settings.tsx';
import { Sidebar } from './Sidebar.tsx';

export type Open = { page: PageId; query: string } | null;

function fromAddress(): Open {
  const p = new URLSearchParams(location.hash.slice(1));
  const page = PAGES.find((x) => x.id === p.get('settings'))?.id;
  const query = p.get('q') ?? '';
  return page || query ? { page: page ?? 'name', query } : null;
}

export function App() {
  const view = useView();
  const [open, setOpen] = useState<Open>(fromAddress);
  useEffect(() => {
    const follow = () => setOpen(fromAddress());
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);
  return (
    <div className="flex h-full">
      <aside className="flex w-[272px] shrink-0 flex-col border-r border-line bg-side">
        <Sidebar onSettings={() => setOpen({ page: 'name', query: '' })} settingsOpen={!!open} />
      </aside>
      <main className="min-w-0 flex-1" aria-label="Main" />
      {open && view && <Settings view={view} open={open} onOpen={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}
