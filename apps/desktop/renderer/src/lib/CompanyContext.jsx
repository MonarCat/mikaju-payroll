import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const CompanyContext = createContext(null);

export function CompanyProvider({ children }) {
  const [company, setCompany] = useState(undefined); // undefined = loading, null = none yet
  const [entitlement, setEntitlement] = useState(null);

  const refresh = useCallback(async () => {
    const [c, e, countries] = await Promise.all([
      window.mikaju.companies.get(),
      window.mikaju.license.getEntitlement(),
      window.mikaju.countries.list(),
    ]);
    // currency_hint is derived, not stored on the row — the country list is
    // the single source of truth for country → currency (see tax-engine
    // COUNTRIES), so we don't duplicate that mapping in SQLite.
    const enriched = c ? { ...c, currency_hint: countries.find((x) => x.code === c.country_code)?.currency } : c;
    setCompany(enriched);
    setEntitlement(e);
    if (c) await window.mikaju.sync.setActiveCompany(c.id);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <CompanyContext.Provider value={{ company, entitlement, refresh }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error('useCompany must be used inside <CompanyProvider>');
  return ctx;
}
