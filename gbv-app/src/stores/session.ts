import { defineStore } from 'pinia';
import type { User } from '@supabase/supabase-js';
import type { Tournament } from '../types/db';

export type TournamentSummary = Pick<Tournament, 'id' | 'name' | 'date' | 'access_code' | 'status'>;

type SessionState = {
  adminUser: User | null;
  accessCode: string | null;
  initialized: boolean;
  tournament: Tournament | null;
};

const ACCESS_CODE_KEY = 'gbv.access_code';
const ADMIN_ACTIVE_TOURNAMENT_ID_KEY = 'gbv.admin_active_tournament_id';

export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    adminUser: null,
    accessCode: null,
    initialized: false,
    tournament: null,
  }),

  getters: {
    isAdminAuthenticated: (s) => !!s.adminUser,
    hasAccessCode: (s) => !!s.accessCode,
  },

  actions: {
    initFromStorage() {
      if (this.initialized) return;
      const code = typeof localStorage !== 'undefined' ? localStorage.getItem(ACCESS_CODE_KEY) : null;
      this.accessCode = code;
      this.initialized = true;
    },

    setAccessCode(code: string) {
      this.accessCode = code.trim();
      try {
        localStorage.setItem(ACCESS_CODE_KEY, this.accessCode);
      } catch {
        // Non-critical in SSR or restricted storage environments
      }
    },

    clearAccessCode() {
      this.accessCode = null;
      this.tournament = null;
      try {
        localStorage.removeItem(ACCESS_CODE_KEY);
      } catch {
        // ignore
      }
    },

    getAdminActiveTournamentId(): string | null {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(ADMIN_ACTIVE_TOURNAMENT_ID_KEY);
    },

    /** Persist which tournament the admin is working on (dashboard + tools). */
    setAdminActiveTournamentId(id: string | null) {
      try {
        if (id) localStorage.setItem(ADMIN_ACTIVE_TOURNAMENT_ID_KEY, id);
        else localStorage.removeItem(ADMIN_ACTIVE_TOURNAMENT_ID_KEY);
      } catch {
        // ignore
      }
    },

    /** Set active admin tournament context (RLS: must be owned by current admin). */
    setAdminActiveTournament(t: Tournament) {
      this.tournament = t;
      this.setAdminActiveTournamentId(t.id);
      this.setAccessCode(t.access_code);
    },

    /**
     * Clear admin working tournament. Optionally clear stored public access code
     * (e.g. after deleting that tournament so fans are not sent to a removed event).
     */
    clearAdminActiveTournament(opts?: { clearPublicAccessCode?: boolean }) {
      this.tournament = null;
      this.setAdminActiveTournamentId(null);
      if (opts?.clearPublicAccessCode) {
        this.accessCode = null;
        try {
          localStorage.removeItem(ACCESS_CODE_KEY);
        } catch {
          // ignore
        }
      }
    },

    async ensureAnon() {
      const { default: supabase } = await import('../lib/supabase');
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Attempt anonymous session so RLS policies with "authenticated" apply
        // If not enabled on your project, switch policies to allow anon or implement email magic link.
        try {
          // @ts-ignore - available in recent supabase-js
          await supabase.auth.signInAnonymously();
        } catch {
          // Fallback: no-op; reads still work with anon role
        }
      }
    },

    async loadTournamentByCode(code: string) {
      const { default: supabase } = await import('../lib/supabase');
      const { data, error } = await supabase
        .from('tournaments')
        .select('*')
        .eq('access_code', code)
        .single();

      if (error || !data) {
        this.tournament = null;
        return null;
      }
      this.tournament = data as Tournament;
      return this.tournament;
    },

    /** Load a tournament by id as the logged-in admin (email user). */
    async loadAdminTournamentById(id: string) {
      const { default: supabase } = await import('../lib/supabase');
      const { data, error } = await supabase.from('tournaments').select('*').eq('id', id).single();
      if (error || !data) {
        this.tournament = null;
        this.setAdminActiveTournamentId(null);
        return null;
      }
      const t = data as Tournament;
      this.setAdminActiveTournament(t);
      return t;
    },

    async listTournamentsByDate(date: string): Promise<TournamentSummary[]> {
      const { default: supabase } = await import('../lib/supabase');
      const { data, error } = await supabase
        .from('tournaments')
        .select('id,name,date,access_code,status')
        .eq('date', date)
        .order('name', { ascending: true });

      if (error || !data) return [];
      return data as TournamentSummary[];
    },

    async refreshAdminUser() {
      const { default: supabase } = await import('../lib/supabase');
      const { data } = await supabase.auth.getUser();
      this.adminUser = data.user ?? null;
      return this.adminUser;
    },

    async signInAdminWithEmail(email: string, password: string) {
      const { default: supabase } = await import('../lib/supabase');
      // Clear any anonymous session so the JWT is definitely the email user (RLS insert requires non-anonymous).
      await supabase.auth.signOut();
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      this.adminUser = data.user;
      return data.user;
    },

    async signOutAdmin() {
      const { default: supabase } = await import('../lib/supabase');
      await supabase.auth.signOut();
      this.adminUser = null;
      this.clearAdminActiveTournament();
    },
  },
});
