// ===================== CONFIG =====================
// 1) Supabase: Project Settings → API (or "Connect") → copy the Project URL and the anon / publishable key.
//    Leave them empty ("") to run in DEMO mode (data saved only on this device/browser).
export const SUPABASE_URL = "https://xdtvvxuboxoqebfetsuh.supabase.co";        // e.g. "https://abcdefgh.supabase.co"
export const SUPABASE_ANON_KEY = "sb_publishable_50O53luaI2X4LIzB8w_93w_eM1EesWi";   // e.g. "eyJhbGciOi..."  (the PUBLIC anon key, never the service_role key)

// 2) Admin email(s). Put the same email in supabase.sql (function is_admin).
export const ADMIN_EMAILS = ["maatouksemaan@gmail.com"];

// 3) Push notifications for the admin (optional): the PUBLIC VAPID key (see README → Notifications).
export const VAPID_PUBLIC_KEY = "BAhznv-dDt7LEMaAkE8H7XNRjfGrY4sJd-Rmh1iTjxKyvgiOVlfJBQaJdHZDHduIhQuQCNy03N2WmSWuuA4s73A";

// 4) Site name shown in the header
export const SITE_NAME = "Lucky Wheel";
