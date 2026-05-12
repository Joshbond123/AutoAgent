import React, { createContext, useContext, useEffect, useState } from "react";
import { createClient, SupabaseClient, User } from "@supabase/supabase-js";

const SupabaseContext = createContext<{
  supabase: SupabaseClient | null;
  user: User | null;
  loading: boolean;
}>({
  supabase: null,
  user: null,
  loading: true,
});

export const SupabaseProvider = ({ children }: { children: React.ReactNode }) => {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // @ts-ignore
    const url = import.meta.env.VITE_SUPABASE_URL || "";
    // @ts-ignore
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
    
    if (url && key) {
      const client = createClient(url, key);
      setSupabase(client);

      client.auth.getUser().then(({ data: { user } }) => {
        setUser(user);
        setLoading(false);
      });

      const { data: { subscription } } = client.auth.onAuthStateChange((_, session) => {
        setUser(session?.user ?? null);
        setLoading(false);
      });

      return () => subscription.unsubscribe();
    } else {
      setLoading(false);
    }
  }, []);

  return (
    <SupabaseContext.Provider value={{ supabase, user, loading }}>
      {children}
    </SupabaseContext.Provider>
  );
};

export const useSupabase = () => useContext(SupabaseContext);
