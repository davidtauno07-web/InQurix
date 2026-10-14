import { useEffect, useState } from 'react';
import { QuickSearch } from './QuickSearch';
import { Workspace } from './Workspace';

function parseHash(): { view: string; route: string } {
  const [view, ...rest] = window.location.hash.replace(/^#/, '').split('/');
  return { view: view || 'workspace', route: rest.join('/') };
}

export function App() {
  const [{ view, route }, setLoc] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setLoc(parseHash());
    window.addEventListener('hashchange', onHash);
    const off = window.inqurix.on('nav', (r) => setLoc({ view: 'workspace', route: String(r ?? '') }));
    return () => { window.removeEventListener('hashchange', onHash); off(); };
  }, []);
  return view === 'quick' ? <QuickSearch /> : <Workspace route={route} />;
}
