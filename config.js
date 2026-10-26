/* Napojenie na Supabase. Sem patrí iba Project URL a publishable (anon) kľúč –
   oba sú verejné, dáta chránia pravidlá v databáze (každý vidí len svoje).
   Secret / service_role kľúč sem NIKDY nepatrí. */
window.BRAIN_CONFIG = {
  url: "https://XXXX.supabase.co",
  key: "VLOZ_PUBLISHABLE_KEY"
};
