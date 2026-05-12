import React, { createContext, useContext, useEffect, useState } from "react";
import { createClient, SupabaseClient, User } from "@supabase/supabase-js";

const DEFAULT_SUPABASE_URL = "https://beglgkjaejuvhqhddqfh.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlZ2xna2phZWp1dmhxaGRkcWZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1Nzc4MjcsImV4cCI6MjA5NDE1MzgyN30.lMYsJ6LdQlWDF4GvzimoXkJqhR8vg7A5zdNgtpLAm3Y";

interface SupabaseContextType {
  supabase: SupabaseClient | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const SupabaseContext = createContext<SupabaseContextType>({
  supabase: null,
  user: null,
  loading: true,
  signIn: async () => ({ error: null }),
  signUp: async () => ({ error: null }),
  signOut: async () => {},
});

export const SupabaseProvider = ({ children }: { children: React.ReactNode }) => {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

    const client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
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
  }, []);

  const signIn = async (email: string, password: string) => {
    if (!supabase) return { error: new Error("Supabase not initialized") };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  const signUp = async (email: string, password: string) => {
    if (!supabase) return { error: new Error("Supabase not initialized") };
    const { error } = await supabase.auth.signUp({ email, password });
    return { error };
  };

  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
  };

  return (
    <SupabaseContext.Provider value={{ supabase, user, loading, signIn, signUp, signOut }}>
      {children}
    </SupabaseContext.Provider>
  );
};

export const useSupabase = () => useContext(SupabaseContext);
