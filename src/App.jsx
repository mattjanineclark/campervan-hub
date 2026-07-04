/**
 * Adventure Hub — Family Campervan Booking & Trip Planning App
 * ─────────────────────────────────────────────────────────────
 * Stack:     React 18 + Vite, single-file JSX
 * Database:  Supabase (Postgres + Realtime)
 * Maps:      Leaflet.js via CDN
 * Deploy:    GitHub Pages via GitHub Actions
 *
 * Architecture:
 *   - All state managed by useReducer (reducer function)
 *   - sbDispatch wraps dispatch to also persist changes to Supabase
 *   - Single App.jsx file — all components defined at top level
 *   - T = theme object, mutated by applyTheme() for dark/light mode
 *
 * Families: f1=Steve&Lyn, f2=Em&Dave, f3=Matt&Janine, f4=Jonny&Steph, f5=Sophie
 * Version:  v2.1
 */
import React, { useState, useReducer, useRef, useEffect, useCallback } from "react";

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────────
// Supabase config — works both in Vite (import.meta.env) and plain browser
const SUPABASE_URL = "https://jlnwuzgcubfzrwxlwfkn.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impsbnd1emdjdWJmenJ3eGx3ZmtuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4OTQ1MzUsImV4cCI6MjA5ODQ3MDUzNX0.Ord113mzsfyYQw2RTKMBnw80wWO9I_jkwwJFAqxXnEs";

// Log config on load to help debug
if (!SUPABASE_KEY) console.error("⚠️ SUPABASE_KEY is empty — check GitHub secrets are named VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY");
else console.log("✓ Supabase configured:", SUPABASE_URL);

const supa = {
  get: async (table, query = "") => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }
    });
    if (!res.ok) { console.error("Supabase GET " + table + " failed:", res.status); return []; }
    return res.json();
  },
  insert: async (table, data) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(data)
    });
    return res.json();
  },
  update: async (table, data, match) => {
    const q = Object.entries(match).map(([k, v]) => k + "=eq." + v).join("&");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(data)
    });
    return res.json();
  },
  upsert: async (table, data) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(data)
    });
    return res.json();
  },
  delete: async (table, match) => {
    const q = Object.entries(match).map(([k, v]) => k + "=eq." + v).join("&");
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
  },
  uploadImage: async (file, path) => {
    const formData = new FormData();
    formData.append("", file);
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/app-images/${path}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      body: formData
    });
    if (!res.ok) {
      const res2 = await fetch(`${SUPABASE_URL}/storage/v1/object/app-images/${path}`, {
        method: "PUT",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        body: formData
      });
      if (!res2.ok) throw new Error("Upload failed");
    }
    return `${SUPABASE_URL}/storage/v1/object/public/app-images/${path}`;
  },
  deleteImage: async (path) => {
    await fetch(`${SUPABASE_URL}/storage/v1/object/app-images/${path}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
  },
  subscribe: (table, callback) => {
    // Supabase realtime via WebSocket
    const wsUrl = SUPABASE_URL.replace("https://", "wss://") + "/realtime/v1/websocket?apikey=" + SUPABASE_KEY + "&vsn=1.0.0";
    const ws = new WebSocket(wsUrl);
    const topic = `realtime:public:${table}`;
    ws.onopen = () => {
      ws.send(JSON.stringify({ topic, event: "phx_join", payload: {}, ref: "1" }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.topic === topic && msg.event === "INSERT" || msg.event === "UPDATE" || msg.event === "DELETE") {
        callback(msg.event, msg.payload?.record, msg.payload?.old_record);
      }
    };
    return () => ws.close();
  }
};

// Convert DB row format to app format and back
const fromDB = {
  booking: b => b ? ({ id: b.id, familyId: b.family_id, start: b.start_date, end: b.end_date, destination: b.destination, notes: b.notes || "", status: b.status, days: b.days || [], collaborators: b.collaborators || [], guests: b.guests || "", guestName: b.guest_name || "", guestPin: b.guest_pin || "" }) : null,
  place: p => p ? ({ id: p.id, name: p.name, familyId: p.family_id, category: p.category, lat: p.lat, lng: p.lng, overallRating: p.overall_rating || 0, reviews: [] }) : null,
  review: r => r ? ({ familyId: r.family_id, rating: r.rating, text: r.review_text, date: r.review_date }) : null,
  itin: i => i ? ({ id: i.id, title: i.title, familyId: i.family_id, start: i.start_date || "", end: i.end_date || "", destination: i.destination || "", notes: i.notes || "", bookingId: i.booking_id || "", visibility: "private", days: i.days || [] }) : null,
  family: f => f ? ({ id: f.id, name: f.name, color: f.color, emoji: f.emoji, pin: f.pin, photo: f.photo || null }) : null,
  equip: e => e ? ({ id: e.id, category: e.category, item: e.item, status: e.status || "invan" }) : null,
  packing: p => p ? ({ id: p.id, category: p.category, item: p.item, status: p.status || "tobring" }) : null,
  guide: g => g ? ({ id: g.id, title: g.title, icon: g.icon, content: g.content || "", links: g.links || [], attachments: g.attachments || [] }) : null,
  rule: r => r ? ({ id: r.id, icon: r.icon, rule: r.rule, detail: r.detail || "" }) : null,
};
const toDB = {
  booking: b => ({ id: b.id, family_id: b.familyId, start_date: b.start, end_date: b.end, destination: b.destination, notes: b.notes, status: b.status, days: b.days || [], collaborators: b.collaborators || [], guests: b.guests || "", guest_name: b.guestName || "", guest_pin: b.guestPin || "" }),
  place: p => ({ id: p.id, name: p.name, family_id: p.familyId, category: p.category, lat: p.lat, lng: p.lng, overall_rating: p.overallRating || 0 }),
  review: (placeId, r) => ({ place_id: placeId, family_id: r.familyId, rating: r.rating, review_text: r.text, review_date: r.date }),
  itin: i => ({ id: i.id, title: i.title, family_id: i.familyId, start_date: i.start || null, end_date: i.end || null, destination: i.destination || "", notes: i.notes || "", booking_id: i.bookingId || null, visibility: i.visibility || "private", days: i.days || [] }),
  family: f => ({ id: f.id, name: f.name, color: f.color, emoji: f.emoji, pin: f.pin, photo: f.photo || null }),
  equip: e => ({ id: e.id, category: e.category, item: e.item, status: e.status }),
  packing: (familyId, p) => ({ id: p.id, family_id: familyId, category: p.category, item: p.item, status: p.status }),
  guide: g => ({ id: g.id, title: g.title, icon: g.icon, content: g.content || "", links: g.links || [], attachments: g.attachments || [] }),
  rule: r => ({ id: r.id, icon: r.icon, rule: r.rule, detail: r.detail || "" }),
};

// ─── THEMES ───────────────────────────────────────────────────────────────────
const LIGHT_THEME = {
  bg: "#f0f4f0", surface: "#ffffff", card: "#ffffff", cardHover: "#f7faf7",
  border: "#d4e0d0", borderLight: "#e5ede5",
  primary: "#2d6a4f", primaryDark: "#1b4332", primaryLight: "#52b788", primaryGlow: "rgba(45,106,79,0.1)",
  accent: "#e07a28", accentGlow: "rgba(224,122,40,0.1)",
  sky: "#4a90c4", skyGlow: "rgba(74,144,196,0.1)",
  sand: "#c9a96e", green: "#40916c", green2: "#40916c",
  yellow: "#e9c46a", red: "#c1440e",
  text: "#1a2e1a", textMuted: "#4a6741", textDim: "#8aab82",
  radius: "12px", radiusSm: "8px",
  shadow: "0 2px 16px rgba(45,106,79,0.08)",
  shadowMd: "0 4px 24px rgba(45,106,79,0.12)",
  shadowLg: "0 8px 40px rgba(45,106,79,0.18)",
  inputBg: "#f8faf8", overlay: "rgba(26,46,26,0.4)",
};
const DARK_THEME = {
  bg: "#14161a", surface: "#1c1f24", card: "#1c1f24", cardHover: "#24282f",
  border: "#2e333b", borderLight: "#282c33",
  primary: "#52b788", primaryDark: "#2d6a4f", primaryLight: "#95d5b2", primaryGlow: "rgba(82,183,136,0.15)",
  accent: "#f4954a", accentGlow: "rgba(244,149,74,0.15)",
  sky: "#6fb1e0", skyGlow: "rgba(111,177,224,0.15)",
  sand: "#d9bd8c", green: "#57b98d", green2: "#57b98d",
  yellow: "#f0d27f", red: "#e0672f",
  text: "#eef0f2", textMuted: "#a3aab3", textDim: "#63696f",
  radius: "12px", radiusSm: "8px",
  shadow: "0 2px 16px rgba(0,0,0,0.35)",
  shadowMd: "0 4px 24px rgba(0,0,0,0.45)",
  shadowLg: "0 8px 40px rgba(0,0,0,0.6)",
  inputBg: "#24282f", overlay: "rgba(0,0,0,0.55)",
};
const T = { ...LIGHT_THEME };
function applyTheme(mode) {
  Object.assign(T, mode === "dark" ? DARK_THEME : LIGHT_THEME);
  try { localStorage.setItem("theme-mode", mode); } catch (e) { }
}

// ─── FAMILIES ─────────────────────────────────────────────────────────────────
const ADMIN_PIN = "9999"; // Admin passcode required to remove a family

const DEFAULT_FAMILIES = [
  { id: "f1", name: "Steve & Lyn", color: "#2d6a4f", emoji: "🏔️", pin: "0000", homeTab: "calendar" },
  { id: "f2", name: "Em & Dave", color: "#e07a28", emoji: "🌊", pin: "0000", homeTab: "calendar" },
  { id: "f3", name: "Matt & Janine", color: "#4a90c4", emoji: "🌿", pin: "0000", homeTab: "calendar" },
  { id: "f4", name: "Jonny & Steph", color: "#c9a96e", emoji: "🦅", pin: "0000", homeTab: "calendar" },
  { id: "f5", name: "Sophie", color: "#e2619f", emoji: "🦋", pin: "0000", homeTab: "calendar" },
  { id: "maintenance", name: "Maintenance", color: "#888888", emoji: "🔧", pin: "9999" },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const TODAY = new Date();
// Generate day-by-day structure between two date strings
/** Generates a day-by-day array between two ISO date strings (e.g. "2026-07-01"). */
const generateDays = (start, end) => {
  if (!start || !end) return [];
  const days = [];
  const s = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    days.push({ date: fmt(new Date(d)), activities: [] });
  }
  return days;
};

/** Formats a Date object to "YYYY-MM-DD" string using local timezone (avoids NZ UTC offset bug). */
const fmt = d => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0"); return `${y}-${m}-${dd}`; };
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const nights = (s, e) => Math.max(0, Math.round((new Date(e) - new Date(s)) / 86400000));
/** Returns true if two booking objects overlap in dates. */
const overlap = (a, b) => new Date(a.start) < new Date(b.end) && new Date(a.end) > new Date(b.start);

// ─── SEED DATA ────────────────────────────────────────────────────────────────
const SEED_BOOKINGS = [
  { id: "b1", familyId: "f1", start: fmt(addDays(TODAY, 5)), end: fmt(addDays(TODAY, 16)), destination: "Blue Lake Campsite", notes: "School holidays", status: "confirmed" },
  { id: "b2", familyId: "f3", start: fmt(addDays(TODAY, 20)), end: fmt(addDays(TODAY, 27)), destination: "Coastal Cove Reserve", notes: "Anniversary", status: "tentative" },
  { id: "b3", familyId: "f2", start: fmt(addDays(TODAY, 38)), end: fmt(addDays(TODAY, 52)), destination: "Mountain Pass Retreat", notes: "Summer trip", status: "confirmed" },
];
const SEED_PLACES = [
  { id: "p1", name: "Blue Lake Campsite", familyId: "f1", overallRating: 5, reviews: [{ familyId: "f1", rating: 5, text: "Stunning reflections, great fishing, kids loved the kayaks!", date: "2024-01-10" }], lat: -36.85, lng: 174.76, category: "Campsite" },
  { id: "p2", name: "Coastal Cove Reserve", familyId: "f3", overallRating: 4, reviews: [{ familyId: "f3", rating: 4, text: "Secluded beach, bit windy but beautiful sunsets.", date: "2024-02-20" }], lat: -36.40, lng: 175.68, category: "Beach" },
  { id: "p3", name: "Mountain Pass Retreat", familyId: "f2", overallRating: 5, reviews: [{ familyId: "f2", rating: 5, text: "Epic hikes, great facilities. Book early!", date: "2024-03-05" }], lat: -39.13, lng: 175.63, category: "Mountain" },
  { id: "p4", name: "Riverside Holiday Park", familyId: "f4", overallRating: 3, reviews: [{ familyId: "f4", rating: 3, text: "Nice enough, a bit crowded. Good stopover.", date: "2024-04-15" }], lat: -37.78, lng: 175.28, category: "Holiday Park" },
];
const SEED_EQUIPMENT = [
  { id: "e1", category: "Sleeping", item: "Queen bed + linen", status: "invan" }, { id: "e2", category: "Sleeping", item: "Extra blankets x2", status: "invan" },
  { id: "e3", category: "Kitchen", item: "2-burner gas cooktop", status: "invan" }, { id: "e4", category: "Kitchen", item: "12V fridge/freezer", status: "invan" },
  { id: "e5", category: "Kitchen", item: "Portable BBQ", status: "invan" }, { id: "e6", category: "Kitchen", item: "Fold-out dining table", status: "invan" },
  { id: "e7", category: "Power", item: "Solar panel (200W)", status: "invan" }, { id: "e8", category: "Power", item: "Inverter (1000W)", status: "invan" },
  { id: "e9", category: "Power", item: "USB-C charging x4", status: "invan" },
  { id: "e10", category: "Water", item: "Fresh water tank (80L)", status: "invan" }, { id: "e11", category: "Water", item: "Grey water tank", status: "invan" },
  { id: "e12", category: "Sanitation", item: "Portable toilet", status: "invan" },
  { id: "e13", category: "Outdoor", item: "Camp chairs x4", status: "invan" }, { id: "e14", category: "Outdoor", item: "Camp table", status: "invan" }, { id: "e15", category: "Outdoor", item: "Awning", status: "invan" },
  { id: "e16", category: "Safety", item: "First aid kit", status: "invan" }, { id: "e17", category: "Safety", item: "Fire extinguisher", status: "invan" },
  { id: "e18", category: "Safety", item: "Jumper cables", status: "invan" }, { id: "e19", category: "Safety", item: "Tool kit", status: "invan" },
  { id: "e20", category: "Safety", item: "Levelling ramps", status: "invan" }, { id: "e21", category: "Safety", item: "Torch + batteries", status: "invan" },
  { id: "e22", category: "Bedding", item: "Pillows", status: "tobring" }, { id: "e23", category: "Bedding", item: "Sleeping bag", status: "tobring" }, { id: "e24", category: "Bedding", item: "Eye masks", status: "tobring" },
  { id: "e25", category: "Kitchen", item: "Cooking oil", status: "tobring" }, { id: "e26", category: "Kitchen", item: "Spices", status: "tobring" }, { id: "e27", category: "Kitchen", item: "Snacks", status: "tobring" }, { id: "e28", category: "Kitchen", item: "Coffee/tea", status: "tobring" }, { id: "e29", category: "Kitchen", item: "Water bottles", status: "tobring" }, { id: "e30", category: "Kitchen", item: "Rubbish bags", status: "tobring" },
  { id: "e31", category: "Hygiene", item: "Towels", status: "tobring" }, { id: "e32", category: "Hygiene", item: "Toiletries", status: "tobring" }, { id: "e33", category: "Hygiene", item: "Toilet paper", status: "tobring" }, { id: "e34", category: "Hygiene", item: "Hand sanitiser", status: "tobring" },
  { id: "e35", category: "Outdoors", item: "Hiking boots", status: "tobring" }, { id: "e36", category: "Outdoors", item: "Raincoats", status: "tobring" }, { id: "e37", category: "Outdoors", item: "Sunscreen & hats", status: "tobring" }, { id: "e38", category: "Outdoors", item: "Insect repellent", status: "tobring" },
  { id: "e39", category: "Kids", item: "Toys/games", status: "tobring" }, { id: "e40", category: "Kids", item: "Beach gear", status: "tobring" }, { id: "e41", category: "Kids", item: "Colouring books", status: "tobring" },
  { id: "e42", category: "Safety", item: "Medications", status: "tobring" }, { id: "e43", category: "Safety", item: "ID copies", status: "tobring" }, { id: "e44", category: "Safety", item: "Cash", status: "tobring" },
];
const SEED_GUIDES = [
  { id: "g1", title: "Starting the Engine", icon: "🔑", content: "1. Ensure handbrake is on.\n2. Wait for glow plug light to go out.\n3. Turn key fully to start.\n\nNever leave engine running in enclosed spaces.", attachments: [], links: [] },
  { id: "g2", title: "Mains Power (240V)", icon: "🔌", content: "1. Plug campsite end first, then van inlet.\n2. Flip the RCD breaker inside.\n3. To disconnect: flip breaker off first.\n\nNever leave cable coiled when in use.", attachments: [], links: [] },
  { id: "g3", title: "Fresh Water System", icon: "💧", content: "1. Fill via external cap (WATER, right rear).\n2. Turn water pump switch on inside.\n3. Run tap until air clears.\n4. Empty grey tank at dump stations.", attachments: [], links: [] },
  { id: "g4", title: "Gas Cooktop Safety", icon: "🔥", content: "1. Open windows and roof vent before lighting.\n2. Turn knob to max, press and hold, click igniter.\n3. Hold 5 seconds after flame lights.\n4. Turn gas off at bottle when done.\n\nSmell gas? Step outside immediately.", attachments: [], links: [] },
  { id: "g5", title: "Toilet Cassette", icon: "🚽", content: "1. Close blade valve inside toilet.\n2. Access cassette from external hatch.\n3. Take to dump station, rinse, add chemical tablet, reinsert.", attachments: [], links: [] },
  { id: "g6", title: "Solar & Battery", icon: "☀️", content: "1. Keep battery above 50%.\n2. Solar charges automatically in daylight.\n3. Run engine 30+ mins to charge if needed.\n4. Below 20% -- connect to mains ASAP.", attachments: [], links: [] },
];
const SEED_RULES = [
  { id: "r1", icon: "⏱️", rule: "Advance booking", detail: "Book up to 6 months ahead." },
  { id: "r2", icon: "🔁", rule: "Peak season rotation", detail: "School holidays rotate priority -- last to book is lowest priority next round." },
  { id: "r3", icon: "🧹", rule: "Handover condition", detail: "Return van clean, full fuel, empty tanks, fresh water topped up." },
  { id: "r4", icon: "⛽", rule: "Fuel costs", detail: "Booking family pays fuel. Major services split equally." },
  { id: "r5", icon: "🛑", rule: "Cancellations", detail: "Cancel 14+ days out so others can claim the slot." },
  { id: "r6", icon: "🔧", rule: "Damage", detail: "Accidental = shared. Negligence = booking family pays. Report damage immediately." },
  { id: "r7", icon: "✏️", rule: "Tentative bookings", detail: "Holds a date temporarily. Confirmed bookings take priority." },
  { id: "r8", icon: "🤝", rule: "Conflict resolution", detail: "Fewer nights used = priority. Ties = coin flip." },
];

// ─── REDUCER ──────────────────────────────────────────────────────────────────
const INIT = {
  bookings: [], places: [], equipment: [],
  guides: [], rules: [], itineraries: [],
  families: DEFAULT_FAMILIES, vanPhoto: null, vanName: "The Family Campervan", vanManual: null,
  packingByFamily: {}, // { familyId: [{id,category,item,status}] }
  odoLog: [], // [{id,familyId,date,startKm,endKm,notes,bookingId}]
  odoRate: 0.30, // cost per km in dollars
};

function reducer(state, { type, payload, id }) {
  switch (type) {
    case "ADD_BOOKING": return { ...state, bookings: [...state.bookings, payload] };
    case "DEL_BOOKING": return { ...state, bookings: state.bookings.filter(b => b.id !== id) };
    case "CONFIRM_BOOKING": return { ...state, bookings: state.bookings.map(b => b.id === id ? { ...b, status: "confirmed" } : b) };
    case "UPD_BOOKING": return { ...state, bookings: state.bookings.map(b => b.id === payload.id ? { ...b, ...payload } : b) };
    case "UPD_BOOKING_COLLAB": return { ...state, bookings: state.bookings.map(b => b.id === payload.id ? { ...b, collaborators: payload.collaborators } : b) };
    case "UPD_BOOKING_DAYS": return { ...state, bookings: state.bookings.map(b => b.id === payload.id ? { ...b, days: payload.days, notes: payload.notes !== undefined ? payload.notes : b.notes } : b) };
    case "ADD_PLACE": return { ...state, places: [...state.places, payload] };
    case "DEL_PLACE": return { ...state, places: state.places.filter(p => p.id !== id) };
    case "ADD_REVIEW": return {
      ...state, places: state.places.map(p => {
        if (p.id !== payload.placeId) return p;
        const reviews = [...p.reviews, payload.review];
        return { ...p, reviews, overallRating: Math.round(reviews.reduce((a, r) => a + r.rating, 0) / reviews.length) };
      })
    };
    case "SET_EQUIPMENT": return { ...state, equipment: payload };
    case "ADD_GUIDE": return { ...state, guides: [...state.guides, payload] };
    case "UPDATE_GUIDE": return { ...state, guides: state.guides.map(g => g.id === payload.id ? payload : g) };
    case "DEL_GUIDE": return { ...state, guides: state.guides.filter(g => g.id !== id) };
    case "SET_RULES": return { ...state, rules: payload };
    case "ADD_ITINERARY": return { ...state, itineraries: [...state.itineraries, payload] };
    case "UPDATE_ITINERARY": return { ...state, itineraries: state.itineraries.map(i => i.id === payload.id ? payload : i) };
    case "SET_ITINERARY": return { ...state, itineraries: state.itineraries.map(i => i.id === payload.id ? payload : i) };
    case "DEL_ITINERARY": return { ...state, itineraries: state.itineraries.filter(i => i.id !== id) };
    case "ADD_FAMILY": return { ...state, families: [...state.families, payload] };
    case "SET_FAMILY_PACKING": return { ...state, packingByFamily: { ...state.packingByFamily, [payload.familyId]: payload.items } };
    case "UPDATE_FAMILY": return { ...state, families: state.families.map(f => f.id === payload.id ? payload : f) };
    case "DEL_FAMILY": return { ...state, families: state.families.filter(f => f.id !== id) };
    case "SET_VAN_PHOTO": return { ...state, vanPhoto: payload };
    case "SET_VAN_NAME": return { ...state, vanName: payload };
    case "SET_VAN_MANUAL": return { ...state, vanManual: payload };
    // Supabase bulk load actions
    case "RESET_FAMILIES": return { ...state, families: payload };
    case "RESET_BOOKINGS": return { ...state, bookings: payload };
    case "RESET_PLACES": return { ...state, places: payload };
    case "RESET_EQUIPMENT": return { ...state, equipment: payload };
    case "RESET_PACKING": return { ...state, packingByFamily: payload };
    case "RESET_ITINERARIES": return { ...state, itineraries: payload };
    case "RESET_GUIDES": return { ...state, guides: payload };
    case "RESET_RULES": return { ...state, rules: payload };
    case "ADD_ODO": return { ...state, odoLog: [...state.odoLog, payload] };
    case "DEL_ODO": return { ...state, odoLog: state.odoLog.filter(e => e.id !== id) };
    case "MARK_ODO_PAID": return { ...state, odoLog: state.odoLog.map(e => e.id === id ? { ...e, paid: !e.paid } : e) };
    case "RESET_ODO": return { ...state, odoLog: payload };
    case "SET_ODO_RATE": return { ...state, odoRate: payload };
    default: return state;
  }
}

// ─── STYLE HELPERS ────────────────────────────────────────────────────────────
const card = (x = {}) => ({ background: T.surface, borderRadius: T.radius, border: `1px solid ${T.border}`, boxShadow: T.shadow, padding: "14px", ...x });
const pill = (bg, color) => ({ background: bg, color, fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99, display: "inline-flex", alignItems: "center", gap: 4 });
const btn = (bg, color, x = {}) => ({ background: bg, color, border: "none", borderRadius: T.radiusSm, padding: "8px 14px", cursor: "pointer", fontWeight: 600, fontSize: 13, transition: "all 0.15s", ...x });
const inp = { width: "100%", boxSizing: "border-box", background: "#f8faf8", border: `1.5px solid ${T.border}`, borderRadius: T.radiusSm, padding: "8px 11px", fontSize: 13, color: T.text, outline: "none", fontFamily: "inherit" };
const lbl = { display: "block", fontSize: 10, fontWeight: 700, color: T.textMuted, marginBottom: 4, marginTop: 10, textTransform: "uppercase", letterSpacing: "0.5px" };
const sectionHead = { fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.5, color: T.textDim, margin: "0 0 10px" };


// ─── FAMILY AVATAR ─────────────────────────────────────────────────────────────
// Shows family photo if available, otherwise emoji. Used everywhere a family
// is identified so the photo choice flows through the whole app automatically.
function FamilyAvatar({ family, size = 28, fontSize = 18 }) {
  if (!family) return null;
  if (family.photo) {
    return (
      <img src={family.photo} alt={family.name}
        style={{
          width: size, height: size, borderRadius: "50%", objectFit: "cover",
          border: `2px solid ${family.color}50`, flexShrink: 0, display: "inline-block", verticalAlign: "middle"
        }} />
    );
  }
  return <span style={{ fontSize, lineHeight: 1, flexShrink: 0 }}>{family.emoji}</span>;
}


// ─── UI PRIMITIVES ────────────────────────────────────────────────────
// Small reusable UI components used throughout the app

function StarRating({ value, onChange, size = 18 }) {
  return (<div style={{ display: "flex", gap: 2 }}>{[1, 2, 3, 4, 5].map(n => (
    <button key={n} onClick={() => onChange && onChange(n)} style={{ background: "none", border: "none", cursor: onChange ? "pointer" : "default", fontSize: size, color: n <= value ? T.accent : "#d4e0d0", padding: 0, lineHeight: 1 }}>★</button>
  ))}</div>);
}

function ConfirmDialog({ message, detail, onConfirm, onCancel, confirmLabel = "Delete" }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,46,26,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500, padding: 16 }} onClick={onCancel}>
      <div style={{ ...card({ padding: 22 }), width: 340, maxWidth: "92vw", boxShadow: T.shadowLg, textAlign: "center" }} onClick={e => e.stopPropagation()}>
        <div style={{ width: 52, height: 52, borderRadius: 99, background: T.red + "15", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 24 }}>!</div>
        <p style={{ color: T.text, fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>{message}</p>
        {detail && <p style={{ color: T.textMuted, fontSize: 13, margin: "0 0 24px", lineHeight: 1.5 }}>{detail}</p>}
        {!detail && <p style={{ color: T.textMuted, fontSize: 13, margin: "0 0 24px" }}>This cannot be undone.</p>}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{ ...btn(T.bg, T.textMuted, { flex: 1, border: `1px solid ${T.border}` }) }}>Cancel</button>
          <button onClick={onConfirm} style={{ ...btn(T.red, T.surface, { flex: 1 }) }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children, width = 480 }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(26,46,26,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 800, padding: "16px 12px", overflowY: "auto" }} onClick={onClose}>
      <div style={{ ...card({ padding: 18 }), width, maxWidth: "96vw", maxHeight: "none", overflowY: "visible", overflowX: "hidden", boxShadow: T.shadowLg, marginTop: 8, marginBottom: 16 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: T.text, fontSize: 17, fontWeight: 700 }}>{title}</h3>
          <button onClick={onClose} style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.textMuted, fontSize: 18, cursor: "pointer", lineHeight: 1, borderRadius: T.radiusSm, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DeleteButton({ label = "Delete", message, detail, onConfirm, style: sx = {} }) {
  const [c, setC] = useState(false);
  return (<>
    <button onClick={() => setC(true)} style={{ ...btn(T.red + "15", T.red, { fontSize: 12, ...sx }), border: `1px solid ${T.red}30` }}>
      {label}
    </button>
    {c && <ConfirmDialog message={message || "Delete this item?"} detail={detail} onConfirm={() => { setC(false); onConfirm(); }} onCancel={() => setC(false)} confirmLabel={label || "Delete"} />}
  </>);
}

// ─── PIN PAD ──────────────────────────────────────────────────────────────────
function PinPad({ familyId, families, onSuccess, onBack }) {
  const [pin, setPin] = useState(""); const [err, setErr] = useState(""); const [shake, setShake] = useState(false);
  const fam = families.find(f => f.id === familyId);
  const handleDigit = d => {
    if (pin.length >= 4) return;
    const next = pin + d; setPin(next); setErr("");
    if (next.length === 4) {
      if (next === fam.pin) { setTimeout(() => onSuccess(), 150); }
      else { setShake(true); setErr("Incorrect PIN"); setTimeout(() => { setPin(""); setShake(false); }, 500); }
    }
  };
  const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "<"];
  return (
    <div style={{ textAlign: "center" }}>
      <button onClick={onBack} style={{ ...btn("transparent", T.textMuted, { fontSize: 13, marginBottom: 24, padding: "6px 12px", border: `1px solid ${T.border}`, borderRadius: T.radiusSm }) }}>&#8592; Back</button>
      <div style={{ width: 72, height: 72, borderRadius: 99, background: fam.color + "20", border: `3px solid ${fam.color}40`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px", overflow: "hidden" }}>
        {fam.photo
          ? <img src={fam.photo} alt={fam.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <span style={{ fontSize: 36 }}>{fam.emoji}</span>}
      </div>
      <p style={{ color: T.text, fontWeight: 700, fontSize: 16, margin: "0 0 4px" }}>{fam.name}</p>
      <p style={{ color: T.textDim, fontSize: 13, marginBottom: 24 }}>Enter your 4-digit PIN</p>
      <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 8, animation: shake ? "shake 0.4s" : "" }}>
        {[0, 1, 2, 3].map(i => (<div key={i} style={{ width: 14, height: 14, borderRadius: 99, border: `2px solid ${pin.length > i ? fam.color : T.border}`, background: pin.length > i ? fam.color : "transparent", transition: "all 0.15s" }} />))}
      </div>
      {err && <p style={{ color: T.red, fontSize: 12, marginBottom: 8, minHeight: 20 }}>{err}</p>}
      {!err && <div style={{ minHeight: 28 }} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, maxWidth: 200, margin: "0 auto" }}>
        {DIGITS.map((d, i) => (
          d === "" ? <div key={i} />
            : d === "<" ? <button key={i} onClick={() => { setPin(p => p.slice(0, -1)); setErr(""); }} style={{ ...btn(T.bg, T.textMuted, { padding: "14px", fontSize: 16, borderRadius: T.radius, border: `1px solid ${T.border}` }) }}>&#9003;</button>
              : <button key={i} onClick={() => handleDigit(d)} style={{ ...btn(T.surface, T.text, { padding: "12px", fontSize: 17, fontWeight: 700, borderRadius: T.radius, border: `1px solid ${T.border}`, boxShadow: "0 1px 4px rgba(45,106,79,0.08)" }) }} onMouseEnter={e => e.currentTarget.style.background = T.cardHover} onMouseLeave={e => e.currentTarget.style.background = T.surface}>{d}</button>
        ))}
      </div>
    </div>
  );
}

// ─── GUEST PIN ENTRY ──────────────────────────────────────────────────────────
// Lets a guest enter a booking PIN to access their restricted view
function GuestPinEntry({ onSuccess }) {
  const [pin, setPin] = useState(""); const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);

  const tryPin = async (p) => {
    if (p.length !== 4) return;
    setLoading(true); setErr("");
    try {
      // Search all bookings for a matching guest_pin
      const today = fmt(new Date());
      const cutoff = fmt(new Date(Date.now() - 21 * 24 * 60 * 60 * 1000)); // 3 weeks ago
      const bookings = await supa.get("bookings", `guest_pin=eq.${p}&end_date=gte.${cutoff}`);
      if (!bookings || bookings.length === 0) {
        setErr("PIN not found or booking has expired."); setPin(""); setLoading(false); return;
      }
      // Find the most relevant (latest start) active or recent booking
      const booking = bookings.sort((a, b) => b.start_date.localeCompare(a.start_date))[0];
      onSuccess(booking);
    } catch (e) {
      setErr("Error checking PIN — try again."); setPin("");
    }
    setLoading(false);
  };

  const DIGITS = ["1","2","3","4","5","6","7","8","9","","0","<"];
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 8 }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{ width: 14, height: 14, borderRadius: 99, border: `2px solid ${pin.length > i ? T.primary : T.border}`, background: pin.length > i ? T.primary : "transparent", transition: "all 0.15s" }} />
        ))}
      </div>
      {err && <p style={{ color: T.red, fontSize: 12, margin: "0 0 8px" }}>{err}</p>}
      {loading && <p style={{ color: T.textDim, fontSize: 12, margin: "0 0 8px" }}>Checking...</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, maxWidth: 200, margin: "0 auto" }}>
        {DIGITS.map((d, i) => (
          d === "" ? <div key={i} />
          : d === "<" ? <button key={i} onClick={() => { setPin(p => p.slice(0,-1)); setErr(""); }}
              style={{ ...btn(T.bg, T.textMuted, { padding:"14px", fontSize:16, borderRadius:T.radius, border:`1px solid ${T.border}` }) }}>⌫</button>
          : <button key={i} onClick={() => {
              const next = pin + d; setPin(next); setErr("");
              if (next.length === 4) tryPin(next);
            }} style={{ ...btn(T.surface, T.text, { padding:"12px", fontSize:17, fontWeight:700, borderRadius:T.radius, border:`1px solid ${T.border}` }) }}>{d}</button>
        ))}
      </div>
    </div>
  );
}

// ─── TRIP REPORT ──────────────────────────────────────────────────────────────
// Beautiful summary of a trip — accessible to guests and booking family
function TripReport({ booking, places, vanName, guestName, onClose }) {
  const days = booking.days || [];
  const totalActs = days.reduce((s, d) => s + (d.activities || []).length, 0);
  const placesVisited = [...new Set(
    days.flatMap(d => (d.activities || []).map(a => a.placeId).filter(Boolean))
  )].map(id => places.find(p => p.id === id)).filter(Boolean);

  const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  const printReport = () => {
    window.print();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: T.overlay, zIndex: 900, overflowY: "auto", padding: "16px 12px" }}>
      <div style={{ maxWidth: 580, margin: "0 auto", background: T.surface, borderRadius: T.radius, boxShadow: T.shadowLg, overflow: "hidden" }}>

        {/* Header */}
        <div style={{ background: `linear-gradient(135deg, ${T.primary}, #3a8a5f)`, padding: "28px 24px 24px", color: "white", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🚐</div>
          <h2 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 800 }}>{vanName || "Adventure Hub"}</h2>
          <h3 style={{ margin: "0 0 12px", fontSize: 17, fontWeight: 600, opacity: 0.9 }}>{booking.destination}</h3>
          {guestName && <div style={{ fontSize: 14, opacity: 0.85, marginBottom: 6 }}>{guestName}</div>}
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            {booking.start} → {booking.end} &middot; {Math.max(0, Math.round((new Date(booking.end) - new Date(booking.start)) / 86400000))} nights
          </div>
          <div style={{ display: "flex", justifyContent: "center", gap: 20, marginTop: 16 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{days.length}</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Days</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{totalActs}</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Activities</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{placesVisited.length}</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Places</div>
            </div>
          </div>
        </div>

        <div style={{ padding: "20px 20px 24px" }}>

          {/* Notes */}
          {booking.notes && (
            <div style={{ background: T.primary + "08", borderRadius: T.radiusSm, padding: "12px 14px", marginBottom: 20, borderLeft: `3px solid ${T.primary}` }}>
              <p style={{ margin: 0, fontSize: 13, color: T.textMuted, fontStyle: "italic", lineHeight: 1.6 }}>"{booking.notes}"</p>
            </div>
          )}

          {/* Day by day */}
          {days.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 800, color: T.textDim, textTransform: "uppercase", letterSpacing: 1 }}>📅 Itinerary</h4>
              {days.map((day, di) => {
                const d = new Date(day.date + "T12:00:00");
                const dayName = DAY_NAMES[d.getDay()];
                const acts = day.activities || [];
                return (
                  <div key={di} style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, color: T.primary, fontSize: 13, marginBottom: 6, paddingBottom: 4, borderBottom: `1px solid ${T.border}` }}>
                      Day {di + 1} &middot; {dayName} {day.date}
                    </div>
                    {acts.length === 0
                      ? <p style={{ color: T.textDim, fontSize: 12, margin: "4px 0", fontStyle: "italic" }}>Free day</p>
                      : acts.map((act, ai) => {
                        const lp = places.find(p => p.id === act.placeId);
                        return (
                          <div key={ai} style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: ai < acts.length - 1 ? `1px solid ${T.borderLight}` : "none" }}>
                            {act.time && <span style={{ fontSize: 11, color: T.primary, fontWeight: 700, minWidth: 40, flexShrink: 0 }}>{act.time}</span>}
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{act.title || "Activity"}</div>
                              {(lp || act.location) && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>📍 {lp ? lp.name : act.location}</div>}
                              {act.notes && <div style={{ fontSize: 11, color: T.textDim, fontStyle: "italic", marginTop: 1 }}>{act.notes}</div>}
                            </div>
                          </div>
                        );
                      })
                    }
                  </div>
                );
              })}
            </div>
          )}

          {/* Places visited */}
          {placesVisited.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h4 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 800, color: T.textDim, textTransform: "uppercase", letterSpacing: 1 }}>📍 Places</h4>
              {placesVisited.map(p => (
                <div key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.borderLight}` }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: T.text, fontSize: 13 }}>{p.name}</div>
                    {p.category && <div style={{ fontSize: 11, color: T.textDim }}>{p.category}</div>}
                  </div>
                  {p.overallRating > 0 && <div style={{ fontSize: 13, color: T.accent }}>{"★".repeat(p.overallRating)}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          <div style={{ textAlign: "center", paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
            <p style={{ color: T.textDim, fontSize: 11, margin: 0 }}>Generated by Adventure Hub &middot; {fmt(new Date())}</p>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, padding: "12px 20px 20px", justifyContent: "center" }}>
          <button onClick={printReport} style={btn(T.primary, T.surface, { fontSize: 13 })}>🖨️ Save / Print</button>
          <button onClick={onClose} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}`, fontSize: 13 }) }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── GUEST APP ────────────────────────────────────────────────────────────────
// Restricted view for guests — trip planning, places, kit, guides and rules only
function GuestApp({ booking, places, equipment, guides, rules, packingByFamily, vanName, dispatch, onSignOut }) {
  const [tab, setTab] = useState("trip");
  const [showReport, setShowReport] = useState(false);
  const guestId = "guest_" + booking.id;
  const guestName = booking.guestName || booking.guests || "Guest";

  // Guest-specific packing list
  const myPacking = packingByFamily[guestId] || [];
  const setMyPacking = items => dispatch({ type: "SET_FAMILY_PACKING", payload: { familyId: guestId, items } });

  const GUEST_TABS = [
    { id: "trip",   label: "My Trip",  icon: "🗺️" },
    { id: "places", label: "Places",   icon: "📍" },
    { id: "kit",    label: "Kit",      icon: "🎒" },
    { id: "howto",  label: "How-To",   icon: "📖" },
    { id: "rules",  label: "Rules",    icon: "📜" },
  ];

  // Guest-only trip plan view — read/write activities, read-only dates
  const GuestTripView = () => {
    const [fullEdit, setFullEdit] = useState(false);
    const days = booking.days || [];
    const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    return (
      <div>
        <div style={{ ...card({ padding: 14, marginBottom: 12 }), borderLeft: `4px solid ${T.primary}` }}>
          <div style={{ fontWeight: 800, fontSize: 18, color: T.text, marginBottom: 4 }}>{booking.destination}</div>
          <div style={{ color: T.textMuted, fontSize: 13 }}>{booking.start} → {booking.end}</div>
          {guestName && <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>👥 {guestName}</div>}
          <button onClick={() => setShowReport(true)}
            style={{ ...btn(T.primary + "15", T.primary, { fontSize: 12, marginTop: 10, border: `1px solid ${T.primary}30` }) }}>
            📄 View Trip Report
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <p style={{ ...sectionHead, margin: 0 }}>Trip Plan</p>
          <button onClick={() => setFullEdit(true)}
            style={btn(T.primary + "10", T.primary, { fontSize: 11, padding: "4px 10px", border: `1px solid ${T.primary}20` })}>
            ✏️ Edit Plan
          </button>
        </div>

        {days.length === 0
          ? <div style={{ ...card({ padding: 24, textAlign: "center" }) }}>
              <p style={{ color: T.textDim, margin: 0 }}>No days planned yet — tap Edit Plan to add activities.</p>
            </div>
          : days.map((day, di) => {
            const d = new Date(day.date + "T12:00:00");
            const dayName = DAY_NAMES[d.getDay()];
            const acts = day.activities || [];
            return (
              <div key={di} style={{ ...card({ padding: 12, marginBottom: 8 }) }}>
                <div style={{ fontWeight: 700, color: T.primary, fontSize: 13, marginBottom: 8 }}>
                  Day {di + 1} &middot; {dayName} {day.date}
                </div>
                {acts.length === 0
                  ? <p style={{ color: T.textDim, fontSize: 12, margin: 0, fontStyle: "italic" }}>Nothing planned — tap Edit Plan to add activities.</p>
                  : acts.map((act, ai) => (
                    <div key={ai} style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: ai < acts.length - 1 ? `1px solid ${T.borderLight}` : "none" }}>
                      {act.time && <span style={{ fontSize: 11, color: T.primary, fontWeight: 700, minWidth: 36 }}>{act.time}</span>}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{act.title}</div>
                        {act.notes && <div style={{ fontSize: 11, color: T.textDim, fontStyle: "italic" }}>{act.notes}</div>}
                      </div>
                    </div>
                  ))
                }
              </div>
            );
          })
        }

        {fullEdit && (
          <Modal title={"Plan: " + booking.destination} onClose={() => setFullEdit(false)}>
            <ItineraryEditor
              itin={{ id: booking.id, title: booking.destination, familyId: "guest", start: booking.start, end: booking.end, destination: booking.destination, notes: booking.notes || "", days: booking.days || [], bookingId: booking.id }}
              dispatch={action => {
                if (action.type === "SET_ITINERARY" || action.type === "UPDATE_ITINERARY") {
                  dispatch({ type: "UPD_BOOKING_DAYS", payload: { id: booking.id, days: action.payload.days, notes: action.payload.notes } });
                }
              }}
              places={places} bookings={[booking]} families={[]}
              onClose={() => setFullEdit(false)} />
          </Modal>
        )}
      </div>
    );
  };

  // Read-only guides
  const GuestGuidesView = () => {
    const [open, setOpen] = useState(null);
    return (
      <div>
        {(guides || []).map(g => (
          <div key={g.id} style={{ ...card({ padding: 0, overflow: "hidden", marginBottom: 8 }) }}>
            <button onClick={() => setOpen(open === g.id ? null : g.id)}
              style={{ width: "100%", background: "transparent", border: "none", padding: "11px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, color: T.text, fontSize: 14 }}>{g.icon} {g.title}</span>
              <span style={{ color: T.textDim, fontSize: 20, transform: open === g.id ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>›</span>
            </button>
            {open === g.id && (
              <div style={{ padding: "0 18px 18px", borderTop: `1px solid ${T.border}` }}>
                <pre style={{ margin: "14px 0 0", whiteSpace: "pre-wrap", fontSize: 13, color: T.textMuted, lineHeight: 1.8, fontFamily: "inherit" }}>{g.content}</pre>
                <GuideAttList atts={g.attachments} />
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "Inter,Segoe UI,system-ui,sans-serif", color: T.text }}>

      {/* Header */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, zIndex: 50, boxShadow: "0 1px 12px rgba(45,106,79,0.08)" }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2.5, color: T.textDim, textTransform: "uppercase", marginBottom: 1 }}>Guest Access</div>
              <h1 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: T.primary, letterSpacing: -0.3 }}>🚐 {vanName || "Adventure Hub"}</h1>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ padding: "4px 12px", background: T.accent + "18", border: `1px solid ${T.accent}35`, borderRadius: 99, fontSize: 12, fontWeight: 700, color: T.accent }}>
                🔑 {guestName}
              </div>
              <button onClick={onSignOut} title="Sign out"
                style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.radiusSm, cursor: "pointer", color: T.textMuted }}>
                <svg width="16" height="16" viewBox="0 0 512 512"><g fill="none" fillRule="evenodd"><g fill="currentColor" transform="translate(85.333333, 42.666667)"><path d="M234.666667,-2.13162821e-14 L234.666667,85.3333333 L192.000667,85.333 L192,42.6666667 L42.6666667,42.6666667 L42.6666667,384 L192,384 L192.000667,341.333 L234.666667,341.333333 L234.666667,426.666667 L-4.26325641e-14,426.666667 L-4.26325641e-14,-2.13162821e-14 L234.666667,-2.13162821e-14 Z M292.418278,112.915055 L392.836556,213.333333 L292.418278,313.751611 L262.248389,283.581722 L311.163,234.666 L106.666667,234.666667 L106.666667,192 L311.163,192 L262.248389,143.084945 L292.418278,112.915055 Z" /></g></g></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "14px 12px 110px" }}>
        {tab === "trip" && <GuestTripView />}
        {tab === "places" && <PlacesPanel places={places} dispatch={dispatch} onPickItinerary={() => {}} families={[]} currentFamilyId={guestId} itineraries={[]} />}
        {tab === "kit" && (
          <div>
            <div style={{ ...card({ padding: 12, marginBottom: 12, background: T.primary + "06", border: `1px solid ${T.primary}20` }) }}>
              <p style={{ margin: 0, fontSize: 12, color: T.textMuted }}>This is your personal packing list for the trip. Tick items as you pack them.</p>
            </div>
            <KitPanel equipment={equipment} dispatch={dispatch} currentFamilyId={guestId} packingByFamily={packingByFamily} />
          </div>
        )}
        {tab === "howto" && <GuestGuidesView />}
        {tab === "rules" && <RulesPanel rules={rules} dispatch={dispatch} />}
      </div>

      {/* Bottom tab bar */}
      <div style={{ position: "fixed", bottom: "env(safe-area-inset-bottom)", left: 0, right: 0, zIndex: 500, background: T.surface, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)", borderTop: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", paddingTop: 8, paddingBottom: 10 }}>
          {GUEST_TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "none", background: tab === t.id ? T.primary + "20" : "transparent", cursor: "pointer", color: tab === t.id ? T.primary : T.textDim, padding: "6px 0", margin: "0 3px", borderRadius: T.radiusSm }}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>{t.icon}</span>
              <span style={{ fontSize: 9, fontWeight: tab === t.id ? 700 : 400, marginTop: 2 }}>{t.label}</span>
            </button>
          ))}
        </div>
        <div style={{ height: "env(safe-area-inset-bottom)", background: T.surface }} />
      </div>

      {showReport && <TripReport booking={booking} places={places} vanName={vanName} guestName={guestName} onClose={() => setShowReport(false)} />}
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ families, vanPhoto, vanName, onLogin }) {
  const [sel, setSel] = useState(null);
  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter,Segoe UI,system-ui,sans-serif", padding: 14, paddingBottom: "calc(14px + env(safe-area-inset-bottom))" }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        {/* Van photo or illustrated header */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          {vanPhoto ? (
            <div style={{ width: "100%", height: 200, borderRadius: T.radius, overflow: "hidden", marginBottom: 20, boxShadow: T.shadowMd }}>
              <img src={vanPhoto} alt="campervan" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          ) : (
            <div style={{ fontSize: 72, marginBottom: 12, filter: "drop-shadow(0 4px 8px rgba(45,106,79,0.2))" }}>
              🚐
            </div>
          )}
          <h1 style={{ margin: "0 0 4px", fontSize: 28, fontWeight: 800, color: T.primary, letterSpacing: -0.5 }}>{vanName || "Adventure Hub"}</h1>
          <p style={{ margin: 0, color: T.textDim, fontSize: 14 }}>Family Campervan</p>
        </div>

        {!sel ? (
          <div>
            <p style={{ textAlign: "center", color: T.textMuted, fontWeight: 600, fontSize: 13, marginBottom: 16, textTransform: "uppercase", letterSpacing: 1 }}>Who's signing in?</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {(families || []).filter(f => f.id !== "maintenance").map(f => (
                <button key={f.id} onClick={() => setSel(f.id)}
                  style={{ ...card({ padding: 14, textAlign: "center", cursor: "pointer", border: `2px solid transparent`, boxShadow: T.shadow, transition: "all 0.2s" }), textAlign: "center" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = f.color; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = T.shadowMd; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = T.shadow; }}>
                  <div style={{ width: 52, height: 52, borderRadius: 99, background: f.color + "20", border: `2px solid ${f.color}40`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", overflow: "hidden" }}>
                    {f.photo
                      ? <img src={f.photo} alt={f.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      : <span style={{ fontSize: 28 }}>{f.emoji}</span>}
                  </div>
                  <div style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>{f.name}</div>
                </button>
              ))}
              {/* Guest tile — always shown as 6th slot */}
              <button onClick={() => setSel("__guest__")}
                style={{ ...card({ padding: 14, textAlign: "center", cursor: "pointer", border: `2px solid transparent`, boxShadow: T.shadow, transition: "all 0.2s" }), textAlign: "center" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = T.sand; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = T.shadowMd; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = T.shadow; }}>
                <div style={{ width: 52, height: 52, borderRadius: 99, background: T.sand + "20", border: `2px solid ${T.sand}40`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px" }}>
                  <span style={{ fontSize: 28 }}>🔑</span>
                </div>
                <div style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>Guest</div>
              </button>
            </div>
          </div>
        ) : sel === "__guest__" ? (
          <div style={{ ...card({ padding: 18 }) }}>
            <button onClick={() => setSel(null)} style={{ ...btn("transparent", T.textMuted, { fontSize: 13, marginBottom: 16, padding: "6px 12px", border: `1px solid ${T.border}`, borderRadius: T.radiusSm }) }}>← Back</button>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>🔑</div>
              <p style={{ fontWeight: 700, color: T.text, fontSize: 16, margin: "0 0 4px" }}>Guest Access</p>
              <p style={{ color: T.textDim, fontSize: 13, margin: 0 }}>Enter the PIN shared with you by the booking family</p>
            </div>
            <GuestPinEntry onSuccess={booking => onLogin("__guest__", booking)} />
          </div>
        ) : (
          <div style={{ ...card({ padding: 18 }) }}>
            <PinPad familyId={sel} families={families} onSuccess={() => onLogin(sel)} onBack={() => setSel(null)} />
          </div>
        )}

        <p style={{ textAlign: "center", color: T.textDim, fontSize: 11, marginTop: 20, lineHeight: 1.7 }}>
          Default PIN for all families: 0000 &mdash; change yours in Settings
        </p>
        <p style={{ textAlign: "center", color: T.textMuted, fontSize: 12, marginTop: 12, fontWeight: 600, letterSpacing: 0.5 }}>
          Adventure Hub · v2.1
        </p>
      </div>
      <style>{"@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}60%{transform:translateX(6px)}}"}</style>
    </div>
  );
}

// ─── MAP TOUCH WRAPPER ────────────────────────────────────────────────────────
// Attaches non-passive touchmove listener so preventDefault actually works,
// stopping the page from scrolling while the user drags inside the map.
function MapTouchWrapper({ children, height, radius = T.radius }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const block = e => e.preventDefault();
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);
  return (
    <div ref={ref} style={{ height, borderRadius: radius, overflow: "hidden", border: `1px solid ${T.border}`, touchAction: "none", flexShrink: 0 }}>
      {children}
    </div>
  );
}

// ─── LEAFLET MAP ──────────────────────────────────────────────────────────────
function LeafletMap({ places, onPinDrop, pickMode, center, height = 360 }) {
  const ref = useRef(null); const mapRef = useRef(null); const markersRef = useRef([]);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    // Block page scroll while touching the map.
    // We re-attach touchmove on every touchstart so it's always active —
    // subsequent drags were losing the block because Leaflet internally
    // calls stopPropagation on touchstart which can reset browser state.
    const el = ref.current;
    el.style.touchAction = "none";
    const blockScroll = e => e.preventDefault();
    // Attach immediately
    el.addEventListener("touchmove", blockScroll, { passive: false });
    // Re-attach on every touchstart to ensure it's always registered
    const onTouchStart = () => {
      el.removeEventListener("touchmove", blockScroll);
      el.addEventListener("touchmove", blockScroll, { passive: false });
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    const load = () => {
      if (mapRef.current) return;
      const L = window.L;
      const map = L.map(el, { zoomControl: true }).setView(center || [-37.5, 175.5], center ? 11 : 6);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "(c) OpenStreetMap" }).addTo(map);
      mapRef.current = map;
      if (pickMode && onPinDrop) map.on("click", e => onPinDrop({ lat: e.latlng.lat.toFixed(5), lng: e.latlng.lng.toFixed(5) }));
      setMapReady(true);
    };
    if (!document.getElementById("lf-css")) { const l = document.createElement("link"); l.id = "lf-css"; l.rel = "stylesheet"; l.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(l); }
    if (window.L) load(); else { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"; s.onload = load; document.head.appendChild(s); }
    return () => {
      el.removeEventListener("touchmove", blockScroll);
      el.removeEventListener("touchstart", onTouchStart);
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; setMapReady(false); }
    };
  }, []);

  // Pan map to new center when pin is moved — without remounting
  useEffect(() => {
    if (mapRef.current && center && mapReady) {
      mapRef.current.panTo(center, { animate: true });
    }
  }, [center, mapReady]);

  useEffect(() => {
    const map = mapRef.current; if (!map || !window.L || !mapReady) return;
    markersRef.current.forEach(m => m.remove()); markersRef.current = [];
    places.filter(p => p.lat && p.lng).forEach(p => {
      const ic = window.L.divIcon({ className: "", html: `<div style="background:${p.familyColor || T.primary};color:white;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:14px;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.2);">📍</div>`, iconSize: [32, 32], iconAnchor: [16, 32] });
      const m = window.L.marker([p.lat, p.lng], { icon: ic }).addTo(map).bindPopup(`<b>${p.name}</b><br><em style="font-size:12px">${p.reviews?.[0]?.text || ""}</em>`);
      markersRef.current.push(m);
    });
  }, [places, mapReady]);

  return <div ref={ref} style={{ width: "100%", height, borderRadius: T.radius, overflow: "hidden", border: `1px solid ${T.border}` }} />;
}

function PlaceSearch({ onSelect }) {
  const [q, setQ] = useState(""); const [results, setResults] = useState([]); const [loading, setLoading] = useState(false);
  const search = async () => { if (!q.trim()) return; setLoading(true); try { const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`, { headers: { "Accept-Language": "en" } }); setResults(await r.json()); } catch (e) { } setLoading(false); };
  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <input style={inp} placeholder="Search for a place..." value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} />
        <button onClick={search} style={btn(T.primary, T.surface, { flexShrink: 0 })}>{loading ? "..." : "Search"}</button>
      </div>
      {results.map(r => (
        <div key={r.place_id} onClick={() => { onSelect({ name: r.display_name.split(",")[0], lat: parseFloat(r.lat).toFixed(5), lng: parseFloat(r.lon).toFixed(5) }); setResults([]); setQ(""); }}
          style={{ padding: "10px 12px", margin: "4px 0", background: T.bg, borderRadius: T.radiusSm, cursor: "pointer", fontSize: 13, border: `1px solid ${T.border}` }}
          onMouseEnter={e => e.currentTarget.style.borderColor = T.primary} onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
          <div style={{ fontWeight: 600, color: T.text }}>{r.display_name.split(",")[0]}</div>
          <div style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>{r.display_name.split(",").slice(1, 4).join(",")} &middot; {parseFloat(r.lat).toFixed(4)}, {parseFloat(r.lon).toFixed(4)}</div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALENDAR
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CALENDAR VIEW ────────────────────────────────────────────────────
// Monthly calendar showing all family bookings

function CalendarView({ bookings, families, onOpenItinerary, currentFamilyId }) {
  const [month, setMonth] = useState(new Date(TODAY.getFullYear(), TODAY.getMonth(), 1));
  const [sel, setSel] = useState(null);
  const fColor = id => families.find(f => f.id === id)?.color ?? T.primary;
  const fName = id => families.find(f => f.id === id)?.name ?? "Unknown";
  const fEmoji = id => families.find(f => f.id === id)?.emoji ?? "";
  const y = month.getFullYear(), m = month.getMonth();
  const rawFirst = new Date(y, m, 1).getDay(); // 0=Sun,1=Mon...6=Sat
  const first = (rawFirst + 6) % 7; // convert to Mon=0,Tue=1...Sun=6
  const dim = new Date(y, m + 1, 0).getDate();
  const cells = []; for (let i = 0; i < first; i++)cells.push(null); for (let d = 1; d <= dim; d++)cells.push(d);
  const bkDay = d => { if (!d) return []; const ds = fmt(new Date(y, m, d)); return bookings.filter(b => ds >= b.start && ds <= b.end); };
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DayModal = ({ date, onClose }) => {
    const ds = fmt(date); const bks = bookings.filter(b => ds >= b.start && ds <= b.end);
    // find any linked itinerary for a booking

    return (<Modal title={date.toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })} onClose={onClose} width={420}>
      {bks.length === 0 ? <p style={{ color: T.textMuted }}>No bookings on this day.</p> : bks.map(b => {
        const totalActs = (b.days || []).reduce((s, d) => s + (d.activities || []).length, 0);
        return (
          <div key={b.id} onClick={() => { onClose(); onOpenItinerary(b.id); }}
            style={{ ...card({ padding: 14, marginBottom: 12 }), borderLeft: `4px solid ${fColor(b.familyId)}`, cursor: "pointer", transition: "box-shadow 0.15s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, color: T.text, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                    <FamilyAvatar family={families.find(f => f.id === b.familyId)} size={22} fontSize={16} />
                    {fName(b.familyId)}
                  </span>
                  <span style={pill(b.status === "tentative" ? T.yellow + "30" : T.primary + "20", b.status === "tentative" ? T.accent : T.primary)}>{b.status === "tentative" ? "Tentative" : "Confirmed"}</span>
                </div>
                <div style={{ color: T.textMuted, fontSize: 13, fontWeight: 500 }}>{b.destination}</div>
                <div style={{ color: T.textDim, fontSize: 12, marginTop: 3 }}>{b.start} to {b.end} &middot; {nights(b.start, b.end)} nights</div>
                {b.notes && <div style={{ color: T.textDim, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>"{b.notes}"</div>}
              </div>
            </div>
            {/* Trip plan link */}
            {b.familyId === currentFamilyId && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                <button onClick={() => { onClose(); onOpenItinerary(b.id); }}
                  style={{
                    ...card({ padding: "10px 14px" }), width: "100%", textAlign: "left", cursor: "pointer",
                    border: `1px solid ${T.primary}30`, background: T.primary + "08", display: "flex",
                    alignItems: "center", justifyContent: "space-between", gap: 8
                  }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: T.primary }}>🗺️ {b.destination}</div>
                    <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
                      {totalActs} activit{totalActs === 1 ? "y" : "ies"} planned · tap to edit
                    </div>
                  </div>
                  <span style={{ color: T.primary, fontSize: 18 }}>›</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </Modal>);
  };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={() => setMonth(new Date(y, m - 1, 1))} style={{ ...btn(T.surface, T.textMuted, { padding: "8px 14px", border: `1px solid ${T.border}` }) }}>&#8249;</button>
        <h3 style={{ margin: 0, flex: 1, textAlign: "center", color: T.primary, fontSize: 16, fontWeight: 800 }}>{MONTHS[m]} {y}</h3>
        <button onClick={() => setMonth(new Date(y, m + 1, 1))} style={{ ...btn(T.surface, T.textMuted, { padding: "8px 14px", border: `1px solid ${T.border}` }) }}>&#8250;</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: T.textDim, padding: "6px 0" }}>{d}</div>)}
        {cells.map((d, i) => {
          const bks = bkDay(d), isToday = d && new Date(y, m, d).toDateString() === TODAY.toDateString();
          return (
            <div key={i} onClick={() => d && setSel(new Date(y, m, d))}
              style={{
                minHeight: 52, background: d ? T.surface : "transparent", borderRadius: T.radiusSm, padding: 5,
                border: `1.5px solid ${isToday ? T.primary : bks.length ? T.border : "transparent"}`,
                cursor: d ? "pointer" : "default", transition: "all 0.1s", boxShadow: d ? T.shadow : "none"
              }}
              onMouseEnter={e => { if (d) { e.currentTarget.style.borderColor = T.primary; e.currentTarget.style.background = T.cardHover; } }}
              onMouseLeave={e => { if (d) { e.currentTarget.style.borderColor = isToday ? T.primary : bks.length ? T.border : "transparent"; e.currentTarget.style.background = T.surface; } }}>
              {d && <div style={{ fontSize: 11, fontWeight: isToday ? 800 : 500, color: isToday ? T.primary : T.textMuted, marginBottom: 2 }}>{d}</div>}
              {bks.slice(0, 2).map(b => (
                <div key={b.id} style={{
                  borderRadius: 4, fontSize: 8, fontWeight: 600, color: "white", padding: "2px 4px", marginBottom: 2,
                  background: b.status === "tentative" ? `repeating-linear-gradient(45deg,${fColor(b.familyId)}99 0,${fColor(b.familyId)}99 3px,${fColor(b.familyId)}44 3px,${fColor(b.familyId)}44 6px)` : fColor(b.familyId),
                  opacity: 0.9, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 1
                }}>
                  <FamilyAvatar family={families.find(f => f.id === b.familyId)} size={14} fontSize={10} />
                  {(b.collaborators || []).slice(0, 2).map(id => {
                    const cf = families.find(f => f.id === id);
                    return cf ? <FamilyAvatar key={id} family={cf} size={11} fontSize={8} /> : null;
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
        {families.map(f => <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}><div style={{ width: 10, height: 10, borderRadius: 3, background: f.color }} /><span style={{ color: T.textMuted, fontWeight: 500 }}>{f.name}</span></div>)}
      </div>
      {sel && <DayModal date={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function CollapsibleStats({ bookings, families }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={() => setOpen(!open)}
        style={{ ...btn("transparent", T.textMuted, { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", border: `1px solid ${T.border}`, borderRadius: open ? `${T.radius} ${T.radius} 0 0` : T.radius }) }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>📊 Van Usage</span>
        <span style={{ fontSize: 11, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
      </button>
      {open && <div style={{ border: `1px solid ${T.border}`, borderTop: "none", borderRadius: `0 0 ${T.radius} ${T.radius}`, overflow: "hidden" }}>
        <UsageStats bookings={bookings} families={families} />
      </div>}
    </div>
  );
}

function UsageStats({ bookings, families }) {
  const y = TODAY.getFullYear();
  const stats = families.map(f => {
    const n = bookings.filter(b => b.familyId === f.id && new Date(b.start).getFullYear() === y).reduce((s, b) => s + nights(b.start, b.end), 0);
    const t = bookings.filter(b => b.familyId === f.id && new Date(b.start).getFullYear() === y).length;
    return { ...f, nights: n, trips: t };
  });
  const mx = Math.max(...stats.map(s => s.nights), 1);
  return (
    <div>
      <p style={sectionHead}>{y} Usage</p>
      {stats.map(s => (
        <div key={s.id} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span style={{ color: T.text, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <FamilyAvatar family={s} size={20} fontSize={14} />
              {s.name}
            </span>
            <span style={{ color: T.textMuted }}>{s.nights}n &middot; {s.trips} trip{s.trips !== 1 ? "s" : ""}</span>
          </div>
          <div style={{ background: T.bg, borderRadius: 99, height: 8, overflow: "hidden", border: `1px solid ${T.border}` }}>
            <div style={{ width: `${(s.nights / mx) * 100}%`, background: s.color, height: "100%", borderRadius: 99, transition: "width 0.5s", minWidth: s.nights > 0 ? 8 : 0 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── DATE RANGE PICKER ────────────────────────────────────────────────────────

function DateRangePicker({ startDate, endDate, onChange, minDate, bookings = [], families = [] }) {
  const [month, setMonth] = useState(() => {
    const base = startDate ? new Date(startDate) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [hovered, setHovered] = useState(null);
  const [selectingEnd, setSelectingEnd] = useState(!!startDate && !endDate);

  const y = month.getFullYear(), mo = month.getMonth();
  const firstDay = (new Date(y, mo, 1).getDay() + 6) % 7; // Mon=0 ... Sun=6
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++)cells.push(null);
  for (let d = 1; d <= daysInMonth; d++)cells.push(d);

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

  const toStr = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

  // Find bookings that cover a given date string
  const bkgsOnDay = ds => (bookings || []).filter(b => b.start && b.end && ds >= b.start && ds <= b.end);
  const fColor = id => (families || []).find(f => f.id === id)?.color || T.primary;

  const handleDay = d => {
    if (!d) return;
    const ds = toStr(y, mo, d);
    if (minDate && ds < minDate) return;
    if (!startDate || !selectingEnd) {
      onChange({ start: ds, end: "" });
      setSelectingEnd(true);
    } else {
      if (ds < startDate) {
        onChange({ start: ds, end: "" });
        setSelectingEnd(true);
      } else {
        onChange({ start: startDate, end: ds });
        setSelectingEnd(false);
      }
    }
  };

  const previewEnd = selectingEnd && hovered && hovered >= startDate ? hovered : endDate;
  const nightCount = startDate && previewEnd && previewEnd !== startDate ? nights(startDate, previewEnd) : 0;

  const renderDay = (d, i) => {
    if (!d) return <div key={i} />;
    const ds = toStr(y, mo, d);
    const isStart = ds === startDate;
    const isEnd = ds === previewEnd;
    const inRange = startDate && previewEnd && ds > startDate && ds < previewEnd;
    const disabled = !!(minDate && ds < minDate);
    const isToday = ds === fmt(new Date());
    const isPreview = selectingEnd && hovered && ds === hovered && !endDate;
    const dayBkgs = bkgsOnDay(ds);
    const hasBooking = dayBkgs.length > 0;

    let bg = "transparent";
    let txtColor = disabled ? T.textDim : isToday && !isStart && !isEnd ? T.primary : T.text;
    let fw = isToday || isStart || isEnd ? 700 : 400;
    if (inRange) { bg = T.primary + "20"; }
    if (isStart || isEnd) { bg = T.primary; txtColor = T.surface; }
    if (isPreview && !isEnd) { bg = T.primary + "50"; }

    let dotBr = T.radiusSm;
    if (isStart && previewEnd && previewEnd !== startDate) dotBr = "50% 4px 4px 50%";
    else if (isEnd && startDate && previewEnd !== startDate) dotBr = "4px 50% 50% 4px";
    else if (isStart || isEnd) dotBr = "50%";

    const wrapBr = inRange ? "0" : dotBr;

    return (
      <div key={i}
        onClick={() => { if (!disabled) handleDay(d); }}
        onMouseEnter={() => { if (selectingEnd) setHovered(ds); }}
        onMouseLeave={() => setHovered(null)}
        style={{
          textAlign: "center", padding: "3px 1px",
          cursor: disabled ? "not-allowed" : "pointer",
          background: inRange ? T.primary + "15" : "transparent",
          borderRadius: wrapBr
        }}>
        <div style={{
          width: 30, height: 30,
          borderRadius: dotBr,
          background: bg,
          color: txtColor,
          fontWeight: fw,
          fontSize: 13,
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto",
          transition: "all 0.1s",
          border: isToday && !isStart && !isEnd ? `1.5px solid ${T.primary}` : "none",
          position: "relative"
        }}>
          {d}
          {/* Booking shading — coloured background per family */}
          {hasBooking && !isStart && !isEnd && (
            <div style={{
              position: "absolute", inset: 0, borderRadius: dotBr,
              background: dayBkgs.length === 1
                ? fColor(dayBkgs[0].familyId) + "45"
                : `linear-gradient(135deg, ${fColor(dayBkgs[0].familyId)}55 50%, ${fColor(dayBkgs[1].familyId)}55 50%)`,
              display: "flex", alignItems: "flex-end", justifyContent: "center",
              paddingBottom: 2, opacity: disabled ? 0.4 : 1,
              pointerEvents: "none"
            }}>
              {dayBkgs.length > 2 && <span style={{ fontSize: 7, fontWeight: 800, color: T.text, lineHeight: 1 }}>+{dayBkgs.length - 1}</span>}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ background: T.surface, borderRadius: T.radius, border: `1px solid ${T.border}`, overflow: "hidden", boxShadow: T.shadow }}>
      <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: `1px solid ${T.border}` }}>
        <button onClick={() => setMonth(new Date(y, mo - 1, 1))} style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 20, padding: "2px 10px", lineHeight: 1 }}>&#8249;</button>
        <span style={{ flex: 1, textAlign: "center", fontWeight: 700, color: T.primary, fontSize: 14 }}>{MONTHS[mo]} {y}</span>
        <button onClick={() => setMonth(new Date(y, mo + 1, 1))} style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 20, padding: "2px 10px", lineHeight: 1 }}>&#8250;</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", padding: "8px 8px 2px" }}>
        {DAY_LABELS.map(dl => (<div key={dl} style={{ textAlign: "center", fontSize: 10, fontWeight: 700, color: T.textDim, padding: "2px 0" }}>{dl}</div>))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", padding: "0 8px 8px", gap: 1 }}>
        {cells.map((d, i) => renderDay(d, i))}
      </div>
      {(bookings || []).length > 0 && (
        <div style={{ padding: "4px 8px 6px", display: "flex", gap: 6, flexWrap: "wrap", borderTop: `1px solid ${T.border}` }}>
          <span style={{ fontSize: 10, color: T.textDim, alignSelf: "center", marginRight: 2 }}>Booked:</span>
          {[...new Set((bookings || []).map(b => b.familyId))].map(fid => {
            const fam = (families || []).find(f => f.id === fid);
            return fam ? (
              <span key={fid} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: T.textMuted }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: fam.color, display: "inline-block" }} />
                {fam.name.split(" ")[0]}
              </span>
            ) : null;
          })}
        </div>
      )}
      <div style={{ borderTop: `1px solid ${T.border}`, padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", background: T.bg, gap: 8 }}>
        <div style={{ fontSize: 12, color: T.textMuted, flex: 1 }}>
          {!startDate && (<span>Tap a start date</span>)}
          {startDate && !previewEnd && (<span style={{ color: T.primary, fontWeight: 600 }}>{startDate} &rarr; tap end date</span>)}
          {startDate && previewEnd && (
            <span>
              <b style={{ color: T.primary }}>{startDate}</b>
              <span style={{ color: T.textDim }}> &rarr; </span>
              <b style={{ color: T.primary }}>{previewEnd}</b>
            </span>
          )}
        </div>
        {nightCount > 0 && (<span style={{ ...pill(T.primary + "15", T.primary), fontSize: 11, flexShrink: 0 }}>{nightCount} nights</span>)}
      </div>
      {startDate && (
        <div style={{ padding: "0 12px 10px", display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => { onChange({ start: "", end: "" }); setSelectingEnd(false); setHovered(null); }}
            style={{ ...btn("transparent", T.textMuted, { fontSize: 12, border: `1px solid ${T.border}`, padding: "4px 10px" }) }}>
            Clear
          </button>
          {startDate && endDate && (
            <span style={{ fontSize: 12, color: T.green, fontWeight: 600 }}>✓ Dates set</span>
          )}
        </div>
      )}
    </div>
  );
}


// ─── BOOKING FORM ─────────────────────────────────────────────────────
// Modal form for creating a new booking

function BookingForm({ bookings, dispatch, onClose, currentFamilyId, families }) {
  const fColor = id => families.find(f => f.id === id)?.color ?? T.primary;
  const fName = id => families.find(f => f.id === id)?.name ?? "Unknown";
  const [f, setF] = useState(() => {
    try {
      const saved = sessionStorage.getItem("bookingDraft");
      if (saved) return JSON.parse(saved);
    } catch (e) { }
    return { familyId: currentFamilyId || "f1", start: "", end: "", destination: "", notes: "", status: "tentative", collaborators: [], guests: "", guestName: "", guestPin: "" };
  });
  const [err, setErr] = useState("");
  const h = (k, v) => { setF(p => ({ ...p, [k]: v })); if (k === "start" || k === "end") setErr(""); };

  useEffect(() => {
    try { sessionStorage.setItem("bookingDraft", JSON.stringify(f)); } catch (e) { }
  }, [f]);
  const doSave = () => {
    dispatch({ type: "ADD_BOOKING", payload: { ...f, id: "b" + Date.now() } });
    try { sessionStorage.removeItem("bookingDraft"); } catch (e) { }
    onClose();
  };
  const cancelForm = () => {
    try { sessionStorage.removeItem("bookingDraft"); } catch (e) { }
    onClose();
  };
  const submit = () => {
    if (!f.start || !f.end || !f.destination) { setErr("Fill in all required fields."); return; }
    if (f.end <= f.start) { setErr("End must be after start."); return; }
    const clash = (bookings || []).filter(b => b.status === "confirmed" && b.end >= f.start && b.start <= f.end);
    if (clash.length) { setErr({ msg: "Your dates clash with existing confirmed bookings:", clashes: clash }); return; }
    const tentativeClash = (bookings || []).filter(b => b.status === "tentative" && b.end >= f.start && b.start <= f.end);
    if (tentativeClash.length) {
      setErr({ msg: "⚠️ These dates overlap a tentative booking — check with the others first. Book anyway?", clashes: tentativeClash, warning: true });
      return;
    }
    doSave();
  };
  return (
    <Modal title="New Booking" onClose={onClose}>

      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        <div style={{
          flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
          background: f.familyId === "maintenance" ? T.textDim + "15" : T.primary + "08",
          borderRadius: T.radiusSm,
          border: `1px solid ${f.familyId === "maintenance" ? T.textDim + "40" : T.primary + "20"}`
        }}>
          <FamilyAvatar family={families.find(fam => fam.id === f.familyId)} size={32} fontSize={18} />
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>Booking as</div>
            <div style={{ fontWeight: 700, color: f.familyId === "maintenance" ? T.textMuted : T.primary, fontSize: 14 }}>
              {families.find(fam => fam.id === f.familyId)?.name || "Unknown"}
            </div>
          </div>
        </div>
        <button
          onClick={() => h("familyId", f.familyId === "maintenance" ? currentFamilyId : "maintenance")}
          style={{
            ...btn(
              f.familyId === "maintenance" ? T.textDim + "20" : "transparent",
              f.familyId === "maintenance" ? T.textMuted : T.textDim,
              { border: `1px solid ${T.border}`, fontSize: 11, padding: "8px 10px", flexShrink: 0 }
            )
          }}>
          {f.familyId === "maintenance" ? "🔧 Undo" : "🔧 Maint."}
        </button>
      </div>
      <label style={lbl}>Type</label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {["confirmed", "tentative"].map(s => (
          <button key={s} onClick={() => h("status", s)} style={{ padding: "10px", border: `2px solid ${f.status === s ? fColor(f.familyId) : T.border}`, borderRadius: T.radiusSm, cursor: "pointer", fontWeight: 700, fontSize: 13, background: f.status === s ? fColor(f.familyId) + "15" : T.surface, color: f.status === s ? fColor(f.familyId) : T.textMuted, transition: "all 0.15s" }}>
            {s === "confirmed" ? "Confirmed" : "Tentative"}
          </button>
        ))}
      </div>
      <label style={lbl}>Dates *</label>
      <DateRangePicker
        startDate={f.start} endDate={f.end}
        minDate={fmt(TODAY)}
        onChange={({ start, end }) => setF(p => ({ ...p, start, end }))}
        bookings={bookings}
        families={families}
      />
      <label style={lbl}>Destination *</label>
      <input style={inp} placeholder="e.g. Blue Lake Campsite" value={f.destination} onChange={e => h("destination", e.target.value)} />
      <label style={lbl}>Notes</label>
      <textarea style={{ ...inp, height: 60, resize: "vertical" }} value={f.notes} onChange={e => h("notes", e.target.value)} />
      <label style={lbl}>Invite Families to Collaborate</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        {(families || []).filter(fam => fam.id !== currentFamilyId && fam.id !== "maintenance").map(fam => {
          const sel = (f.collaborators || []).includes(fam.id);
          return (
            <button key={fam.id} type="button" onClick={() => setF(p => ({ ...p, collaborators: sel ? p.collaborators.filter(id => id !== fam.id) : [...(p.collaborators || []), fam.id] }))}
              style={{
                ...btn(sel ? fam.color + "20" : "transparent", sel ? fam.color : T.textMuted,
                  { fontSize: 12, padding: "6px 12px", border: `2px solid ${sel ? fam.color : T.border}`, transition: "all 0.15s", display: "flex", alignItems: "center", gap: 4 })
              }}>
              <span>{fam.emoji}</span>
              <span>{fam.name.split(" ")[0]}</span>
              {sel && <span>✓</span>}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 11, color: T.textDim, margin: "0 0 8px" }}>Collaborators share the trip plan and can add activities.</p>
      <label style={lbl}>Extra Guests</label>
      <input style={inp} placeholder="e.g. Sarah, Tom & kids" value={f.guests || ""} onChange={e => setF(p => ({ ...p, guests: e.target.value }))} />
      <p style={{ fontSize: 11, color: T.textDim, margin: "-4px 0 8px" }}>Just names — for your reference only.</p>
      <label style={lbl}>Guest Access PIN</label>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <input style={{ ...inp, letterSpacing: 6, fontSize: 15, fontWeight: 700 }} placeholder="e.g. 1234" maxLength={4}
            value={f.guestPin || ""} onChange={e => setF(p => ({ ...p, guestPin: e.target.value.replace(/\D/g, "").slice(0, 4) }))} />
          {f.guestPin && f.guestPin.length < 4 && <p style={{ color: T.accent, fontSize: 11, margin: "3px 0 0" }}>Enter 4 digits</p>}
        </div>
        <input style={{ ...inp, flex: 1.5 }} placeholder="Guest name e.g. The Hendersons"
          value={f.guestName || ""} onChange={e => setF(p => ({ ...p, guestName: e.target.value }))} />
      </div>
      <p style={{ fontSize: 11, color: T.textDim, margin: "4px 0 8px", lineHeight: 1.5 }}>
        Optional — share this PIN with your guests so they can sign in, plan their trip and get a trip report. Active for 3 weeks after the booking ends.
      </p>
      {err && (
        <div style={{ background: err.warning ? T.accent + "12" : T.red + "12", borderRadius: T.radiusSm, marginBottom: 12, border: `1px solid ${err.warning ? T.accent + "40" : T.red + "30"}`, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", color: err.warning ? T.accent : T.red, fontSize: 13, fontWeight: 600 }}>{err.msg || err}</div>
          {err.clashes && err.clashes.map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: `1px solid ${err.warning ? T.accent : T.red}20`, background: err.warning ? T.accent + "08" : T.red + "08" }}>
              <FamilyAvatar family={families.find(f => f.id === b.familyId)} size={28} fontSize={16} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>{fName(b.familyId)}</div>
                <div style={{ color: T.textMuted, fontSize: 12 }}>{b.destination} &middot; {b.start} to {b.end} &middot; {nights(b.start, b.end)} nights</div>
              </div>
              <span style={{ ...pill(b.status === "tentative" ? T.accent + "20" : T.primary + "15", b.status === "tentative" ? T.accent : T.primary), fontSize: 10 }}>{b.status}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button onClick={err && err.warning ? doSave : submit} style={btn(T.primary, T.surface)}>
          {err && err.warning ? "Book Anyway" : "Save Booking"}
        </button>
        <button onClick={cancelForm} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}` }) }}>Cancel</button>
      </div>
    </Modal>
  );
}


// ─── BOOKING CARD ─────────────────────────────────────────────────────
// Compact booking card used in the main Bookings tab calendar view

function BookingCard({ b, families, onOpenItinerary, currentFamilyId, dispatch, odoLog, odoRate, onAddOdo }) {
  const fColor = id => families.find(f => f.id === id)?.color ?? T.primary;
  const fName = id => families.find(f => f.id === id)?.name ?? "Unknown";

  const isOwn = b.familyId === currentFamilyId;

  // Odo state
  const odo = (odoLog || []).filter(e => e.bookingId === b.id);
  const [showOdoForm, setShowOdoForm] = useState(false);
  const [odoForm, setOdoForm] = useState({ startKm: "", endKm: "", tolls: "", notes: "" });

  return (
    <div style={{ ...card({ padding: 12, marginBottom: 8 }), borderLeft: "4px solid " + fColor(b.familyId) }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontWeight: 700, color: T.text, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
              <FamilyAvatar family={families.find(f => f.id === b.familyId)} size={24} fontSize={16} />
              {fName(b.familyId)}
            </span>
            {b.familyId === "maintenance"
              ? <span style={{ ...pill("#88888820", "#666666"), fontSize: 11 }}>🔧 Van unavailable</span>
              : <span style={pill(b.status === "tentative" ? T.accent + "20" : T.primary + "15", b.status === "tentative" ? T.accent : T.primary)}>{b.status}</span>
            }
          </div>
          <div style={{ color: T.textMuted, fontSize: 13, fontWeight: 500 }}>{b.destination}</div>
          <div style={{ color: T.textDim, fontSize: 12, marginTop: 3 }}>{b.start} to {b.end} &middot; {nights(b.start, b.end)} nights</div>
          {b.notes && <div style={{ color: T.textDim, fontSize: 12, marginTop: 4, fontStyle: "italic" }}>"{b.notes}"</div>}


        </div>
      </div>
    </div>
  );
}

// Shows family photo if available, otherwise emoji. Used everywhere a family
// is identified so the photo choice flows through the whole app automatically.

// ─── MY LOCATION BUTTON ───────────────────────────────────────────────
// Leaflet map control to centre on user's current location

function MyLocationButton({ onLocate }) {
  const [status, setStatus] = useState("idle"); // idle | locating | error

  const locate = () => {
    if (!navigator.geolocation) { setStatus("error"); return; }
    setStatus("locating");
    navigator.geolocation.getCurrentPosition(
      pos => {
        setStatus("idle");
        onLocate({
          lat: pos.coords.latitude.toFixed(5),
          lng: pos.coords.longitude.toFixed(5)
        });
      },
      err => {
        setStatus("error");
        setTimeout(() => setStatus("idle"), 3000);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  return (
    <button onClick={locate} disabled={status === "locating"}
      style={{
        ...btn(
          status === "error" ? T.red + "15" : status === "locating" ? T.primary + "10" : T.primary + "15",
          status === "error" ? T.red : T.primary,
          {
            fontSize: 12, padding: "6px 12px", border: `1px solid ${status === "error" ? T.red : T.primary}30`,
            flexShrink: 0, display: "flex", alignItems: "center", gap: 6, opacity: status === "locating" ? 0.7 : 1
          }
        )
      }}>
      {status === "locating" ? "⏳ Locating..." : status === "error" ? "❌ Unavailable" : "📍 My Location"}
    </button>
  );
}


// ─── PLACES ───────────────────────────────────────────────────────────
// Place management — add, view, review locations

function AddPlaceModal({ dispatch, onClose, currentFamilyId }) {
  const [step, setStep] = useState("search");
  const [picked, setPicked] = useState({ name: "", lat: "", lng: "" });
  const [pinCoords, setPinCoords] = useState(null);
  const [mapCenter, setMapCenter] = useState(null); // set when user locates themselves
  const [form, setForm] = useState({ familyId: currentFamilyId || "f1", category: "Campsite", rating: 5, review: "" });
  const CATS = ["Campsite", "Beach", "Mountain", "Holiday Park", "Town", "Nature Reserve", "Other"];
  const submit = () => {
    if (!picked.name || !form.review) return;
    dispatch({ type: "ADD_PLACE", payload: { id: "p" + Date.now(), name: picked.name, lat: parseFloat(picked.lat) || 0, lng: parseFloat(picked.lng) || 0, familyId: form.familyId, category: form.category, overallRating: form.rating, reviews: [{ familyId: form.familyId, rating: form.rating, text: form.review, date: fmt(TODAY) }] } });
    onClose();
  };
  return (
    <Modal title="Add a Place" onClose={onClose} width={460}>
      <div style={{ display: "flex", gap: 4, marginBottom: 14, background: T.bg, padding: 4, borderRadius: T.radiusSm, border: `1px solid ${T.border}`, flexShrink: 0 }}>
        {[["search", "Search"], ["pin", "Drop Pin"], ["form", "Details"]].map(([s, l]) => (
          <button key={s} onClick={() => setStep(s)} style={{ flex: 1, padding: "8px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: step === s ? 700 : 500, background: step === s ? T.surface : T.bg, color: step === s ? T.primary : T.textMuted, boxShadow: step === s ? T.shadow : "none" }}>{l}</button>
        ))}
      </div>
      {step === "search" && (
        <div>
          <PlaceSearch onSelect={sel => { setPicked(sel); setStep("form"); }} />
          <p style={{ color: T.textDim, fontSize: 11, marginTop: 10, textAlign: "center", lineHeight: 1.5 }}>
            Search uses OpenStreetMap — requires an internet connection.<br />
            No results? Try "Drop Pin" to place a pin manually instead.
          </p>
        </div>
      )}
      {step === "pin" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <p style={{ color: T.textMuted, fontSize: 13, margin: 0 }}>Tap anywhere on the map to drop a pin.</p>
            <MyLocationButton onLocate={coords => {
              setPinCoords(coords);
              setPicked(p => ({ ...p, ...coords }));
              setMapCenter([parseFloat(coords.lat), parseFloat(coords.lng)]);
            }} />
          </div>
          <MapTouchWrapper height={380}>
            <LeafletMap
              places={pinCoords ? [{ id: "_pin", name: picked.name || "New place", lat: parseFloat(pinCoords.lat), lng: parseFloat(pinCoords.lng), familyColor: T.accent, reviews: [] }] : []}
              onPinDrop={coords => { setPinCoords(coords); setPicked(p => ({ ...p, ...coords })); }}
              pickMode={true}
              center={mapCenter || (pinCoords ? [parseFloat(pinCoords.lat), parseFloat(pinCoords.lng)] : null)}
              height={380}
            />
          </MapTouchWrapper>
          <div style={{ marginTop: 10 }}>
            {pinCoords ? (
              <div style={{ background: T.bg, borderRadius: T.radiusSm, padding: 12, border: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>📌</span>
                  <span style={{ color: T.textMuted, fontSize: 12, fontWeight: 600 }}>{pinCoords.lat}, {pinCoords.lng}</span>
                  <span style={{ fontSize: 11, color: T.textDim }}>(tap map to reposition)</span>
                </div>
                <input style={inp} placeholder="Place name *" value={picked.name} onChange={e => setPicked(p => ({ ...p, name: e.target.value }))} />
                <button onClick={() => setStep("form")} disabled={!picked.name.trim()}
                  style={{ ...btn(T.primary, T.surface, { marginTop: 10, width: "100%" }), opacity: picked.name.trim() ? 1 : 0.5 }}>
                  Continue →
                </button>
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "10px 0", color: T.textDim, fontSize: 13 }}>
                👆 Tap anywhere on the map above
              </div>
            )}
          </div>
        </div>
      )}
      {step === "form" && (
        <div>
          {picked.name && <div style={{ ...pill(T.primary + "15", T.primary), marginBottom: 12 }}>Pinned: {picked.name}</div>}
          <label style={lbl}>Place Name</label>
          <input style={inp} value={picked.name} onChange={e => setPicked(p => ({ ...p, name: e.target.value }))} placeholder="Place name *" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={lbl}>Adding as</label>
              <div style={{ ...inp, background: "transparent", border: `1px solid ${T.border}`, color: T.textMuted, cursor: "default", fontSize: 12 }}>
                {DEFAULT_FAMILIES.find(f => f.id === currentFamilyId)?.emoji} {DEFAULT_FAMILIES.find(f => f.id === currentFamilyId)?.name}
              </div>
            </div>
            <div><label style={lbl}>Category</label><select style={inp} value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>{CATS.map(cat => <option key={cat}>{cat}</option>)}</select></div>
          </div>
          <label style={lbl}>Your Rating</label><StarRating value={form.rating} onChange={r => setForm(f => ({ ...f, rating: r }))} size={28} />
          <label style={lbl}>Your Review *</label>
          <textarea style={{ ...inp, height: 80 }} placeholder="What was it like? Tips for the family?" value={form.review} onChange={e => setForm(f => ({ ...f, review: e.target.value }))} />
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <button onClick={submit} style={btn(T.primary, T.surface)}>Add Place</button>
            <button onClick={onClose} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}` }) }}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function PlaceCard({ place, dispatch, onAddToItinerary, families }) {
  const [expanded, setExpanded] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const fColor = id => families.find(f => f.id === id)?.color ?? T.primary;
  const fName = id => families.find(f => f.id === id)?.name ?? "Unknown";
  const fEmoji = id => families.find(f => f.id === id)?.emoji ?? "";
  const AddReview = ({ onClose }) => {
    const [fam, setFam] = useState("f1"); const [rat, setRat] = useState(4); const [txt, setTxt] = useState("");
    return (<Modal title={`Review: ${place.name}`} onClose={onClose} width={400}>
      <label style={lbl}>Family</label>
      <select style={inp} value={fam} onChange={e => setFam(e.target.value)}>{families.map(f => <option key={f.id} value={f.id}>{f.emoji} {f.name}</option>)}</select>
      <label style={lbl}>Rating</label><StarRating value={rat} onChange={setRat} size={26} />
      <label style={lbl}>Review</label>
      <textarea style={{ ...inp, height: 80 }} placeholder="Share your experience..." value={txt} onChange={e => setTxt(e.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={() => { if (!txt.trim()) return; dispatch({ type: "ADD_REVIEW", payload: { placeId: place.id, review: { familyId: fam, rating: rat, text: txt, date: fmt(TODAY) } } }); onClose(); }} style={btn(T.primary, T.surface)}>Post Review</button>
        <button onClick={onClose} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}` }) }}>Cancel</button>
      </div>
    </Modal>);
  };
  return (
    <div style={{ ...card({ padding: 0, overflow: "hidden", marginBottom: 10 }) }}>
      <div onClick={() => setExpanded(!expanded)} style={{ padding: "11px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}
        onMouseEnter={e => e.currentTarget.style.background = T.cardHover} onMouseLeave={e => e.currentTarget.style.background = T.surface}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>{place.name}</span>
            {place.category && <span style={{ ...pill(T.accent + "15", T.accent), fontSize: 11 }}>{place.category}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <StarRating value={place.overallRating} size={13} />
            <span style={{ color: T.textDim, fontSize: 12 }}>{place.reviews?.length || 0} review{place.reviews?.length !== 1 ? "s" : ""}</span>
          </div>
        </div>
        <div style={{ color: T.textDim, fontSize: 20, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>&#8250;</div>
      </div>
      {expanded && (
        <div style={{ padding: "0 18px 18px", borderTop: `1px solid ${T.border}` }}>
          {place.lat && place.lng && <div style={{ marginTop: 14, marginBottom: 14 }}>
            <MapTouchWrapper height={220} radius={T.radiusSm}>
              <LeafletMap places={[{ ...place, familyColor: fColor(place.familyId) }]} center={[place.lat, place.lng]} height={220} />
            </MapTouchWrapper>
            <a href={`https://maps.apple.com/?daddr=${place.lat},${place.lng}&dirflg=d`} target="_blank" rel="noreferrer"
              style={{ ...btn(T.bg, T.textMuted, { display: "inline-flex", gap: 6, marginTop: 10, fontSize: 12, textDecoration: "none", border: `1px solid ${T.border}` }) }}>
              Get Directions
            </a>
          </div>}
          {(place.reviews || []).map((r, i) => (
            <div key={i} style={{ background: T.bg, borderRadius: T.radiusSm, padding: "10px 12px", marginBottom: 8, borderLeft: `3px solid ${fColor(r.familyId)}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, color: T.text, fontSize: 13 }}>{fEmoji(r.familyId)} {fName(r.familyId)}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}><StarRating value={r.rating} size={13} /><span style={{ color: T.textDim, fontSize: 11 }}>{r.date}</span></div>
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 13, color: T.textMuted }}>&ldquo;{r.text}&rdquo;</p>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button onClick={() => setShowReview(true)} style={{ ...btn(T.primary + "15", T.primary, { fontSize: 12 }), border: `1px solid ${T.primary}30` }}>+ Review</button>
            <button onClick={() => onAddToItinerary(place)} style={{ ...btn(T.accent + "15", T.accent, { fontSize: 12 }), border: `1px solid ${T.accent}30` }}>Add to Trip</button>
            <DeleteButton label="Remove" message={`Remove "${place.name}"?`} onConfirm={() => dispatch({ type: "DEL_PLACE", id: place.id })} style={{ fontSize: 12 }} />
          </div>
        </div>
      )}
      {showReview && <AddReview onClose={() => setShowReview(false)} />}
    </div>
  );
}

function PlacesPanel({ places, dispatch, onPickItinerary, families, currentFamilyId, itineraries }) {
  const [view, setView] = useState("list"); const [adding, setAdding] = useState(false); const [pickItin, setPickItin] = useState(null);
  const [pickDay, setPickDay] = useState(null); // {itin, place} — day selection step
  // Hide background map while modal is open so it doesn't bleed through
  const showMap = view === "map" && !adding && !pickItin && !pickDay;
  const handleAdd = place => { if (itineraries.length === 0) { alert("Create a trip first in the Trips tab."); return; } setPickItin(place); };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4, background: T.bg, padding: 4, borderRadius: T.radiusSm, border: `1px solid ${T.border}` }}>
          {[["list", "List"], ["map", "Map"]].map(([v, l]) => <button key={v} onClick={() => setView(v)} style={{ padding: "7px 16px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 500, background: view === v ? T.surface : T.bg, color: view === v ? T.primary : T.textMuted, boxShadow: view === v ? T.shadow : "none" }}>{l}</button>)}
        </div>
        <button onClick={() => setAdding(true)} style={btn(T.primary, T.surface)}>+ Add Place</button>
      </div>
      {showMap && <><MapTouchWrapper height={420} radius={T.radius}><LeafletMap places={places} height={420} /></MapTouchWrapper><div style={{ marginTop: 14 }}>{places.map(p => <PlaceCard key={p.id} place={p} dispatch={dispatch} onAddToItinerary={handleAdd} families={families} />)}</div></>}
      {view === "list" && (places.length === 0 ? <div style={{ ...card({ padding: 24, textAlign: "center" }) }}>
        <p style={{ color: T.textDim, margin: 0 }}>No places saved yet. Add your first family favourite!</p>
      </div> : places.map(p => <PlaceCard key={p.id} place={p} dispatch={dispatch} onAddToItinerary={handleAdd} families={families} />))}
      {adding && <AddPlaceModal dispatch={dispatch} onClose={() => setAdding(false)} currentFamilyId={currentFamilyId} />}
      {pickItin && !pickDay && (
        <Modal title="Add to Trip" onClose={() => setPickItin(null)} width={360}>
          <p style={{ color: T.textMuted, fontSize: 13, marginBottom: 12 }}>Which trip to add <b>{pickItin.name}</b> to?</p>
          {itineraries.length === 0 && <p style={{ color: T.textDim, fontSize: 13 }}>No trips yet — create one in the Trips tab first.</p>}
          {itineraries.map(it => (
            <button key={it.id} onClick={() => { setPickDay({ itin: it, place: pickItin }); setPickItin(null); }}
              style={{ ...btn(T.bg, T.text, { width: "100%", marginBottom: 8, textAlign: "left", padding: "12px 14px", border: `1px solid ${T.border}`, borderRadius: T.radiusSm }) }}>
              <div style={{ fontWeight: 700, color: T.text }}>{it.title}</div>
              <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3 }}>{it.start} to {it.end} &middot; {(it.days || []).length} days</div>
            </button>
          ))}
        </Modal>
      )}
      {pickDay && (
        <Modal title={`Add to "${pickDay.itin.title}"`} onClose={() => setPickDay(null)} width={360}>
          <p style={{ color: T.textMuted, fontSize: 13, marginBottom: 12 }}>Which day to add <b>{pickDay.place.name}</b> to?</p>
          {(pickDay.itin.days || []).length === 0 && <p style={{ color: T.textDim, fontSize: 13 }}>This trip has no days — set start/end dates in the Trips tab first.</p>}
          {(pickDay.itin.days || []).map((day, di) => {
            const d = new Date(day.date);
            const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            return (
              <button key={day.date} onClick={() => { onPickItinerary(pickDay.itin.id, pickDay.place, di); setPickDay(null); }}
                style={{ ...btn(T.bg, T.text, { width: "100%", marginBottom: 8, textAlign: "left", padding: "12px 14px", border: `1px solid ${T.border}`, borderRadius: T.radiusSm }) }}>
                <div style={{ fontWeight: 700, color: T.primary }}>{DAY_NAMES[d.getDay()]} <span style={{ color: T.text }}>{day.date}</span></div>
                <div style={{ fontSize: 11, color: T.textDim, marginTop: 3 }}>{(day.activities || []).length} activit{(day.activities || []).length === 1 ? "y" : "ies"} already planned</div>
              </button>
            );
          })}
        </Modal>
      )}
    </div>
  );
}

// ─── PLACE PICKER MODAL ───────────────────────────────────────────────────────
function PlacePickerModal({ places, onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const filtered = places.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.category?.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal title="Select a Place" onClose={onClose} width={440}>
      <input style={{ ...inp, marginBottom: 12 }} placeholder="Search places..." value={search} autoFocus
        onChange={e => setSearch(e.target.value)} />
      {filtered.length === 0 && <p style={{ color: T.textDim, fontSize: 13, textAlign: "center", padding: "12px 0" }}>No places match "{search}"</p>}
      <div style={{ display: "grid", gap: 8, maxHeight: 360, overflowY: "auto" }}>
        {filtered.map(p => (
          <button key={p.id} onClick={() => onSelect(p)}
            style={{ ...card({ padding: "12px 14px" }), border: `1px solid ${T.border}`, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12, width: "100%" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = T.primary}
            onMouseLeave={e => e.currentTarget.style.borderColor = T.border}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: T.text, fontSize: 14 }}>{p.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                {p.category && <span style={{ ...pill(T.accent + "15", T.accent), fontSize: 10 }}>{p.category}</span>}
                <span style={{ color: T.textDim, fontSize: 12 }}>{"★".repeat(p.overallRating || 0)} {p.reviews?.length || 0} review{p.reviews?.length !== 1 ? "s" : ""}</span>
              </div>
            </div>
            <span style={{ color: T.primary, fontSize: 20 }}>›</span>
          </button>
        ))}
      </div>
      {places.length === 0 && <p style={{ color: T.textDim, fontSize: 13, margin: "12px 0 0", textAlign: "center" }}>No saved places yet — add some in the Places tab.</p>}
    </Modal>
  );
}


// ─── ITINERARY EDITOR ─────────────────────────────────────────────────
// Full trip plan editor — days, activities, places, dates

function ItineraryEditor({ itin, dispatch, places, bookings, families, onClose, inline = false, onFullEdit }) {
  const [data, setData] = useState({ ...itin });
  const h = (k, v) => setData(d => ({ ...d, [k]: v }));
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const [pickingPlaceFor, setPickingPlaceFor] = useState(null); // {di, ai} when picker open
  const linkable = bookings.filter(b => b.familyId === data.familyId && b.end >= fmt(TODAY));

  useEffect(() => {
    if (!data.start || !data.end) return;
    const n = nights(data.start, data.end); if (n < 0) return;
    const existing = data.days || [];
    const days = Array.from({ length: n + 1 }, (_, i) => { const d = fmt(addDays(new Date(data.start), i)); return existing.find(e => e.date === d) || { date: d, activities: [] }; });
    h("days", days);
  }, [data.start, data.end]);
  const addAct = di => { const days = [...(data.days || [])]; days[di] = { ...days[di], activities: [...(days[di].activities || []), { id: "a" + Date.now(), time: "", title: "", placeId: "", location: "", notes: "" }] }; h("days", days); };
  const updAct = (di, ai, field, val) => { const days = [...(data.days || [])]; days[di] = { ...days[di], activities: days[di].activities.map((a, i) => i === ai ? { ...a, [field]: val } : a) }; h("days", days); };
  const delAct = (di, ai) => { const days = [...(data.days || [])]; days[di] = { ...days[di], activities: days[di].activities.filter((_, i) => i !== ai) }; h("days", days); };
  const save = () => {
    const otherId = data.bookingId || data.id;
    const clash = (bookings || []).filter(b => b.id !== otherId && b.status === "confirmed" && data.start <= b.end && data.end >= b.start);
    if (clash.length) { h("_saveErr", "Cannot save - clashes with confirmed: " + clash.map(b => b.destination).join(", ")); return; }
    const payload = { ...data };
    delete payload._unsaved; delete payload._tentClash; delete payload._saveErr;
    if (data._unsaved) dispatch({ type: "ADD_ITINERARY", payload });
    else dispatch({ type: "SET_ITINERARY", payload });
    if (onClose) onClose();
  };
  if (inline) return (
    <div style={{ padding: "12px 14px" }}>
      <div style={{ padding: "2px 0 10px" }}>
        <p style={{ ...sectionHead, margin: 0 }}>TRIP PLAN</p>
      </div>
      {(data.days || []).map((day, di) => (
        <div key={di} style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, color: T.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Day {di + 1} · {day.date}
          </div>
          {(day.activities || []).map((act, ai) => (
            <div key={ai} style={{ ...card({ padding: "8px 10px" }), marginBottom: 4, display: "flex", gap: 8, alignItems: "flex-start" }}>
              {act.time && <span style={{ fontSize: 11, color: T.textDim, minWidth: 36, paddingTop: 1 }}>{act.time}</span>}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: T.text }}>{act.title}</div>
                {act.place && <div style={{ fontSize: 11, color: T.primary, marginTop: 1 }}>📍 {act.place}</div>}
                {act.notes && <div style={{ fontSize: 11, color: T.textDim, marginTop: 1, fontStyle: "italic" }}>{act.notes}</div>}
              </div>
            </div>
          ))}
          {(day.activities || []).length === 0 && (
            <div style={{ color: T.textDim, fontSize: 11, fontStyle: "italic", padding: "4px 0" }}>No activities planned yet</div>
          )}
        </div>
      ))}
      <button onClick={() => onFullEdit && onFullEdit()}
        style={btn(T.primary + "15", T.primary, { width: "100%", marginTop: 8, fontSize: 12 })}>
        ✏️ Edit Full Trip Plan
      </button>
    </div>
  );
  return (
    <div style={{ ...card(), marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h3 style={{ margin: 0, color: T.primary, fontSize: 16, fontWeight: 700 }}>{data.title || "New Trip"}</h3>
        <div style={{ display: "flex", gap: 8 }}>
          {data._saveErr && <div style={{ padding: "6px 10px", marginBottom: 8, background: T.red + "12", border: `1px solid ${T.red}30`, borderRadius: T.radiusSm, fontSize: 12, color: T.red, width: "100%" }}>X {data._saveErr}</div>}
          {data._tentClash && <div style={{ padding: "6px 10px", marginBottom: 8, background: T.accent + "12", border: `1px solid ${T.accent}30`, borderRadius: T.radiusSm, fontSize: 12, color: T.accent }}>⚠️ Dates overlap tentative booking: {data._tentClash}</div>}
          <button onClick={save} style={btn(T.primary, T.surface)}>Save Trip</button>
          <button onClick={onClose} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}` }) }}>Cancel</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div style={{ gridColumn: "1/-1" }}>
          <label style={lbl}>Dates</label>
          <DateRangePicker
            startDate={data.start} endDate={data.end}
            bookings={bookings} families={[]}
            onChange={({ start, end }) => {
              // Check for clashes with other bookings
              const clash = (bookings || []).filter(b =>
                b.id !== data.bookingId && b.status === "confirmed" &&
                start <= b.end && end >= b.start
              );
              if (clash.length) {
                alert("Cannot save — dates clash with a confirmed booking: " + clash.map(b => b.destination).join(", "));
                return;
              }
              const tentClash = (bookings || []).filter(b =>
                b.id !== data.bookingId && b.status === "tentative" &&
                start <= b.end && end >= b.start
              );
              // Update trip dates (tentative clash just noted, not blocked)
              setData(d => ({ ...d, start, end, _tentClash: tentClash.length ? tentClash.map(b => b.destination).join(", ") : null }));
              // Also update the linked booking dates to keep them in sync
              if (data.bookingId) {
                dispatch({ type: "UPD_BOOKING", payload: { id: data.bookingId, start, end } });
              }
            }}
          />
        </div>
        <div style={{ gridColumn: "1/-1" }}><label style={lbl}>Notes</label><textarea style={{ ...inp, height: 52 }} value={data.notes || ""} onChange={e => h("notes", e.target.value)} placeholder="Overview, goals, reminders..." /></div>

      </div>
      {(data.days || []).map((day, di) => {
        const d = new Date(day.date);
        return (
          <div key={day.date} style={{ background: T.bg, borderRadius: T.radiusSm, padding: 14, marginTop: 10, border: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontWeight: 700, color: T.primary, fontSize: 13 }}>{DAY_NAMES[d.getDay()]} <span style={{ color: T.textMuted, fontWeight: 500 }}>{day.date}</span></span>
              <button onClick={() => addAct(di)} style={{ ...btn(T.primary + "15", T.primary, { fontSize: 11, padding: "4px 12px" }), border: `1px solid ${T.primary}30` }}>+ Activity</button>
            </div>
            {(day.activities || []).map((act, ai) => (
              <div key={act.id} style={{ ...card({ padding: 10, marginBottom: 8 }), border: `1px solid ${T.border}` }}>
                <div style={{ display: "grid", gridTemplateColumns: "76px 1fr auto", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <input style={{ ...inp, padding: "6px 8px", fontSize: 12 }} placeholder="Time" value={act.time} onChange={e => updAct(di, ai, "time", e.target.value)} />
                  <input style={{ ...inp, padding: "6px 8px", fontSize: 12 }} placeholder="Activity title" value={act.title} onChange={e => updAct(di, ai, "title", e.target.value)} />
                  <button onClick={() => delAct(di, ai)} style={{ background: "none", border: "none", cursor: "pointer", color: T.red, fontSize: 18, padding: "0 4px", flexShrink: 0 }}>&times;</button>
                </div>
                <div style={{ marginBottom: 6 }}>
                  {act.placeId ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, background: T.primary + "10", borderRadius: T.radiusSm, padding: "6px 10px", border: `1px solid ${T.primary}30` }}>
                      <span style={{ fontSize: 13, color: T.primary, flex: 1, fontWeight: 600 }}>📍 {places.find(p => p.id === act.placeId)?.name || "Place"}</span>
                      <button onClick={() => { setPickingPlaceFor({ di, ai }); }} style={{ ...btn(T.primary + "15", T.primary, { fontSize: 11, padding: "3px 8px" }) }} >Change</button>
                      <button onClick={() => updAct(di, ai, "placeId", "")} style={{ background: "none", border: "none", cursor: "pointer", color: T.red, fontSize: 16 }}>&times;</button>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <button onClick={() => setPickingPlaceFor({ di, ai })}
                        style={{ ...btn(T.bg, T.textMuted, { border: `1px solid ${T.border}`, fontSize: 12, padding: "7px 10px", textAlign: "left" }) }}>
                        📍 Pick a saved place...
                      </button>
                      <input style={{ ...inp, padding: "6px 8px", fontSize: 12 }} placeholder="📌 Or type location..." value={act.location || ""} onChange={e => updAct(di, ai, "location", e.target.value)} />
                    </div>
                  )}
                </div>
                <textarea style={{ ...inp, padding: "6px 8px", fontSize: 12, height: 48, resize: "none" }} placeholder="Notes (optional)..." value={act.notes || ""} onChange={e => updAct(di, ai, "notes", e.target.value)} />
              </div>
            ))}
            {!(day.activities || []).length && <p style={{ color: T.textDim, fontSize: 12, margin: "4px 0" }}>No activities planned.</p>}
          </div>
        );
      })}
      {!data.start && <p style={{ color: T.textDim, fontSize: 13, marginTop: 12 }}>Set dates above to build the day-by-day plan.</p>}
      {pickingPlaceFor && (
        <PlacePickerModal
          places={places}
          onClose={() => setPickingPlaceFor(null)}
          onSelect={p => {
            updAct(pickingPlaceFor.di, pickingPlaceFor.ai, "placeId", p.id);
            updAct(pickingPlaceFor.di, pickingPlaceFor.ai, "location", "");
            setPickingPlaceFor(null);
          }}
        />
      )}
    </div>
  );
}

function ItinCard({ itin, dispatch, places, families, onEdit, currentFamilyId, archived = false }) {
  const [expanded, setExpanded] = useState(false);
  const fColor = id => families.find(f => f.id === id)?.color ?? T.primary;
  const fName = id => families.find(f => f.id === id)?.name ?? "Unknown";
  const fEmoji = id => families.find(f => f.id === id)?.emoji ?? "";
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const total = (itin.days || []).reduce((s, d) => s + (d.activities || []).length, 0);
  const buildDirUrl = day => {
    const coords = (day.activities || []).filter(a => a.placeId).map(a => { const p = places.find(pl => pl.id === a.placeId); return p ? `${p.lat},${p.lng}` : null; }).filter(Boolean);
    if (!coords.length) return null;
    if (coords.length === 1) return `https://maps.apple.com/?daddr=${coords[0]}&dirflg=d`;
    return `https://maps.apple.com/?daddr=${coords[coords.length - 1]}&dirflg=d&via=${coords.slice(0, -1).join("/")}`;
  };
  return (
    <div style={{ ...card({ padding: 0, overflow: "hidden", marginBottom: 10 }) }}>
      <div style={{ padding: "11px 14px", display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ width: 5, borderRadius: 99, background: fColor(itin.familyId), alignSelf: "stretch", flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
          <div style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>{itin.title}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: T.textMuted, fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
              <FamilyAvatar family={families.find(f => f.id === itin.familyId)} size={16} fontSize={13} />
              {fName(itin.familyId)}
            </span>
            {itin.start && <span style={{ color: T.textDim, fontSize: 12 }}>{itin.start} to {itin.end}</span>}

            <span style={{ ...pill(T.sky + "20", T.sky), fontSize: 10 }}>{total} act.</span>
            {itin.visibility === "shared"
              ? <span style={{ ...pill(T.green + "15", T.green), fontSize: 10 }}>Shared</span>
              : <span style={{ ...pill(T.textDim + "15", T.textDim), fontSize: 10 }}>Private</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          {!archived && itin.familyId === currentFamilyId && (
            <button onClick={e => { e.stopPropagation(); onEdit(itin); }}
              style={{ ...btn(T.primary + "15", T.primary, { fontSize: 11, padding: "5px 10px", border: `1px solid ${T.primary}25` }) }}>
              ✏️ Edit
            </button>
          )}
          <div onClick={() => setExpanded(!expanded)} style={{ color: T.textDim, fontSize: 20, cursor: "pointer", padding: "0 2px", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>&#8250;</div>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: "0 18px 18px", borderTop: `1px solid ${T.border}` }}>
          {itin.notes && <p style={{ color: T.textMuted, fontSize: 13, margin: "12px 0" }}>{itin.notes}</p>}
          {(itin.days || []).map(day => {
            const d = new Date(day.date), dn = DAY_NAMES[d.getDay()], dirUrl = buildDirUrl(day);
            return (
              <div key={day.date} style={{ background: T.bg, borderRadius: T.radiusSm, padding: "12px 14px", marginTop: 10, border: `1px solid ${T.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: T.primary }}>{dn} <span style={{ color: T.textMuted, fontWeight: 500 }}>{day.date}</span></span>
                  {dirUrl && <a href={dirUrl} target="_blank" rel="noreferrer" style={{ ...btn(T.accent + "15", T.accent, { fontSize: 11, padding: "4px 12px", textDecoration: "none", border: `1px solid ${T.accent}30` }) }}>Directions</a>}
                </div>
                {!(day.activities || []).length ? <p style={{ color: T.textDim, fontSize: 12, margin: 0 }}>Free day</p> : (day.activities || []).map(act => {
                  const lp = places.find(p => p.id === act.placeId);
                  return (
                    <div key={act.id} style={{ padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        {act.time && <span style={{ color: T.primary, fontSize: 12, fontWeight: 700, minWidth: 42, flexShrink: 0 }}>{act.time}</span>}
                        <div style={{ flex: 1 }}>
                          <div style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>{act.title || "Activity"}</div>
                          {lp && <div style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>
                            📍 {lp.name} &middot; <a href={`https://maps.apple.com/?daddr=${lp.lat},${lp.lng}&dirflg=d`} target="_blank" rel="noreferrer" style={{ color: T.sky, textDecoration: "none" }}>Navigate</a>
                          </div>}
                          {!lp && act.location && <div style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}>
                            📌 {act.location}
                            &nbsp;&middot;&nbsp;<a href={`https://maps.apple.com/?q=${encodeURIComponent(act.location)}&dirflg=d`} target="_blank" rel="noreferrer" style={{ color: T.sky, textDecoration: "none" }}>Navigate</a>
                          </div>}
                          {act.notes && <div style={{ color: T.textDim, fontSize: 11, marginTop: 3, fontStyle: "italic" }}>{act.notes}</div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
            {archived ? (
              <span style={{ ...pill(T.textDim + "20", T.textDim), fontSize: 11 }}>📦 Archived — read only</span>
            ) : itin.familyId === currentFamilyId ? (
              <DeleteButton label="Delete Trip" message={`Delete "${itin.title}"?`} detail="All planned activities will be lost." onConfirm={() => dispatch({ type: "DEL_ITINERARY", id: itin.id })} style={{ fontSize: 12 }} />
            ) : (
              <span style={{ fontSize: 12, color: T.textDim, fontStyle: "italic" }}>
                {itin.visibility === "shared" ? "Read-only — shared by " + families.find(f => f.id === itin.familyId)?.name : "Private trip"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BOOKING CARD (unified booking + trip) ────────────────────────────────────
function BookingTripCard({ b, fam, today, odoLog, odoRate, onAddOdo, dispatch, places, families, bookings, currentFamilyId, openId, setOpenId }) {
  const cardRef = useRef(null);
  const [expanded, setExpanded] = useState(openId === b.id);
  const [fullEdit, setFullEdit] = useState(false);
  const [showOdoForm, setShowOdoForm] = useState(false);
  const [odoForm, setOdoForm] = useState({ startKm: "", endKm: "", tolls: false, tollAmt: "", notes: "" });
  const [confirmWarn, setConfirmWarn] = useState(null);
  const [showReport, setShowReport] = useState(false);
  useEffect(() => {
    if (openId === b.id) { setExpanded(true); if (setOpenId) setOpenId(null); setTimeout(() => cardRef.current && cardRef.current.scrollIntoView({ behavior: "smooth", block: "start" }), 150); }
  }, [openId]); // null | {type:"blocked"|"warn", msg:string}

  const odo = (odoLog || []).filter(e => e.bookingId === b.id);
  const isUpcoming = b.end >= today;
  const isOwner = b.familyId === currentFamilyId;
  const nights_n = nights(b.start, b.end);
  const days = b.days || [];

  // Auto-create days if missing
  useEffect(() => {
    if (b.id && b.start && b.end && (!b.days || b.days.length === 0)) {
      dispatch({ type: "UPD_BOOKING_DAYS", payload: { id: b.id, days: generateDays(b.start, b.end) } });
    }
  }, [b.id]);

  // Shape booking as itin-compatible object for ItineraryEditor
  const bookingAsItin = {
    id: b.id, title: b.destination, familyId: b.familyId,
    start: b.start, end: b.end, destination: b.destination,
    notes: b.notes || "", days: b.days || [], bookingId: b.id, visibility: "private"
  };

  const handleItinSave = (payload) => {
    // Save days and notes back to the booking
    dispatch({ type: "UPD_BOOKING_DAYS", payload: { id: b.id, days: payload.days, notes: payload.notes } });
    // Also update dates if changed
    if (payload.start !== b.start || payload.end !== b.end) {
      dispatch({ type: "UPD_BOOKING", payload: { id: b.id, start: payload.start, end: payload.end, destination: payload.title || b.destination } });
    }
  };

  return (
    <div ref={cardRef} style={{ ...card({ padding: 0, marginBottom: 16 }), borderLeft: "4px solid " + (fam?.color || T.primary), overflow: "visible" }}>
      {showReport && <TripReport booking={b} places={places} vanName={null} guestName={b.guestName || b.guests || ""} onClose={() => setShowReport(false)} />}
      {/* Full editor modal */}
      {fullEdit && (
        <Modal title={"Plan: " + b.destination} onClose={() => setFullEdit(false)}>
          <ItineraryEditor
            itin={bookingAsItin}
            dispatch={(action) => {
              if (action.type === "SET_ITINERARY" || action.type === "UPDATE_ITINERARY")
                handleItinSave(action.payload);
            }}
            places={places} bookings={bookings} families={families}
            onClose={() => setFullEdit(false)} />
        </Modal>
      )}

      {/* ── Header ── */}
      <div style={{ padding: "14px 14px 10px", cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 16, color: T.text }}>{b.destination}</div>
            <div style={{ color: T.textMuted, fontSize: 12, marginTop: 3 }}>
              {b.start} → {b.end} · {nights_n} night{nights_n !== 1 ? "s" : ""}
            </div>
            {(b.collaborators || []).length > 0 && (
              <div style={{ display: "flex", gap: 4, marginTop: 5, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: T.textDim }}>{isOwner ? "with" : "booked by"}</span>
                {isOwner
                  ? (b.collaborators || []).map(id => { const cf = families.find(f => f.id === id); return cf ? <FamilyAvatar key={id} family={cf} size={18} fontSize={12} /> : null; })
                  : <FamilyAvatar family={families.find(f => f.id === b.familyId)} size={18} fontSize={12} />
                }
              </div>
            )}
            {b.guests && <div style={{ fontSize: 11, color: T.textDim, marginTop: 3 }}>👥 {b.guests}</div>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <span style={{
              ...pill(b.status === "tentative" ? T.accent + "20" : T.primary + "15",
                b.status === "tentative" ? T.accent : T.primary), fontSize: 10
            }}>
              {b.familyId === "maintenance" ? "🔧 maintenance" : b.status}
            </span>
            <span style={{ fontSize: 16, color: T.textDim, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: `1px solid ${T.borderLight}` }}>

          {/* ── Actions — owner only ── */}
          {isUpcoming && isOwner && (
            <div style={{ display: "flex", gap: 8, padding: "10px 14px", flexWrap: "wrap" }}>
              {b.status === "tentative" && !confirmWarn && (
                <button onClick={() => {
                  const confirmed = bookings.filter(bk => bk.id !== b.id && bk.status === "confirmed" && bk.end >= b.start && bk.start <= b.end);
                  if (confirmed.length) {
                    setConfirmWarn({ type: "blocked", msg: "Cannot confirm — van already confirmed for: " + confirmed.map(bk => bk.destination).join(", ") });
                    return;
                  }
                  const tentative = bookings.filter(bk => bk.id !== b.id && bk.status === "tentative" && bk.end >= b.start && bk.start <= b.end);
                  if (tentative.length) {
                    setConfirmWarn({ type: "warn", msg: "Another family has a tentative booking on these dates: " + tentative.map(bk => bk.destination).join(", ") });
                    return;
                  }
                  dispatch({ type: "CONFIRM_BOOKING", id: b.id });
                }} style={btn(T.primary, T.surface, { fontSize: 12 })}>✓ Confirm</button>
              )}
              {confirmWarn && (
                <div style={{
                  width: "100%", background: confirmWarn.type === "blocked" ? T.red + "12" : T.accent + "12",
                  border: `1px solid ${confirmWarn.type === "blocked" ? T.red + "40" : T.accent + "40"}`,
                  borderRadius: T.radiusSm, padding: "10px 12px"
                }}>
                  <p style={{ margin: "0 0 8px", fontSize: 12, color: confirmWarn.type === "blocked" ? T.red : T.accent, fontWeight: 600 }}>
                    {confirmWarn.type === "blocked" ? "⛔ " + confirmWarn.msg : "⚠️ " + confirmWarn.msg}
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    {confirmWarn.type === "warn" && (
                      <button onClick={() => { setConfirmWarn(null); dispatch({ type: "CONFIRM_BOOKING", id: b.id }); }}
                        style={btn(T.primary, T.surface, { fontSize: 11, padding: "4px 10px" })}>Confirm anyway</button>
                    )}
                    <button onClick={() => setConfirmWarn(null)}
                      style={btn("transparent", T.textMuted, { fontSize: 11, padding: "4px 10px", border: `1px solid ${T.border}` })}>
                      {confirmWarn.type === "blocked" ? "OK" : "Cancel"}
                    </button>
                  </div>
                </div>
              )}
              <DeleteButton label="Remove" message={`Remove ${b.destination}?`}
                detail={`${b.start} to ${b.end}`}
                onConfirm={() => dispatch({ type: "DEL_BOOKING", id: b.id })}
                style={{ fontSize: 12 }} />
            </div>
          )}

          {/* ── Collaborators — owner can edit ── */}
          {isOwner && (
            <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderLight}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>👥 Collaborators</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(families || []).filter(f => f.id !== b.familyId && f.id !== "maintenance").map(cf => {
                  const isCollab = (b.collaborators || []).includes(cf.id);
                  return (
                    <button key={cf.id} onClick={() => {
                      const next = isCollab ? (b.collaborators || []).filter(id => id !== cf.id) : [...(b.collaborators || []), cf.id];
                      dispatch({ type: "UPD_BOOKING_COLLAB", payload: { id: b.id, collaborators: next } });
                    }} style={{
                      ...btn(isCollab ? cf.color + "20" : "transparent", isCollab ? cf.color : T.textMuted,
                        {
                          fontSize: 12, padding: "5px 10px", border: `2px solid ${isCollab ? cf.color : T.border}`,
                          transition: "all 0.15s", display: "flex", alignItems: "center", gap: 4
                        })
                    }}>
                      <FamilyAvatar family={cf} size={16} fontSize={11} />
                      {cf.name.split(" ")[0]}
                      {isCollab && <span>✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Guest Access — owner can set/change PIN ── */}
          {isOwner && (
            <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderLight}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>🔑 Guest Access</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input style={{ ...inp, width: 90, letterSpacing: 6, fontSize: 14, fontWeight: 700 }} placeholder="PIN" maxLength={4}
                  value={b.guestPin || ""}
                  onChange={e => dispatch({ type: "UPD_BOOKING", payload: { id: b.id, guestPin: e.target.value.replace(/\D/g, "").slice(0, 4) } })}
                  onBlur={e => dispatch({ type: "UPD_BOOKING", payload: { id: b.id, guestPin: e.target.value.replace(/\D/g, "").slice(0, 4) } })} />
                <input style={{ ...inp, flex: 1 }} placeholder="Guest name e.g. The Hendersons"
                  value={b.guestName || ""}
                  onChange={e => dispatch({ type: "UPD_BOOKING", payload: { id: b.id, guestName: e.target.value } })}
                  onBlur={e => dispatch({ type: "UPD_BOOKING", payload: { id: b.id, guestName: e.target.value } })} />
              </div>
              {b.guestPin && b.guestPin.length === 4 && (
                <p style={{ fontSize: 11, color: T.primary, margin: "6px 0 0", fontWeight: 600 }}>
                  ✓ Guest PIN set — active until {fmt(new Date(new Date(b.end).getTime() + 21*24*60*60*1000))}
                </p>
              )}
              <p style={{ fontSize: 11, color: T.textDim, margin: "4px 0 0", lineHeight: 1.5 }}>
                Share this PIN with guests so they can sign in and plan their trip. Active for 3 weeks after the booking ends.
              </p>
            </div>
          )}

          {/* ── Guests — owner can edit ── */}
          {isOwner && (
            <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderLight}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>👥 Extra Guests</div>
              <input style={{ ...inp, fontSize: 12 }} placeholder="e.g. Sarah, Tom & kids" value={b.guests || ""}
                onChange={e => dispatch({ type: "UPD_BOOKING", payload: { id: b.id, guests: e.target.value } })}
                onBlur={e => dispatch({ type: "UPD_BOOKING", payload: { id: b.id, guests: e.target.value } })} />
              <p style={{ fontSize: 11, color: T.textDim, margin: "4px 0 0" }}>Names only — for your reference.</p>
            </div>
          )}

          {/* ── Odometer ── */}
          <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderLight}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>🔢 Odometer</span>
              {isUpcoming && isOwner && !showOdoForm && (
                <button onClick={() => setShowOdoForm(true)}
                  style={btn(T.primary + "10", T.primary, { fontSize: 10, padding: "3px 8px", border: `1px solid ${T.primary}20` })}>+ Add Reading</button>
              )}
            </div>
            {odo.map((e, i) => {
              const km = e.endKm - e.startKm;
              const cost = km * (odoRate || 0.30) + (e.tolls || 0);
              return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8, marginBottom: 4,
                  padding: "6px 10px", borderRadius: T.radiusSm,
                  background: e.paid ? T.green + "10" : T.accent + "08",
                  border: `1px solid ${e.paid ? T.green + "30" : T.accent + "20"}`
                }}>
                  <div style={{ flex: 1, fontSize: 12 }}>
                    <span style={{ fontWeight: 700, color: T.primary }}>{km.toLocaleString()} km</span>
                    <span style={{ color: T.textDim, marginLeft: 6, fontSize: 11 }}>{e.startKm.toLocaleString()} → {e.endKm.toLocaleString()}</span>
                    <span style={{ fontWeight: 700, color: e.paid ? T.green : T.accent, marginLeft: 6 }}>${cost.toFixed(2)}</span>
                    {(e.tolls || 0) > 0 && <span style={{ color: T.textDim, fontSize: 11, marginLeft: 4 }}>(+${Number(e.tolls).toFixed(2)} tolls)</span>}
                    {e.notes && <span style={{ color: T.textDim, fontSize: 11, marginLeft: 6, fontStyle: "italic" }}>{e.notes}</span>}
                  </div>
                  <button onClick={() => onAddOdo && onAddOdo({ _action: "MARK_PAID", id: e.id })}
                    style={btn(e.paid ? T.green + "20" : T.accent + "15", e.paid ? T.green : T.accent,
                      { fontSize: 10, padding: "3px 8px", border: `1px solid ${e.paid ? T.green + "40" : T.accent + "30"}` })}>
                    {e.paid ? "✓ Paid" : "To Pay"}
                  </button>
                </div>
              );
            })}
            {odo.length === 0 && !showOdoForm && <p style={{ fontSize: 11, color: T.textDim, fontStyle: "italic", margin: 0 }}>No readings logged</p>}
            {showOdoForm && (
              <div style={{ marginTop: 8, background: T.bg, borderRadius: T.radiusSm, padding: 10, border: `1px solid ${T.border}` }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 6 }}>
                  <div><label style={{ ...lbl, marginTop: 0 }}>Start km</label>
                    <input style={inp} type="number" placeholder="45230" value={odoForm.startKm} onChange={ev => setOdoForm(f => ({ ...f, startKm: ev.target.value }))} /></div>
                  <div><label style={{ ...lbl, marginTop: 0 }}>End km</label>
                    <input style={inp} type="number" placeholder="45480" value={odoForm.endKm} onChange={ev => setOdoForm(f => ({ ...f, endKm: ev.target.value }))} /></div>
                </div>
                {odoForm.startKm && odoForm.endKm && parseFloat(odoForm.endKm) > parseFloat(odoForm.startKm) && (
                  <p style={{ fontSize: 11, color: T.primary, fontWeight: 700, margin: "0 0 6px" }}>
                    {(parseFloat(odoForm.endKm) - parseFloat(odoForm.startKm)).toLocaleString()} km
                    · ${((parseFloat(odoForm.endKm) - parseFloat(odoForm.startKm)) * (odoRate || 0.30) + (odoForm.tolls ? parseFloat(odoForm.tollAmt || 0) : 0)).toFixed(2)}
                  </p>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                    <input type="checkbox" checked={odoForm.tolls} onChange={ev => setOdoForm(f => ({ ...f, tolls: ev.target.checked, tollAmt: ev.target.checked ? f.tollAmt : "" }))} /> Tolls?
                  </label>
                  {odoForm.tolls && <input style={{ ...inp, width: 90 }} type="number" step="0.10" placeholder="$0.00"
                    value={odoForm.tollAmt} onChange={ev => setOdoForm(f => ({ ...f, tollAmt: ev.target.value }))} />}
                </div>
                <input style={{ ...inp, marginBottom: 8 }} placeholder="Notes (optional)" value={odoForm.notes} onChange={ev => setOdoForm(f => ({ ...f, notes: ev.target.value }))} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => {
                    const sk = parseFloat(odoForm.startKm);
                    const ek = parseFloat(odoForm.endKm);
                    if (!odoForm.startKm || !odoForm.endKm || isNaN(sk) || isNaN(ek)) {
                      alert("Please enter both start and end km."); return;
                    }
                    if (ek <= sk) { alert("End km must be greater than start km."); return; }
                    const entry = {
                      id: "odo" + Date.now(), familyId: b.familyId,
                      date: b.start, startKm: sk, endKm: ek,
                      tolls: odoForm.tolls ? parseFloat(odoForm.tollAmt || 0) : 0,
                      paid: false, notes: odoForm.notes, bookingId: b.id
                    };
                    if (onAddOdo) { onAddOdo(entry); }
                    else { dispatch({ type: "ADD_ODO", payload: entry }); }
                    setOdoForm({ startKm: "", endKm: "", tolls: false, tollAmt: "", notes: "" }); setShowOdoForm(false);
                  }} style={btn(T.primary, T.surface, { fontSize: 12, flex: 1 })}>Save</button>
                  <button onClick={() => setShowOdoForm(false)}
                    style={btn("transparent", T.textMuted, { fontSize: 12, border: `1px solid ${T.border}` })}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* ── Trip Plan (days) ── */}
          <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderLight}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.5 }}>🗺️ Trip Plan</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setShowReport(true)}
                  style={btn(T.accent + "10", T.accent, { fontSize: 10, padding: "3px 8px", border: `1px solid ${T.accent}20` })}>
                  📄 Report
                </button>
                <button onClick={() => setFullEdit(true)}
                  style={btn(T.primary + "10", T.primary, { fontSize: 10, padding: "3px 8px", border: `1px solid ${T.primary}20` })}>
                  ✏️ Edit Plan
                </button>
              </div>
            </div>
            {days.length === 0 ? (
              <p style={{ fontSize: 11, color: T.textDim, fontStyle: "italic", margin: 0 }}>No plan yet — tap Edit Plan to add activities.</p>
            ) : (
              days.map((day, di) => {
                const acts = day.activities || [];
                const d = new Date(day.date + "T12:00:00");
                const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
                return (
                  <div key={di} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, marginBottom: 4 }}>
                      {dayName} {day.date}
                    </div>
                    {acts.length === 0 ? (
                      <p style={{ fontSize: 11, color: T.textDim, fontStyle: "italic", margin: 0, paddingLeft: 8 }}>Nothing planned</p>
                    ) : (
                      acts.map((act, ai) => (
                        <div key={ai} style={{
                          display: "flex", gap: 8, padding: "4px 8px", marginBottom: 3,
                          borderRadius: T.radiusSm, background: T.bg, border: `1px solid ${T.borderLight}`
                        }}>
                          {act.time && <span style={{ fontSize: 11, color: T.textDim, minWidth: 36 }}>{act.time}</span>}
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{act.title}</span>
                            {act.place && <span style={{ fontSize: 11, color: T.primary, marginLeft: 6 }}>📍{act.place}</span>}
                            {act.notes && <span style={{ fontSize: 11, color: T.textDim, marginLeft: 6, fontStyle: "italic" }}>{act.notes}</span>}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })
            )}
          </div>

        </div>
      )}
    </div>
  );
}

// ─── OUR TRIPS PANEL ──────────────────────────────────────────────────────────
function TripsPanel({ bookings, dispatch, places, families, currentFamilyId, odoLog, odoRate, onAddOdo, autoOpenItinId, onAutoOpenHandled }) {
  const [showPast, setShowPast] = useState(false);
  const [openId, setOpenId] = useState(autoOpenItinId || null);

  useEffect(() => {
    if (autoOpenItinId) {
      setOpenId(autoOpenItinId);
      const isPast = past.some(b => b.id === autoOpenItinId);
      if (isPast) setShowPast(true);
      onAutoOpenHandled && onAutoOpenHandled();
    }
  }, [autoOpenItinId]);

  const fam = families.find(f => f.id === currentFamilyId);
  const today = fmt(new Date());
  const myBookings = [...bookings]
    .filter(b => b.familyId === currentFamilyId || (b.collaborators || []).includes(currentFamilyId))
    .sort((a, b) => a.start.localeCompare(b.start));
  const upcoming = myBookings.filter(b => b.end >= today);
  const past = myBookings.filter(b => b.end < today);

  const cardProps = { fam, today, odoLog, odoRate, onAddOdo, dispatch, places, families, bookings, currentFamilyId, openId, setOpenId };

  return (
    <div>
      {upcoming.length === 0 && (
        <div style={{ ...card({ padding: 24, textAlign: "center" }) }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🗺️</div>
          <p style={{ color: T.textDim, margin: "0 0 8px", fontSize: 14 }}>No upcoming trips for {fam?.name}.</p>
          <p style={{ color: T.textDim, fontSize: 12, margin: 0 }}>Tap <b>+ BOOK</b> to get started.</p>
        </div>
      )}
      {upcoming.map(b => <BookingTripCard key={b.id} b={b} {...cardProps} />)}
      {past.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowPast(!showPast)}
            style={btn("transparent", T.textMuted, {
              width: "100%", display: "flex", justifyContent: "space-between",
              alignItems: "center", padding: "10px 14px", border: `1px solid ${T.border}`,
              borderRadius: showPast ? `${T.radius} ${T.radius} 0 0` : T.radius
            })}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>📦 Past Trips ({past.length})</span>
            <span style={{ fontSize: 11, transform: showPast ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
          </button>
          {showPast && (
            <div style={{
              border: `1px solid ${T.border}`, borderTop: "none",
              borderRadius: `0 0 ${T.radius} ${T.radius}`, padding: 12
            }}>
              {past.map(b => <BookingTripCard key={b.id} b={b} {...cardProps} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ─── GUIDES ───────────────────────────────────────────────────────────
// How-to guides with attachments and links

function GuideLinksEditor({ links, setLinks }) {
  return (
    <div>{(links || []).map((l, i) => (
      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <input style={{ ...inp, flex: 1, padding: "6px 10px", fontSize: 12 }} placeholder="Label" value={l.label} onChange={e => { const nl = [...links]; nl[i] = { ...nl[i], label: e.target.value }; setLinks(nl); }} />
        <input style={{ ...inp, flex: 2, padding: "6px 10px", fontSize: 12 }} placeholder="https://..." value={l.url} onChange={e => { const nl = [...links]; nl[i] = { ...nl[i], url: e.target.value }; setLinks(nl); }} />
        <button onClick={() => setLinks(links.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: T.red, fontSize: 18 }}>&times;</button>
      </div>
    ))}<button onClick={() => setLinks([...(links || []), { label: "", url: "" }])} style={{ ...btn(T.bg, T.textMuted, { fontSize: 11, padding: "5px 10px", border: `1px solid ${T.border}` }) }}>+ Link</button></div>
  );
}
function GuideAttList({ atts, onRemove }) {
  if (!atts?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>{atts.map((a, i) => (
      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, background: T.bg, borderRadius: T.radiusSm, padding: "6px 10px", marginBottom: 4, border: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 12, flex: 1, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{a.name}</span>
        <button onClick={() => {
          if (a.data.startsWith("http")) { window.open(a.data, "_blank"); }
          else { try { const byteStr = atob(a.data.split(",")[1]); const ab = new ArrayBuffer(byteStr.length); const ia = new Uint8Array(ab); for (let i = 0; i < byteStr.length; i++)ia[i] = byteStr.charCodeAt(i); const blob = new Blob([ab], { type: a.type || "application/octet-stream" }); const url = URL.createObjectURL(blob); window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 10000); } catch (e) { window.open(a.data, "_blank"); } }
        }} style={{ fontSize: 12, color: T.primary, fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0, flexShrink: 0 }}>
          {a.type === "application/pdf" ? "Open PDF" : "View"}
        </button>
        {onRemove && <button onClick={() => onRemove(i)} style={{ background: "none", border: "none", cursor: "pointer", color: T.red, fontSize: 14, flexShrink: 0 }}>&times;</button>}
      </div>
    ))}</div>
  );
}
const GUIDE_ICONS = ["📖", "🔑", "🔌", "💧", "🔥", "🚽", "☀️", "🛠️", "⚠️", "📄", "🗺️", "🔋", "🧰", "📷"];
function GuideForm({ form, setForm, onSave, onCancel, onDel, onFileUpload, uploading }) {
  return (
    <div style={{ ...card({ padding: 18, marginBottom: 8 }), border: `1px solid ${T.primary}30` }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 14, padding: 8, background: T.bg, borderRadius: T.radiusSm, border: `1px solid ${T.border}` }}>
        {GUIDE_ICONS.map(ic => <button key={ic} onClick={() => setForm(f => ({ ...f, icon: ic }))} style={{ fontSize: 22, background: form.icon === ic ? T.surface : "transparent", border: `1px solid ${form.icon === ic ? T.border : "transparent"}`, borderRadius: 8, cursor: "pointer", padding: "6px 8px", boxShadow: form.icon === ic ? T.shadow : "none" }}>{ic}</button>)}
      </div>
      <input style={inp} placeholder="Guide title *" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
      <label style={lbl}>Instructions</label>
      <textarea style={{ ...inp, height: 100, resize: "vertical" }} value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} />
      <label style={lbl}>External Links</label>
      <GuideLinksEditor links={form.links || []} setLinks={ls => setForm(f => ({ ...f, links: ls }))} />
      <label style={lbl}>Attachments</label>
      <GuideAttList atts={form.attachments} onRemove={i => setForm(f => ({ ...f, attachments: f.attachments.filter((_, j) => j !== i) }))} />
      <label style={{ ...btn(uploading ? T.textDim + "20" : T.bg, T.textMuted, { display: "inline-block", marginTop: 10, cursor: uploading ? "not-allowed" : "pointer", fontSize: 12, border: `1px solid ${T.border}` }) }}>
        {uploading ? "⏳ Uploading..." : "📎 Attach File"}<input type="file" accept=".pdf,image/*" style={{ display: "none" }} onChange={onFileUpload} disabled={uploading} />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button onClick={onSave} style={btn(T.primary, T.surface)}>Save</button>
        <button onClick={onCancel} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}` }) }}>Cancel</button>
        {onDel && <DeleteButton label="Delete" message={`Delete "${form.title}"?`} onConfirm={onDel} style={{ fontSize: 12 }} />}
      </div>
    </div>
  );
}

function GuidesPanel({ guides, dispatch, vanManual, onSetManual }) {
  const [open, setOpen] = useState(null); const [editing, setEditing] = useState(null); const [addingNew, setAddingNew] = useState(false);
  const [ef, setEf] = useState({}); const [nf, setNf] = useState({ title: "", icon: "📄", content: "", attachments: [], links: [] });
  const [search, setSearch] = useState("");
  const filtered = guides.filter(g => !search || g.title.toLowerCase().includes(search.toLowerCase()) || g.content.toLowerCase().includes(search.toLowerCase()) || g.links?.some(l => l.label?.toLowerCase().includes(search.toLowerCase())));
  const [uploading, setUploading] = useState(false);
  const handleFile = async (e, isNew) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert("File too large — max 5MB."); return; }
    setUploading(true);
    const addAtt = (data) => {
      const att = { name: file.name, type: file.type, data, size: file.size };
      if (isNew) setNf(f => ({ ...f, attachments: [...(f.attachments || []), att] }));
      else setEf(f => ({ ...f, attachments: [...(f.attachments || []), att] }));
    };
    try {
      const path = `guides/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const url = await supa.uploadImage(file, path);
      addAtt(url);
    } catch (err) {
      // Fall back to base64
      const r = new FileReader();
      r.onload = () => { addAtt(r.result); };
      r.onerror = () => alert("Failed to read file.");
      r.readAsDataURL(file);
    } finally { setUploading(false); }
  };
  return (
    <div>
      {/* ── Van Manual — pinned at top ── */}
      <div style={{ ...card({ padding: 14, marginBottom: 16 }), border: `2px solid ${T.primary}30`, background: T.primary + "06" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: vanManual ? 8 : 0 }}>
          <span style={{ fontSize: 22 }}>📋</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, color: T.primary, fontSize: 14 }}>Van Manual</div>
            <div style={{ fontSize: 11, color: T.textDim }}>Full owner's manual for the campervan</div>
          </div>
          <label style={{ ...btn(T.primary, T.surface, { fontSize: 11, padding: "5px 10px", cursor: "pointer" }) }}>
            {vanManual ? "Replace" : "Upload PDF"}
            <input type="file" accept=".pdf" style={{ display: "none" }} onChange={async e => {
              const file = e.target.files[0]; if (!file) return;
              if (file.size > 20 * 1024 * 1024) { alert("File too large — max 20MB."); return; }
              try {
                const path = `manuals/van-manual-${Date.now()}.pdf`;
                const url = await supa.uploadImage(file, path);
                onSetManual(url);
              } catch (err) {
                // Fall back to base64
                const r = new FileReader();
                r.onload = () => onSetManual(r.result);
                r.readAsDataURL(file);
              }
            }} />
          </label>
        </div>
        {vanManual && (
          <button onClick={() => {
            const a = document.createElement("a"); a.href = vanManual; a.target = "_blank"; a.click();
          }} style={{ ...btn(T.primary + "15", T.primary, { fontSize: 12, width: "100%", border: `1px solid ${T.primary}30` }) }}>
            📖 Open Van Manual
          </button>
        )}
        {!vanManual && <p style={{ fontSize: 11, color: T.textDim, margin: 0, marginTop: 4 }}>No manual uploaded yet.</p>}
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <input style={{ ...inp, flex: 1 }} placeholder="Search guides..." value={search}
          onChange={e => { setSearch(e.target.value); setOpen(null); }} />
        {search && <button onClick={() => setSearch("")} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}`, padding: "8px 12px", fontSize: 12 }) }}>Clear</button>}
        <button onClick={() => setAddingNew(true)} style={btn(T.primary, T.surface)}>+ Guide</button>
      </div>
      {search && <p style={{ color: T.textDim, fontSize: 12, margin: "0 0 10px" }}>{filtered.length} result{filtered.length !== 1 ? "s" : ""} for "{search}"</p>}
      {addingNew && <GuideForm form={nf} setForm={setNf} uploading={uploading} onFileUpload={e => handleFile(e, true)} onSave={() => { if (!nf.title) return; dispatch({ type: "ADD_GUIDE", payload: { ...nf, id: "g" + Date.now() } }); setAddingNew(false); setNf({ title: "", icon: "📄", content: "", attachments: [], links: [] }); }} onCancel={() => setAddingNew(false)} />}
      {!search && guides.length === 0 && <p style={{ color: T.textDim, fontSize: 13 }}>No guides yet. Add your first one!</p>}
      {search && filtered.length === 0 && <div style={{ ...card({ padding: 24, textAlign: "center" }) }}>
        <p style={{ color: T.textDim, margin: 0, fontSize: 14 }}>No guides match "{search}"</p>
      </div>}
      {(search ? filtered : guides).map(g => (
        <div key={g.id} style={{ marginBottom: 8 }}>
          {editing === g.id
            ? <GuideForm form={ef} setForm={setEf} uploading={uploading} onFileUpload={e => handleFile(e, false)} onSave={() => { dispatch({ type: "UPDATE_GUIDE", payload: ef }); setEditing(null); }} onCancel={() => setEditing(null)} onDel={() => { dispatch({ type: "DEL_GUIDE", id: g.id }); setEditing(null); }} />
            : (<div style={card({ padding: 0, overflow: "hidden" })}>
              <button onClick={() => setOpen(open === g.id ? null : g.id)}
                style={{ width: "100%", background: "transparent", border: "none", padding: "11px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left" }} onMouseEnter={e => e.currentTarget.style.background = T.cardHover} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontWeight: 600, color: T.text, fontSize: 14 }}>
                  {g.icon} {search && g.title.toLowerCase().includes(search.toLowerCase())
                    ? <>{g.title.slice(0, g.title.toLowerCase().indexOf(search.toLowerCase()))}<mark style={{ background: T.yellow + "60", borderRadius: 3, padding: "0 1px" }}>{g.title.slice(g.title.toLowerCase().indexOf(search.toLowerCase()), g.title.toLowerCase().indexOf(search.toLowerCase()) + search.length)}</mark>{g.title.slice(g.title.toLowerCase().indexOf(search.toLowerCase()) + search.length)}</>
                    : g.title}
                </span>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {((g.attachments?.length || 0) + (g.links?.length || 0)) > 0 && <span style={{ ...pill(T.accent + "15", T.accent), fontSize: 10 }}>{(g.attachments?.length || 0) + (g.links?.length || 0)} files</span>}
                  {search && !g.title.toLowerCase().includes(search.toLowerCase()) && g.content.toLowerCase().includes(search.toLowerCase()) && <span style={{ ...pill(T.yellow + "40", "#856404"), fontSize: 10 }}>match in content</span>}
                  <span style={{ color: T.textDim, transform: open === g.id ? "rotate(90deg)" : "none", transition: "transform 0.2s", fontSize: 20 }}>&#8250;</span>
                </div>
              </button>
              {open === g.id && (
                <div style={{ padding: "0 18px 18px", borderTop: `1px solid ${T.border}` }}>
                  <pre style={{ margin: "14px 0 12px", whiteSpace: "pre-wrap", fontSize: 13, color: T.textMuted, lineHeight: 1.8, fontFamily: "inherit" }}>{g.content}</pre>
                  {(g.links || []).length > 0 && <div style={{ marginBottom: 12 }}><p style={{ ...sectionHead, marginBottom: 8 }}>Links</p>{g.links.map((l, i) => <a key={i} href={l.url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: T.sky, fontSize: 13, marginBottom: 6, textDecoration: "none", marginRight: 12 }}>{l.label || l.url}</a>)}</div>}
                  <GuideAttList atts={g.attachments} />
                  <button onClick={() => { setEditing(g.id); setEf({ ...g }); }} style={{ ...btn(T.bg, T.textMuted, { fontSize: 12, marginTop: 12, border: `1px solid ${T.border}` }) }}>Edit</button>
                </div>
              )}
            </div>
            )}
        </div>
      ))}
    </div>
  );
}

// KIT & PACKING — unified panel
const STATUS_TABS = [
  { id: "all", label: "All", color: T.primary },
  { id: "invan", label: "In Van", color: T.green },
  { id: "tobring", label: "To Pack", color: T.accent },
  { id: "packed", label: "Packed ✓", color: T.sky },
];
const CAT_ICONS = { Sleeping: "🛏️", Kitchen: "🍳", Power: "⚡", Water: "💧", Sanitation: "🚽", Outdoor: "🏕️", Outdoors: "🏕️", Safety: "🛡️", Bedding: "🛏️", Hygiene: "🚿", Kids: "🧸", Other: "📦" };
const catIcon = cat => CAT_ICONS[cat] || "📦";


// ─── KIT & PACKING ────────────────────────────────────────────────────
// Shared van equipment and per-family packing lists

function KitPanel({ equipment, dispatch, currentFamilyId, packingByFamily }) {
  const STATUS_TABS = [
    { id: "all", label: "All", color: T.primary },
    { id: "invan", label: "In Van", color: T.green },
    { id: "tobring", label: "To Pack", color: T.accent },
    { id: "packed", label: "Packed ✓", color: T.sky },
  ];
  const [statusTab, setStatusTab] = useState("all");
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState({});
  const [newItem, setNewItem] = useState({ item: "", category: "", status: "tobring" });
  const [newCat, setNewCat] = useState("");
  const [showAddCat, setShowAddCat] = useState(false);

  const setVanKit = p => dispatch({ type: "SET_EQUIPMENT", payload: p });

  // Per-family packing list (tobring + packed items personal to this family)
  const myPacking = packingByFamily[currentFamilyId] || [
    // Seed default packing items for new families from the original tobring items
    { id: "bp1", category: "Bedding", item: "Pillows", status: "tobring" },
    { id: "bp2", category: "Bedding", item: "Sleeping bag", status: "tobring" },
    { id: "bp3", category: "Hygiene", item: "Towels", status: "tobring" },
    { id: "bp4", category: "Hygiene", item: "Toiletries", status: "tobring" },
    { id: "bp5", category: "Hygiene", item: "Toilet paper", status: "tobring" },
    { id: "bp6", category: "Kitchen", item: "Cooking oil", status: "tobring" },
    { id: "bp7", category: "Kitchen", item: "Snacks", status: "tobring" },
    { id: "bp8", category: "Kitchen", item: "Coffee/tea", status: "tobring" },
    { id: "bp9", category: "Safety", item: "Medications", status: "tobring" },
    { id: "bp10", category: "Safety", item: "Cash", status: "tobring" },
  ];
  const setMyPacking = items => dispatch({ type: "SET_FAMILY_PACKING", payload: { familyId: currentFamilyId, items } });

  // Combined view: invan items from equipment, tobring/packed from myPacking
  const invanItems = equipment.filter(e => e.status === "invan");
  const allItems = statusTab === "invan"
    ? invanItems
    : statusTab === "all"
      ? [...invanItems, ...myPacking]
      : myPacking.filter(e => e.status === statusTab);

  const visible = allItems.filter(e => {
    const matchSearch = !search || e.item.toLowerCase().includes(search.toLowerCase()) || e.category.toLowerCase().includes(search.toLowerCase());
    return matchSearch;
  });

  const CATS = [...new Set(allItems.map(e => e.category))].sort();
  const grouped = CATS.reduce((acc, cat) => {
    const items = visible.filter(e => e.category === cat);
    if (items.length) acc[cat] = items;
    return acc;
  }, {});

  // Packing progress — personal items only
  const packItems = myPacking;
  const packedCount = myPacking.filter(e => e.status === "packed").length;
  const packPct = packItems.length > 0 ? Math.round((packedCount / packItems.length) * 100) : 0;

  const cycleStatus = e => {
    if (e.status === "invan") return; // permanent — can't toggle
    const next = e.status === "tobring" ? "packed" : "tobring";
    if (invanItems.find(x => x.id === e.id)) return; // safety check
    setMyPacking(myPacking.map(x => x.id === e.id ? { ...x, status: next } : x));
  };

  const set = e => {
    // Route edits/deletes to the right store based on status
    if (e === null) return;
    // Used for equipment (invan) editing
  };

  const statusDot = status => {
    if (status === "invan") return { bg: T.green, label: "In Van" };
    if (status === "packed") return { bg: T.sky, label: "Packed" };
    return { bg: T.accent, label: "To Pack" };
  };

  return (
    <div>
      {/* Packing progress bar — only shown when not filtering to "all invan" */}
      {packItems.length > 0 && (
        <div style={{ ...card({ padding: 12, marginBottom: 12 }) }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontWeight: 700, color: T.text, fontSize: 14 }}>🎒 My Packing Progress</span>
            <span style={{ fontWeight: 700, color: packedCount === packItems.length ? T.primary : T.textMuted, fontSize: 14 }}>
              {packedCount}/{packItems.length} — {packPct}%
            </span>
          </div>
          <div style={{ background: T.bg, borderRadius: 99, height: 8, overflow: "hidden", border: `1px solid ${T.border}` }}>
            <div style={{ width: `${packPct}%`, background: `linear-gradient(90deg,${T.primary},${T.primaryLight})`, height: "100%", borderRadius: 99, transition: "width 0.4s" }} />
          </div>
          {packedCount === packItems.length && packItems.length > 0 && <p style={{ margin: "8px 0 0", color: T.primary, fontSize: 12, fontWeight: 600, textAlign: "center" }}>All packed! 🎉</p>}
          {packedCount > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <DeleteButton
                label="Reset packed"
                message="Reset all packed items?"
                detail="All your packed items will go back to 'To Pack'."
                onConfirm={() => setMyPacking(myPacking.map(p => p.status === "packed" ? { ...p, status: "tobring" } : p))}
                style={{ fontSize: 12, padding: "5px 12px" }}
              />
            </div>
          )}
        </div>
      )}

      {/* Status filter tabs */}
      <div style={{ display: "flex", gap: 4, background: T.bg, padding: 4, borderRadius: T.radiusSm, border: `1px solid ${T.border}`, marginBottom: 12 }}>
        {STATUS_TABS.map(t => (
          <button key={t.id} onClick={() => setStatusTab(t.id)}
            style={{
              flex: 1, padding: "7px 4px", border: "none", borderRadius: 6, cursor: "pointer",
              fontSize: 11, fontWeight: statusTab === t.id ? 700 : 500,
              background: statusTab === t.id ? T.surface : T.bg,
              color: statusTab === t.id ? t.color : T.textMuted,
              boxShadow: statusTab === t.id ? T.shadow : "none",
              whiteSpace: "nowrap"
            }}>
            {t.label}
            <span style={{ display: "block", fontSize: 10, opacity: 0.7, marginTop: 1 }}>
              {t.id === "all" ? equipment.length : equipment.filter(e => e.status === t.id).length}
            </span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input style={{ ...inp, flex: 1 }} placeholder="Search items..." value={search} onChange={e => setSearch(e.target.value)} />
        {search && <button onClick={() => setSearch("")} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}`, padding: "8px 12px", fontSize: 12 }) }}>Clear</button>}
      </div>

      {/* Grouped items */}
      {Object.entries(grouped).map(([cat, items]) => {
        const invanCount = items.filter(i => i.status === "invan").length;
        const packedCatCount = items.filter(i => i.status === "packed").length;
        const tobringCount = items.filter(i => i.status === "tobring").length;
        return (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: `2px solid ${T.accent}25` }}>
              <span style={{ fontSize: 16 }}>{catIcon(cat)}</span>
              <h4 style={{ margin: 0, color: T.accent, fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, flex: 1 }}>{cat}</h4>
              {invanCount > 0 && <span style={{ ...pill(T.green + "20", T.green), fontSize: 10 }}>{invanCount} in van</span>}
              {tobringCount > 0 && <span style={{ ...pill(T.accent + "20", T.accent), fontSize: 10 }}>{tobringCount} to pack</span>}
              {packedCatCount > 0 && <span style={{ ...pill(T.sky + "20", T.sky), fontSize: 10 }}>{packedCatCount} packed</span>}
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {items.map(e => {
                const dot = statusDot(e.status);
                const isEdit = editId === e.id;
                return (
                  <div key={e.id} style={{
                    ...card({ padding: "10px 12px" }), display: "flex", gap: 10, alignItems: "center",
                    opacity: e.status === "packed" ? 0.65 : 1,
                    borderLeft: `3px solid ${dot.bg}`
                  }}>
                    {/* Status toggle dot — tap to cycle tobring<->packed */}
                    <button onClick={() => cycleStatus(e)} title={e.status === "invan" ? "Permanently in van" : "Tap to toggle packed"}
                      style={{
                        width: 22, height: 22, borderRadius: 6, background: dot.bg + "25", border: `2px solid ${dot.bg}`,
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        cursor: e.status === "invan" ? "default" : "pointer", padding: 0
                      }}>
                      {e.status === "packed" && <span style={{ color: dot.bg, fontSize: 13, fontWeight: 800, lineHeight: 1 }}>✓</span>}
                      {e.status === "invan" && <span style={{ color: dot.bg, fontSize: 11, lineHeight: 1 }}>★</span>}
                    </button>
                    {isEdit ? (
                      <>
                        <input style={{ ...inp, flex: 1, padding: "4px 8px", fontSize: 13 }} value={editVal.item || ""}
                          onChange={ev => setEditVal(v => ({ ...v, item: ev.target.value }))} autoFocus
                          onKeyDown={ev => { if (ev.key === "Enter") { set(equipment.map(x => x.id === e.id ? { ...x, ...editVal } : x)); setEditId(null); } if (ev.key === "Escape") setEditId(null); }} />
                        <select style={{ ...inp, width: "auto", padding: "4px 6px", fontSize: 12 }} value={editVal.status || e.status}
                          onChange={ev => setEditVal(v => ({ ...v, status: ev.target.value }))}>
                          <option value="invan">In Van</option>
                          <option value="tobring">To Pack</option>
                          <option value="packed">Packed</option>
                        </select>
                        <button onClick={() => { if (e.status === "invan" || editVal.status === "invan") setVanKit(equipment.map(x => x.id === e.id ? { ...x, ...editVal } : x)); else setMyPacking(myPacking.map(x => x.id === e.id ? { ...x, ...editVal } : x)); setEditId(null); }}
                          style={{ ...btn(T.primary + "15", T.primary, { padding: "3px 8px", fontSize: 11 }) }}>ok</button>
                        <button onClick={() => setEditId(null)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: T.textDim, fontSize: 16, padding: "0 2px" }}>&times;</button>
                      </>
                    ) : (
                      <>
                        <span
                          onClick={() => cycleStatus(e)}
                          style={{
                            flex: 1, color: e.status === "packed" ? T.textDim : T.text, fontSize: 13,
                            textDecoration: e.status === "packed" ? "line-through" : "none",
                            cursor: e.status !== "invan" ? "pointer" : "default"
                          }}>
                          {e.item}
                        </span>
                        <button onClick={() => { setEditId(e.id); setEditVal({ item: e.item, category: e.category, status: e.status }); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: T.textDim, fontSize: 12, padding: "0 2px", flexShrink: 0 }}>edit</button>
                        <button onClick={() => { if (e.status === "invan") setVanKit(equipment.filter(x => x.id !== e.id)); else setMyPacking(myPacking.filter(x => x.id !== e.id)); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: T.red + "80", fontSize: 14, padding: "0 2px", flexShrink: 0 }}>&times;</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {Object.keys(grouped).length === 0 && (
        <div style={{ ...card({ padding: 24, textAlign: "center" }) }}>
          <p style={{ color: T.textDim, margin: 0, fontSize: 14 }}>
            {search ? `Nothing found for "${search}"` : "No items in this view."}
          </p>
        </div>
      )}

      {/* Add item */}
      <div style={{ ...card({ padding: 14 }), marginTop: 4 }}>
        <p style={{ ...sectionHead, marginBottom: 10 }}>Add Item</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <input style={inp} placeholder="Item name *" value={newItem.item} onChange={e => setNewItem(n => ({ ...n, item: e.target.value }))}
            onKeyDown={e => { if (e.key === "Enter" && newItem.item.trim() && newItem.category) { set([...equipment, { id: "e" + Date.now(), ...newItem }]); setNewItem(n => ({ ...n, item: "" })); } }} />
          <select style={inp} value={newItem.category} onChange={e => setNewItem(n => ({ ...n, category: e.target.value }))}>
            <option value="">Category...</option>
            {[...new Set([...CATS, ...(myPacking || []).map(e => e.category)])].sort().map(cat => <option key={cat}>{cat}</option>)}
            <option value="__new__">+ New category</option>
          </select>
        </div>
        {newItem.category === "__new__" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input style={inp} placeholder="New category name" value={newCat} onChange={e => setNewCat(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && newCat.trim()) { setNewItem(n => ({ ...n, category: newCat })); setNewCat(""); } }} />
            <button onClick={() => { if (newCat.trim()) { setNewItem(n => ({ ...n, category: newCat })); setNewCat(""); } }}
              style={btn(T.primary, T.surface, { flexShrink: 0 })}>Use</button>
          </div>
        )}
        {/* Status selector for new item */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {[["invan", "★ In Van", T.green], ["tobring", "📦 To Pack", T.accent], ["packed", "✓ Packed", T.sky]].map(([s, l, col]) => (
            <button key={s} onClick={() => setNewItem(n => ({ ...n, status: s }))}
              style={{
                flex: 1, padding: "6px 4px", border: `2px solid ${newItem.status === s ? col : T.border}`, borderRadius: T.radiusSm,
                cursor: "pointer", fontSize: 11, fontWeight: newItem.status === s ? 700 : 500,
                background: newItem.status === s ? col + "15" : T.surface, color: newItem.status === s ? col : T.textMuted
              }}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={() => {
          if (!newItem.item.trim() || !newItem.category || newItem.category === "__new__") return;
          const item = { id: "e" + Date.now(), ...newItem };
          if (newItem.status === "invan") setVanKit([...equipment, item]);
          else setMyPacking([...myPacking, item]);
          setNewItem(n => ({ ...n, item: "" }));
        }}
          disabled={!newItem.item.trim() || !newItem.category || newItem.category === "__new__"}
          style={{ ...btn(T.primary, T.surface, { width: "100%" }), opacity: (!newItem.item.trim() || !newItem.category || newItem.category === "__new__") ? 0.5 : 1 }}>
          Add Item
        </button>
      </div>
    </div>
  );
}


// ─── RULES ────────────────────────────────────────────────────────────
// Shared van rules — displayed and editable by all

function RulesPanel({ rules, dispatch }) {
  const [editId, setEditId] = useState(null); const [ef, setEf] = useState({}); const [adding, setAdding] = useState(false); const [nf, setNf] = useState({ icon: "📌", rule: "", detail: "" });
  const set = r => dispatch({ type: "SET_RULES", payload: r });
  const ICONS = ["📅", "⏱️", "🔁", "🧹", "⛽", "🛑", "🔧", "🤝", "✏️", "📌", "⚠️", "💡", "🔒", "🏆", "💬"];
  const Form = ({ form, setForm, onSave, onCancel, onDel }) => (
    <div style={{ ...card({ padding: 16, marginBottom: 12, border: `1px solid ${T.primary}25` }) }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 14, padding: 8, background: T.bg, borderRadius: T.radiusSm, border: `1px solid ${T.border}` }}>{ICONS.map(ic => <button key={ic} onClick={() => setForm(f => ({ ...f, icon: ic }))} style={{ fontSize: 20, background: form.icon === ic ? T.surface : "transparent", border: `1px solid ${form.icon === ic ? T.border : "transparent"}`, borderRadius: 8, cursor: "pointer", padding: "5px 8px", boxShadow: form.icon === ic ? T.shadow : "none" }}>{ic}</button>)}</div>
      <input style={inp} placeholder="Rule title *" value={form.rule} onChange={e => setForm(f => ({ ...f, rule: e.target.value }))} />
      <textarea style={{ ...inp, height: 72, marginTop: 8 }} placeholder="Explain the rule..." value={form.detail} onChange={e => setForm(f => ({ ...f, detail: e.target.value }))} />
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button onClick={onSave} style={btn(T.primary, T.surface)}>Save</button>
        <button onClick={onCancel} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}` }) }}>Cancel</button>
        {onDel && <DeleteButton label="Delete" message={`Delete rule "${form.rule}"?`} onConfirm={onDel} style={{ fontSize: 12 }} />}
      </div>
    </div>
  );
  return (
    <div>
      <div style={{ ...card({ padding: 14, marginBottom: 16, background: T.primary + "08", border: `1px solid ${T.primary}20` }) }}>
        <p style={{ margin: 0, fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>Shared family rules to keep everything fair and fun. Edit together.</p>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button onClick={() => setAdding(true)} style={btn(T.primary, T.surface)}>+ Add Rule</button>
      </div>
      {adding && <Form form={nf} setForm={setNf} onSave={() => { if (!nf.rule) return; set([...rules, { ...nf, id: "r" + Date.now() }]); setAdding(false); setNf({ icon: "📌", rule: "", detail: "" }); }} onCancel={() => setAdding(false)} />}
      {rules.map(r => editId === r.id
        ? <Form key={r.id} form={ef} setForm={setEf} onSave={() => { set(rules.map(x => x.id === r.id ? { ...x, ...ef } : x)); setEditId(null); }} onCancel={() => setEditId(null)} onDel={() => { set(rules.filter(x => x.id !== r.id)); setEditId(null); }} />
        : (<div key={r.id} style={{ ...card({ padding: 12, marginBottom: 8, cursor: "default" }), display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{ fontSize: 26, flexShrink: 0, width: 40, height: 40, background: T.primary + "10", borderRadius: T.radiusSm, display: "flex", alignItems: "center", justifyContent: "center" }}>{r.icon}</div>
          <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: T.text, fontSize: 14 }}>{r.rule}</div><div style={{ color: T.textMuted, fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{r.detail}</div></div>
          <button onClick={() => { setEditId(r.id); setEf({ ...r }); }} style={{ ...btn(T.bg, T.textMuted, { fontSize: 12, border: `1px solid ${T.border}`, padding: "5px 10px" }) }}>✏️ Edit</button>
        </div>
        )
      )}
    </div>
  );
}


// FAMILY MANAGER — add, edit, remove families with photo + emoji + colour + PIN
const FAMILY_COLORS = ["#2d6a4f", "#e07a28", "#4a90c4", "#c9a96e", "#9b5de5", "#f72585", "#0077b6", "#606c38"];
const FAMILY_EMOJIS = ["🏔️", "🌊", "🌿", "🦅", "🏄", "🎣", "🚵", "🌻", "🦜", "🏕️", "⛵", "🌺"];


// ─── FAMILY MANAGER ───────────────────────────────────────────────────
// Add, edit, remove families and change PINs

function FamilyManager({ families, dispatch, currentFamilyId }) {
  const [editing, setEditing] = useState(null); // family id being edited, or "new"
  const [form, setForm] = useState({});
  const [confirmDel, setConfirmDel] = useState(null); // family pending removal
  const [adminPin, setAdminPin] = useState("");
  const [adminError, setAdminError] = useState("");

  const startEdit = (f) => { setEditing(f.id); setForm({ ...f, pinInput: "" }); };
  const startNew = () => {
    const idx = (families || []).length;
    const newF = { id: "f" + Date.now(), name: "", color: FAMILY_COLORS[idx % FAMILY_COLORS.length], emoji: FAMILY_EMOJIS[idx % FAMILY_EMOJIS.length], pin: "0000", photo: null };
    setEditing("new"); setForm({ ...newF, pinInput: "" });
  };
  const cancel = () => { setEditing(null); setForm({}); };

  const save = () => {
    if (!form.name.trim()) return;
    const pinToSave = form.pinInput.length === 4 ? form.pinInput : form.pin;
    const saved = { ...form, pin: pinToSave, homeTab: form.homeTab || "calendar" };
    delete saved.pinInput;
    if (editing === "new") dispatch({ type: "ADD_FAMILY", payload: saved });
    else dispatch({ type: "UPDATE_FAMILY", payload: saved });
    cancel();
  };

  const handlePhoto = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const path = `families/${editing || "new"}-${Date.now()}.${file.name.split(".").pop()}`;
      const url = await supa.uploadImage(file, path);
      setForm(f => ({ ...f, photo: url }));
    } catch (err) {
      const r = new FileReader();
      r.onload = ev => setForm(f => ({ ...f, photo: ev.target.result }));
      r.readAsDataURL(file);
    }
  };

  const isOwn = id => id === currentFamilyId;

  return (
    <div style={{ ...card({ padding: 14, marginBottom: 12 }) }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <p style={{ ...sectionHead, margin: 0 }}>All Families</p>
        <button onClick={startNew} style={btn(T.primary, T.surface)}>+ Add Family</button>
      </div>

      {/* Add / Edit form */}
      {editing && (
        <div style={{ background: T.bg, borderRadius: T.radiusSm, padding: 18, border: `1.5px solid ${form.color || T.border}`, marginBottom: 16 }}>
          <p style={{ fontWeight: 700, color: T.text, fontSize: 14, margin: "0 0 16px" }}>{editing === "new" ? "New Family" : "Edit Family"}</p>

          {/* Photo + emoji row */}
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 14 }}>
            {/* Photo upload */}
            <div>
              <div onClick={() => document.getElementById("fam-photo-input").click()}
                style={{ width: 72, height: 72, borderRadius: "50%", overflow: "hidden", border: `3px solid ${form.color || T.border}`, background: form.color + "20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, cursor: "pointer", position: "relative" }}>
                {form.photo
                  ? <img src={form.photo} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="" />
                  : <span>{form.emoji}</span>
                }
              </div>
              <input id="fam-photo-input" type="file" accept="image/*" style={{ display: "none" }} onChange={handlePhoto} />
              <button onClick={() => document.getElementById("fam-photo-input").click()} style={{ ...btn("transparent", T.textDim, { fontSize: 10, padding: "3px 0", border: "none", marginTop: 4, display: "block", width: "100%", textAlign: "center" }) }}>
                {form.photo ? "Change" : "Add photo"}
              </button>
              {form.photo && <button onClick={() => setForm(f => ({ ...f, photo: null }))} style={{ ...btn("transparent", T.red, { fontSize: 10, padding: "1px 0", border: "none", display: "block", width: "100%", textAlign: "center" }) }}>Remove</button>}
            </div>

            <div style={{ flex: 1 }}>
              {/* Name */}
              <label style={lbl}>Family Name</label>
              <input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. The Smiths" />

              {/* Home tab */}
              <div>
                <label style={lbl}>Home Screen</label>
                <select style={inp} value={form.homeTab || "calendar"} onChange={e => setForm(f => ({ ...f, homeTab: e.target.value }))}>
                  {TABS.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
                </select>
              </div>

              {/* PIN — only editable for own family or new */}
              {(editing === "new" || isOwn(editing)) && (
                <>
                  <label style={lbl}>{editing === "new" ? "Set PIN" : "New PIN (leave blank to keep current)"}</label>
                  <input style={{ ...inp, letterSpacing: 8, fontSize: 16, fontWeight: 700 }}
                    type="password" maxLength={4} pattern="[0-9]*" inputMode="numeric"
                    value={form.pinInput || ""} placeholder={editing === "new" ? "••••" : "(unchanged)"}
                    onChange={e => setForm(f => ({ ...f, pinInput: e.target.value.replace(/\D/g, "").slice(0, 4) }))} />
                  {editing === "new" && form.pinInput.length > 0 && form.pinInput.length < 4 &&
                    <p style={{ color: T.accent, fontSize: 11, margin: "4px 0 0" }}>Enter 4 digits</p>}
                </>
              )}
              {editing !== "new" && !isOwn(editing) && (
                <p style={{ color: T.textDim, fontSize: 12, marginTop: 10, fontStyle: "italic" }}>Sign in as this family to change their PIN.</p>
              )}
            </div>
          </div>

          {/* Emoji picker */}
          <label style={lbl}>Emoji</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
            {FAMILY_EMOJIS.map(em => (
              <button key={em} onClick={() => setForm(f => ({ ...f, emoji: em }))}
                style={{ fontSize: 22, padding: "6px 8px", borderRadius: T.radiusSm, border: `2px solid ${form.emoji === em ? form.color : T.border}`, background: form.emoji === em ? form.color + "15" : "transparent", cursor: "pointer" }}>
                {em}
              </button>
            ))}
          </div>

          {/* Colour picker */}
          <label style={lbl}>Colour</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
            {FAMILY_COLORS.map(col => (
              <button key={col} onClick={() => setForm(f => ({ ...f, color: col }))}
                style={{ width: 28, height: 28, borderRadius: "50%", background: col, border: `3px solid ${form.color === col ? "#333" : "transparent"}`, cursor: "pointer", boxShadow: form.color === col ? "0 0 0 2px white, 0 0 0 4px " + col : "none" }}>
              </button>
            ))}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <button onClick={save}
              disabled={!form.name.trim() || (editing === "new" && form.pinInput.length !== 4)}
              style={{ ...btn(T.primary, T.surface), opacity: (!form.name.trim() || (editing === "new" && form.pinInput.length !== 4)) ? 0.5 : 1 }}>
              {editing === "new" ? "Add Family" : "Save Changes"}
            </button>
            <button onClick={cancel} style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}` }) }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Family list */}
      <div style={{ display: "grid", gap: 10 }}>
        {(families || []).map(f => (
          <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", background: T.surface, borderRadius: T.radiusSm, border: `1.5px solid ${f.id === currentFamilyId ? f.color + "60" : T.border}`, boxShadow: f.id === currentFamilyId ? `0 0 0 1px ${f.color}20` : T.shadow }}>
            {/* Avatar */}
            {f.photo
              ? <img src={f.photo} alt={f.name} style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", border: `3px solid ${f.color}50`, flexShrink: 0 }} />
              : <div style={{ width: 44, height: 44, borderRadius: "50%", background: f.color + "20", border: `3px solid ${f.color}50`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>{f.emoji}</div>
            }
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: T.text, fontSize: 14 }}>{f.name}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: f.color, flexShrink: 0 }} />
                <span style={{ color: T.textDim, fontSize: 11, letterSpacing: 3 }}>{"●".repeat(f.pin.length)}</span>
                {f.id === currentFamilyId && <span style={{ ...pill(f.color + "20", f.color), fontSize: 10 }}>You</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {f.id === currentFamilyId ? (
                <button onClick={() => startEdit(f)} style={{ ...btn(T.primary + "15", T.primary, { fontSize: 12, padding: "6px 12px", border: `1px solid ${T.primary}30` }) }}>Edit</button>
              ) : families.length > 1 ? (
                <button onClick={() => setConfirmDel(f)}
                  style={{ ...btn(T.red + "15", T.red, { fontSize: 12, padding: "6px 12px", border: `1px solid ${T.red}25` }) }}>
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {/* Confirm delete */}
      {confirmDel && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,46,26,0.5)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500, padding: 16 }} onClick={() => { setConfirmDel(null); setAdminPin(""); setAdminError(""); }}>
          <div style={{ ...card({ padding: 24 }), width: 340, maxWidth: "92vw", boxShadow: T.shadowLg, textAlign: "center" }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 52, height: 52, borderRadius: 99, background: T.red + "15", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", fontSize: 28 }}>🛡️</div>
            <p style={{ color: T.text, fontSize: 15, fontWeight: 700, margin: "0 0 4px" }}>Remove {confirmDel.name}?</p>
            <p style={{ color: T.textMuted, fontSize: 12, margin: "0 0 18px", lineHeight: 1.5 }}>
              Their bookings and reviews will remain, but they won't be able to sign in.<br />
              Enter the <b>admin passcode</b> to confirm.
            </p>
            <input
              style={{ ...inp, letterSpacing: 10, fontSize: 20, fontWeight: 700, textAlign: "center", marginBottom: 8 }}
              type="password" maxLength={4} pattern="[0-9]*" inputMode="numeric"
              placeholder="••••" value={adminPin}
              onChange={e => { setAdminPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setAdminError(""); }}
              autoFocus />
            {adminError && <p style={{ color: T.red, fontSize: 12, margin: "4px 0 8px" }}>{adminError}</p>}
            <p style={{ color: T.textDim, fontSize: 11, margin: "4px 0 16px" }}>Default admin passcode: 9999</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => { setConfirmDel(null); setAdminPin(""); setAdminError(""); }}
                style={{ ...btn("transparent", T.textMuted, { flex: 1, border: `1px solid ${T.border}` }) }}>Cancel</button>
              <button
                disabled={adminPin.length !== 4}
                onClick={() => {
                  if (adminPin === ADMIN_PIN) {
                    dispatch({ type: "DEL_FAMILY", id: confirmDel.id });
                    setConfirmDel(null); setAdminPin(""); setAdminError("");
                  } else {
                    setAdminError("Incorrect passcode.");
                    setAdminPin("");
                  }
                }}
                style={{ ...btn(T.red, T.surface, { flex: 1 }), opacity: adminPin.length !== 4 ? 0.5 : 1 }}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ERROR BOUNDARY ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, background: "#fff3f3", borderRadius: 12, border: "1px solid #fca5a5", margin: 8 }}>
          <p style={{ fontWeight: 700, color: "#c1440e", marginBottom: 8 }}>Something went wrong</p>
          <pre style={{ fontSize: 11, color: "#666", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {this.state.error.toString()}
          </pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 8, padding: "6px 12px", background: "#c1440e", color: "white", border: "none", borderRadius: 8, cursor: "pointer" }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}


// ─── ACTIVITY LOG ─────────────────────────────────────────────────────────────
function ActivityLog({ families }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await supa.get("activity_log", "order=created_at.desc&limit=100");
      setLogs(data || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fam = id => (families || []).find(f => f.id === id);
  const dayLabel = ts => {
    const d = new Date(ts);
    const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
  };

  // Group logs by day
  const grouped = logs.reduce((acc, log) => {
    const key = log.created_at ? new Date(log.created_at).toDateString() : "Unknown";
    if (!acc[key]) { acc[key] = { label: log.created_at ? dayLabel(log.created_at) : "Unknown", items: [] }; }
    acc[key].items.push(log);
    return acc;
  }, {});

  return (
    <div style={{ ...card({ padding: 14, marginBottom: 12 }) }}>
      <button onClick={() => { setOpen(!open); if (!open) load(); }}
        style={{ ...btn("transparent", T.textMuted, { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: 0, border: "none" }) }}>
        <p style={{ ...sectionHead, margin: 0 }}>Activity Log</p>
        <span style={{ fontSize: 11, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <button onClick={load} style={{ ...btn(T.bg, T.textMuted, { fontSize: 11, padding: "4px 10px", border: `1px solid ${T.border}`, marginBottom: 10 }) }}>↻ Refresh</button>
          {loading && <p style={{ color: T.textDim, fontSize: 13 }}>Loading...</p>}
          {!loading && logs.length === 0 && <p style={{ color: T.textDim, fontSize: 13 }}>No activity recorded yet.</p>}
          {Object.values(grouped).map((group, gi) => (
            <div key={gi} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6, paddingBottom: 4, borderBottom: `1px solid ${T.borderLight}` }}>
                {group.label}
              </div>
              {group.items.map((log, i) => {
                const f = fam(log.family_id);
                return (
                  <div key={i} style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: i < group.items.length - 1 ? `1px solid ${T.borderLight}` : "none", alignItems: "flex-start" }}>
                    <div style={{ fontSize: 16, lineHeight: 1, marginTop: 1, flexShrink: 0 }}>{f?.emoji || "🚐"}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{log.action}</div>
                      {log.detail && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{log.detail}</div>}
                    </div>
                    <div style={{ fontSize: 10, color: T.textDim, flexShrink: 0, paddingTop: 2 }}>
                      {log.created_at ? new Date(log.created_at).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" }) : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── SETTINGS PANEL ───────────────────────────────────────────────────
// App settings — appearance, van identity, family management, backup

function SettingsPanel({ state, dispatch, currentFamilyId, themeMode, onToggleTheme }) {
  if (!state) return null;
  const families = state.families || [];
  const { vanPhoto, vanName } = state;
  const [newVanName, setNewVanName] = useState(vanName);
  const [vanNameSaved, setVanNameSaved] = useState(false);
  const handleVanPhoto = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const path = `van/photo-${Date.now()}.${file.name.split(".").pop()}`;
      const url = await supa.uploadImage(file, path);
      dispatch({ type: "SET_VAN_PHOTO", payload: url });
    } catch (err) {
      const r = new FileReader();
      r.onload = () => dispatch({ type: "SET_VAN_PHOTO", payload: r.result });
      r.readAsDataURL(file);
    }
  };
  const saveVanName = () => { dispatch({ type: "SET_VAN_NAME", payload: newVanName }); setVanNameSaved(true); setTimeout(() => setVanNameSaved(false), 2000); };

  return (
    <div>
      <div style={{ ...card({ padding: 14, marginBottom: 12 }) }}>
        <p style={{ ...sectionHead, marginBottom: 10 }}>Appearance</p>
        <div style={{ display: "flex", gap: 8 }}>
          {[["light", "☀️ Light"], ["dark", "🌙 Dark"]].map(([m, label]) => (
            <button key={m} onClick={() => onToggleTheme(m)}
              style={{
                flex: 1, padding: "10px", border: `2px solid ${themeMode === m ? T.primary : T.border}`,
                borderRadius: T.radiusSm, cursor: "pointer", fontWeight: 700, fontSize: 13,
                background: themeMode === m ? T.primary + "15" : T.surface,
                color: themeMode === m ? T.primary : T.textMuted
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* Van identity */}
      <div style={{ ...card({ padding: 14, marginBottom: 12 }) }}>
        <p style={{ ...sectionHead, marginBottom: 14 }}>Van Identity</p>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ width: 140, height: 100, borderRadius: T.radiusSm, overflow: "hidden", border: `2px dashed ${T.border}`, background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, cursor: "pointer" }}
              onClick={() => document.getElementById("van-photo-input").click()}>
              {vanPhoto
                ? <img src={vanPhoto} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt="van" />
                : <><div style={{ fontSize: 32 }}>🚐</div><span style={{ fontSize: 11, color: T.textDim }}>Add photo</span></>
              }
            </div>
            <input id="van-photo-input" type="file" accept="image/*" style={{ display: "none" }} onChange={handleVanPhoto} />
            {vanPhoto && <button onClick={() => dispatch({ type: "SET_VAN_PHOTO", payload: null })} style={{ ...btn(T.red + "15", T.red, { fontSize: 11, marginTop: 6, padding: "4px 10px", border: `1px solid ${T.red}25` }) }}>Remove photo</button>}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={lbl}>Van / Hub Name</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input style={inp} value={newVanName} onChange={e => setNewVanName(e.target.value)} placeholder="e.g. The Family Campervan" onKeyDown={e => e.key === "Enter" && saveVanName()} />
              <button onClick={saveVanName} style={btn(T.primary, T.surface)}>{vanNameSaved ? "Saved!" : "Save"}</button>
            </div>
            <p style={{ color: T.textDim, fontSize: 12, marginTop: 6 }}>Shown on the sign-in screen.</p>
          </div>
        </div>
      </div>

      {/* All Families manager */}
      <FamilyManager families={families} dispatch={dispatch} currentFamilyId={currentFamilyId} />

      {/* Activity Log */}
      <ActivityLog families={families} />

      {/* Backup & Restore */}
      <div style={{ ...card({ padding: 14, marginBottom: 12 }) }}>
        <p style={{ ...sectionHead, marginBottom: 10 }}>Backup & Restore</p>
        <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
          Download a backup of all app data to your device, or restore from a previous backup file.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => {
            const data = JSON.stringify({
              families: state.families,
              bookings: state.bookings,
              places: state.places,
              itineraries: state.itineraries,
              equipment: state.equipment,
              packingByFamily: state.packingByFamily,
              guides: state.guides,
              rules: state.rules,
              odoLog: state.odoLog,
              odoRate: state.odoRate,
              vanName: state.vanName,
              vanPhoto: state.vanPhoto,
              vanManual: state.vanManual,
              exportedAt: new Date().toISOString(),
              version: "2.0"
            }, null, 2);
            const blob = new Blob([data], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `adventure-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click(); URL.revokeObjectURL(url);
          }} style={btn(T.primary, T.surface, { fontSize: 12 })}>
            ⬇️ Download Backup
          </button>
          <label style={{ ...btn(T.bg, T.textMuted, { fontSize: 12, border: `1px solid ${T.border}`, cursor: "pointer" }) }}>
            📂 Restore from File
            <input type="file" accept=".json" style={{ display: "none" }} onChange={e => {
              const file = e.target.files[0]; if (!file) return;
              const reader = new FileReader();
              reader.onload = ev => {
                try {
                  const data = JSON.parse(ev.target.result);
                  if (!data.version) throw new Error("Invalid backup file");
                  if (data.families) dispatch({ type: "RESET_FAMILIES", payload: data.families });
                  if (data.bookings) dispatch({ type: "RESET_BOOKINGS", payload: data.bookings });
                  if (data.places) dispatch({ type: "RESET_PLACES", payload: data.places });
                  if (data.itineraries) dispatch({ type: "RESET_ITINERARIES", payload: data.itineraries });
                  if (data.equipment) dispatch({ type: "RESET_EQUIPMENT", payload: data.equipment });
                  if (data.packingByFamily) dispatch({ type: "RESET_PACKING", payload: data.packingByFamily });
                  if (data.guides) dispatch({ type: "RESET_GUIDES", payload: data.guides });
                  if (data.rules) dispatch({ type: "RESET_RULES", payload: data.rules });
                  if (data.vanName) dispatch({ type: "SET_VAN_NAME", payload: data.vanName });
                  if (data.vanPhoto) dispatch({ type: "SET_VAN_PHOTO", payload: data.vanPhoto });
                  if (data.vanManual) dispatch({ type: "SET_VAN_MANUAL", payload: data.vanManual });
                  if (data.odoLog) dispatch({ type: "RESET_ODO", payload: data.odoLog });
                  if (data.odoRate) dispatch({ type: "SET_ODO_RATE", payload: data.odoRate });
                  alert("Backup restored successfully!");
                } catch (err) { alert("Error reading backup file: " + err.message); }
              };
              reader.readAsText(file);
            }} />
          </label>
        </div>
      </div>

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP SHELL
// ═══════════════════════════════════════════════════════════════════════════════
const TABS = [
  { id: "calendar", label: "Bookings", icon: "📅" },
  { id: "trips", label: "Our Trips", icon: "🗺️" },
  { id: "places", label: "Places", icon: "📍" },
  { id: "kit", label: "Kit & Pack", icon: "🎒" },
  { id: "guides", label: "How-To", icon: "📖" },
  { id: "odo", label: "Odometer", icon: "🔢" },
  { id: "rules", label: "Rules", icon: "📜" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];


// ─── ODOMETER PANEL ───────────────────────────────────────────────────────────
function OdometerPanel({ odoLog, odoRate, dispatch, families, bookings, currentFamilyId }) {
  const [rateEdit, setRateEdit] = useState(false);
  const [newRate, setNewRate] = useState(String(odoRate || 0.30));
  const [view, setView] = useState("log"); // log | summary


  // Per-family km totals
  const fColor = id => families.find(f => f.id === id)?.color || T.primary;
  const fName = id => families.find(f => f.id === id)?.name || "Unknown";

  const thisYear = new Date().getFullYear();
  const familyStats = families.filter(f => f.id !== "maintenance").map(f => {
    const entries = odoLog.filter(e => e.familyId === f.id);
    const thisYearEntries = entries.filter(e => e.date && e.date.startsWith(String(thisYear)));
    const totalKm = entries.reduce((s, e) => s + (e.endKm - e.startKm), 0);
    const yearKm = thisYearEntries.reduce((s, e) => s + (e.endKm - e.startKm), 0);
    const yearTolls = thisYearEntries.reduce((s, e) => s + (e.tolls || 0), 0);
    return { ...f, totalKm, yearKm, yearTolls, trips: entries.length };
  });

  const grandTotal = odoLog.reduce((s, e) => s + (e.endKm - e.startKm), 0);
  const yearTotal = odoLog.filter(e => e.date?.startsWith(String(thisYear))).reduce((s, e) => s + (e.endKm - e.startKm), 0);

  // Latest odometer reading
  const latestReading = odoLog.length > 0 ? Math.max(...odoLog.map(e => e.endKm)) : null;


  return (
    <div>
      {/* Header stats */}
      <div style={{ ...card({ padding: 14, marginBottom: 12 }) }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <p style={{ ...sectionHead, margin: "0 0 4px" }}>{thisYear} Odometer</p>
            {latestReading && <p style={{ color: T.textDim, fontSize: 12, margin: 0 }}>Current: {latestReading.toLocaleString()} km</p>}
          </div>
          <div style={{ textAlign: "right" }}>
            {rateEdit ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: T.textMuted }}>$</span>
                <input style={{ ...inp, width: 64, padding: "4px 8px", fontSize: 13 }} value={newRate}
                  onChange={e => setNewRate(e.target.value)} type="number" step="0.01" />
                <span style={{ fontSize: 12, color: T.textMuted }}>/km</span>
                <button onClick={() => { dispatch({ type: "SET_ODO_RATE", payload: parseFloat(newRate) || 0.30 }); setRateEdit(false); }}
                  style={{ ...btn(T.primary, T.surface, { fontSize: 11, padding: "4px 8px" }) }}>Save</button>
              </div>
            ) : (
              <button onClick={() => { setNewRate(String(odoRate)); setRateEdit(true); }}
                style={{ ...btn("transparent", T.textMuted, { border: `1px solid ${T.border}`, fontSize: 12, padding: "4px 10px" }) }}>
                ${(odoRate || 0.30).toFixed(2)}/km ✏️
              </button>
            )}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div style={{ background: T.primary + "10", borderRadius: T.radiusSm, padding: "10px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: T.primary }}>{yearTotal.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>{thisYear} km total</div>
          </div>
          <div style={{ background: T.accent + "10", borderRadius: T.radiusSm, padding: "10px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: T.accent }}>${(yearTotal * (odoRate || 0.30) + odoLog.filter(e => e.date?.startsWith(String(thisYear))).reduce((s, e) => s + (e.tolls || 0), 0)).toFixed(0)}</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>{thisYear} cost (km + tolls)</div>
          </div>
        </div>
      </div>

      {/* Per-family breakdown */}
      <div style={{ ...card({ padding: 14, marginBottom: 12 }) }}>
        <p style={{ ...sectionHead, marginBottom: 10 }}>Family Breakdown — {thisYear}</p>
        {familyStats.map(f => {
          const pct = yearTotal > 0 ? Math.round((f.yearKm / yearTotal) * 100) : 0;
          const cost = f.yearKm * (odoRate || 0.30);
          return (
            <div key={f.id} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>
                  <FamilyAvatar family={f} size={16} fontSize={12} /> {f.name}
                </span>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontWeight: 700, color: f.color, fontSize: 13 }}>{f.yearKm.toLocaleString()} km</span>
                  <span style={{ color: T.textDim, fontSize: 11, marginLeft: 8 }}>${(f.yearKm * (odoRate || 0.30) + f.yearTolls).toFixed(0)}{f.yearTolls > 0 && <span style={{ color: T.accent }}> (+${f.yearTolls.toFixed(0)} tolls)</span>}</span>
                </div>
              </div>
              <div style={{ background: T.bg, borderRadius: 99, height: 8, overflow: "hidden", border: `1px solid ${T.border}` }}>
                <div style={{ width: `${pct}%`, background: f.color, height: "100%", borderRadius: 99, transition: "width 0.4s" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
                <span style={{ fontSize: 10, color: T.textDim }}>{pct}% of total km</span>
                <span style={{ fontSize: 10, color: T.textDim }}>{f.trips} trip{f.trips !== 1 ? "s" : ""} all time ({f.totalKm.toLocaleString()} km)</span>
              </div>
            </div>
          );
        })}
        {odoLog.length === 0 && <p style={{ color: T.textDim, fontSize: 13 }}>No entries yet.</p>}
      </div>

      <div style={{ ...card({ padding: 14, marginBottom: 12 }), background: T.primary + "08", border: `1px solid ${T.primary}20` }}>
        <p style={{ fontSize: 13, color: T.textMuted, margin: 0, lineHeight: 1.5 }}>
          📋 Odometer readings are logged on individual bookings in the <b>Bookings</b> tab. This page shows a summary of all recorded trips and costs.
        </p>
      </div>

      {/* Log entries */}
      <div style={{ ...card({ padding: 14 }) }}>
        <p style={{ ...sectionHead, marginBottom: 10 }}>Trip Log</p>
        {odoLog.length === 0 && <p style={{ color: T.textDim, fontSize: 13 }}>No entries logged yet.</p>}
        {odoLog.map(e => {
          const km = e.endKm - e.startKm;
          const cost = km * (odoRate || 0.30);
          const fam = families.find(f => f.id === e.familyId);
          const isPaid = e.paid;
          return (
            <div key={e.id} style={{ display: "flex", gap: 10, padding: "10px 0", borderBottom: `1px solid ${T.borderLight}`, alignItems: "flex-start" }}>
              <div style={{ width: 4, borderRadius: 2, background: fam?.color || T.primary, alignSelf: "stretch", flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <span style={{ fontWeight: 700, color: T.text, fontSize: 13 }}>{km.toLocaleString()} km</span>
                    <span style={{ color: isPaid ? T.green : T.accent, fontSize: 11, marginLeft: 8, fontWeight: 700 }}>${cost.toFixed(2)}</span>
                    <span style={{ ...pill(isPaid ? T.green + "15" : T.accent + "15", isPaid ? T.green : T.accent), fontSize: 9, marginLeft: 4 }}>{isPaid ? "✓ Paid" : "To Pay"}</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, color: fam?.color || T.primary, fontWeight: 600 }}>{fam?.name || "?"}</div>
                    <div style={{ fontSize: 11, color: T.textDim }}>{e.date}</div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                  {e.startKm.toLocaleString()} → {e.endKm.toLocaleString()} km
                  {(e.tolls || 0) > 0 && <span style={{ color: T.accent }}> &middot; tolls ${e.tolls?.toFixed(2)}</span>}
                  {e.notes && <span style={{ fontStyle: "italic" }}> &middot; {e.notes}</span>}
                </div>
              </div>
              {e.familyId === currentFamilyId && (
                <DeleteButton label="Delete" message="Delete this odometer entry?" detail={`${km} km on ${e.date}`}
                  onConfirm={() => dispatch({ type: "DEL_ODO", id: e.id })} style={{ fontSize: 11, padding: "3px 8px" }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ─── BOOKING LIST ─────────────────────────────────────────────────────
// List view of bookings used inside the calendar tab

function BookingList({ bookings, dispatch, families, onOpenItinerary, currentFamilyId, odoLog, odoRate, onAddOdo }) {
  const sorted = [...bookings].sort((a, b) => a.start.localeCompare(b.start));
  const upcoming = sorted.filter(b => b.end >= fmt(TODAY));
  const past = sorted.filter(b => b.end < fmt(TODAY));
  const cardProps = { families, onOpenItinerary, currentFamilyId, dispatch, odoLog, odoRate, onAddOdo };
  return (
    <div>
      <p style={sectionHead}>Upcoming ({upcoming.length})</p>
      {upcoming.length === 0
        ? <div style={{ ...card({ padding: 24, textAlign: "center" }) }}>
          <p style={{ color: T.textDim, fontSize: 14, margin: 0 }}>No upcoming bookings yet.</p>
        </div>
        : upcoming.map(b => <BookingCard key={b.id} b={b} {...cardProps} />)
      }
      {past.length > 0 && (
        <>
          <p style={{ ...sectionHead, marginTop: 24 }}>Past ({past.length})</p>
          {past.map(b => <BookingCard key={b.id} b={b} {...cardProps} />)}
        </>
      )}
    </div>
  );
}


// ─── COLLAPSIBLE BOOKINGS ─────────────────────────────────────────────
// Expandable bookings section in the calendar tab

function CollapsibleBookings(props) {
  const [showBookings, setShowBookings] = useState(false);
  const upcoming = (props.bookings || []).filter(b => b.end >= fmt(new Date())).length;
  return (
    <>
      <button onClick={() => setShowBookings(!showBookings)}
        style={{ ...btn("transparent", T.textMuted, { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", border: `1px solid ${T.border}`, borderRadius: showBookings ? `${T.radius} ${T.radius} 0 0` : T.radius, marginTop: 12 }) }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>
          📋 Bookings
          {upcoming > 0 && <span style={{ ...pill(T.primary + "15", T.primary), fontSize: 10, marginLeft: 6 }}>{upcoming} upcoming</span>}
        </span>
        <span style={{ fontSize: 11, transform: showBookings ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▼</span>
      </button>
      {showBookings && (
        <div style={{ border: `1px solid ${T.border}`, borderTop: "none", borderRadius: `0 0 ${T.radius} ${T.radius}`, padding: 12 }}>
          <BookingList {...props} />
        </div>
      )}
    </>
  );
}


export default function App() {
  const timeoutMinutes = 5; // Auto-logout after 5 minutes of inactivity
  const AUTO_LOGOUT_MS = timeoutMinutes * 60 * 1000; // {timeoutMinutes} minutes — change as you like
  const [state, dispatch] = useReducer(reducer, INIT);
  const [themeMode, setThemeMode] = useState(() => {
    try { return localStorage.getItem("theme-mode") || "light"; } catch (e) { return "light"; }
  });
  const [, forceRender] = useState(0);
  const toggleTheme = (mode) => { applyTheme(mode); setThemeMode(mode); forceRender(n => n + 1); };

  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState(false);
  const [showTimeoutPopup, setShowTimeoutPopup] = useState(false);
  const loadingRef = useRef(true);

  // ── Load all data from Supabase on mount ─────────────────────────────────
  useEffect(() => {
    async function loadAll() {
      try {
        // ── Phase 1: Essential data — show app ASAP ───────────────────────
        const [families, vs, bookings] = await Promise.all([
          supa.get("families", "order=name"),
          supa.get("van_settings", "id=eq.1"),
          supa.get("bookings", "order=start_date"),
        ]);

        if (families && families.length > 0) dispatch({ type: "RESET_FAMILIES", payload: families.map(f => fromDB.family(f)) });

        const vans = Array.isArray(vs) ? vs : [vs];
        if (vans[0]) {
          if (vans[0].van_name) dispatch({ type: "SET_VAN_NAME", payload: vans[0].van_name });
          if (vans[0].van_photo) dispatch({ type: "SET_VAN_PHOTO", payload: vans[0].van_photo });
          if (vans[0].van_manual) dispatch({ type: "SET_VAN_MANUAL", payload: vans[0].van_manual });
          if (vans[0].odo_rate) dispatch({ type: "SET_ODO_RATE", payload: vans[0].odo_rate });
        }

        dispatch({ type: "RESET_BOOKINGS", payload: (bookings || []).map(fromDB.booking).filter(Boolean) });

        // App is usable now — show it
        setLoading(false); loadingRef.current = false;

        // ── Phase 2: Background load everything else ──────────────────────
        const [places, reviews, equipment, packing, itins, guides, rules, odoLog] = await Promise.all([
          supa.get("places", "order=name"),
          supa.get("reviews", "order=place_id"),
          supa.get("equipment", "order=category,item"),
          supa.get("family_packing", "order=category,item"),
          supa.get("itineraries", "order=start_date"),
          supa.get("guides", "order=title"),
          supa.get("rules", "order=id"),
          supa.get("odometer_log", "order=date.desc"),
        ]);

        const placesWithReviews = (places || []).map(p => {
          const pr = (reviews || []).filter(r => r.place_id === p.id);
          return {
            ...fromDB.place(p), reviews: pr.map(fromDB.review),
            overallRating: pr.length ? Math.round(pr.reduce((a, r) => a + r.rating, 0) / pr.length) : 0
          };
        });
        dispatch({ type: "RESET_PLACES", payload: placesWithReviews });
        dispatch({ type: "RESET_EQUIPMENT", payload: (equipment || []).map(fromDB.equip).filter(Boolean) });

        const pbf = {};
        (packing || []).forEach(p => { if (!pbf[p.family_id]) pbf[p.family_id] = []; pbf[p.family_id].push(fromDB.packing(p)); });
        dispatch({ type: "RESET_PACKING", payload: pbf });

        dispatch({ type: "RESET_ITINERARIES", payload: (itins || []).map(fromDB.itin).filter(Boolean) });

        if (guides && guides.length > 0) { dispatch({ type: "RESET_GUIDES", payload: guides.map(fromDB.guide) }); }
        else {
          dispatch({ type: "RESET_GUIDES", payload: SEED_GUIDES });
          for (const g of SEED_GUIDES) {
            await supa.upsert("guides", { title: g.title, icon: g.icon, content: g.content, links: g.links || [], attachments: g.attachments || [] });
          }
        }
        if (rules && rules.length > 0) { dispatch({ type: "RESET_RULES", payload: rules.map(fromDB.rule) }); }
        else {
          dispatch({ type: "RESET_RULES", payload: SEED_RULES });
          for (const r of SEED_RULES) {
            await supa.upsert("rules", { icon: r.icon, rule: r.rule, detail: r.detail || "" });
          }
        }

        if (odoLog && odoLog.length > 0) dispatch({
          type: "RESET_ODO", payload: odoLog.map(e => ({
            id: e.id, familyId: e.family_id, date: e.date,
            startKm: e.start_km, endKm: e.end_km,
            tolls: e.tolls || 0, paid: e.paid || false,
            notes: e.notes || "", bookingId: e.booking_id || ""
          }))
        });

      } catch (e) {
        console.error("Supabase load error:", e);
        setDbError(true);
        setLoading(false); loadingRef.current = false;
      }
    }
    loadAll();
  }, []);

  // Prevent iOS from zooming on input focus (requires font-size >= 16px on inputs)
  // and set correct viewport — injected once on mount
  useEffect(() => {
    // Set viewport to prevent zoom
    let meta = document.querySelector("meta[name=viewport]");
    if (!meta) { meta = document.createElement("meta"); meta.name = "viewport"; document.head.appendChild(meta); }
    meta.content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
    // Ensure inputs don't trigger zoom: font-size must be >= 16px on iOS
    const style = document.createElement("style");
    style.id = "no-zoom-style";
    style.textContent = `
      input, textarea, select { font-size: 16px !important; }
      .leaflet-container,
      .leaflet-container *,
      .leaflet-map-pane,
      .leaflet-tile-pane,
      .leaflet-overlay-pane,
      .leaflet-marker-pane,
      .leaflet-tooltip-pane,
      .leaflet-popup-pane,
      .leaflet-pane {
        touch-action: none !important;
      }
    `;
    if (!document.getElementById("no-zoom-style")) document.head.appendChild(style);
  }, []);
  useEffect(() => { applyTheme(themeMode); }, []);
  const [tab, setTab] = useState(() => {
    try { return sessionStorage.getItem("currentTab") || "calendar"; } catch (e) { return "calendar"; }
  });
  // Set tab to family's homeTab when they sign in
  const [guestBooking, setGuestBooking] = useState(null);

  const handleLogin = (familyId, booking = null) => {
    if (familyId === "__guest__") {
      setGuestBooking(booking);
      setCurrentFamily("__guest__");
      try { sessionStorage.setItem("currentFamily", "__guest__"); sessionStorage.setItem("lastActive", String(Date.now())); } catch (e) {}
      return;
    }
    const fam = state.families.find(f => f.id === familyId);
    setTab(fam?.homeTab || "calendar");
    setCurrentFamily(familyId);
    try { sessionStorage.setItem("currentFamily", familyId); sessionStorage.setItem("lastActive", String(Date.now())); } catch (e) {}
  };
  const [showBook, setShowBook] = useState(() => {
    try { return sessionStorage.getItem("showBookingForm") === "1"; } catch (e) { return false; }
  });
  const [currentFamily, setCurrentFamily] = useState(() => {
    try {
      const fam = sessionStorage.getItem("currentFamily");
      const lastActive = parseInt(sessionStorage.getItem("lastActive") || "0", 10);
      if (fam && Date.now() - lastActive > AUTO_LOGOUT_MS) {
        sessionStorage.removeItem("currentFamily");
        sessionStorage.removeItem("lastActive");
        return null;
      }
      return fam || null;
    } catch (e) { return null; }
  });
  const [openItinId, setOpenItinId] = useState(null); // itinerary to auto-open in Trips tab
  const currentTab = TABS.find(t => t.id === tab) || TABS[0];
  const { families } = state;
  const fColor = id => families.find(f => f.id === id)?.color ?? T.primary;
  const fName = id => families.find(f => f.id === id)?.name ?? "Unknown";
  const fEmoji = id => families.find(f => f.id === id)?.emoji ?? "";

  // ── Supabase-aware dispatch: persist every action to DB ─────────────────
  const logActivity = async (action, detail) => {
    try {
      await supa.insert("activity_log", {
        family_id: currentFamily,
        action,
        detail,
        created_at: new Date().toISOString()
      });
    } catch (e) { console.warn("Log failed:", e); }
  };

  const sbDispatch = useCallback(async ({ type, payload, id }) => {
    // Always update local state immediately (optimistic)
    dispatch({ type, payload, id });
    if (loadingRef.current && type.startsWith("RESET")) return; // Don't write bulk load actions

    try {
      // Never write bulk load actions to DB
      if (type.startsWith("RESET_")) return;
      switch (type) {
        // BOOKINGS
        case "ADD_BOOKING":
          if (!payload.days || payload.days.length === 0) payload = { ...payload, days: generateDays(payload.start, payload.end) };
          await supa.upsert("bookings", toDB.booking(payload));
          await logActivity("Added booking", `${payload.destination} (${payload.start} to ${payload.end})`);

          break;
        case "DEL_BOOKING": await supa.delete("bookings", { id });
          await logActivity("Deleted booking", `Booking ID: ${id}`); break;
        case "UPD_BOOKING_DAYS":
          await supa.update("bookings", { days: payload.days, ...(payload.notes !== undefined ? { notes: payload.notes } : {}) }, { id: payload.id });
          break;
        case "UPD_BOOKING_COLLAB":
          await supa.update("bookings", { collaborators: payload.collaborators }, { id: payload.id });
          break;
        case "UPD_BOOKING": {
          // Clash check before updating dates
          if (payload.start && payload.end) {
            const clash = state.bookings.filter(b =>
              b.id !== payload.id && b.status === "confirmed" &&
              payload.start <= b.end && payload.end >= b.start
            );
            if (clash.length) { alert("Date change blocked — clashes with: " + clash.map(b => b.destination).join(", ")); break; }
          }
          await supa.update("bookings", {
            start_date: payload.start, end_date: payload.end,
            ...(payload.destination ? { destination: payload.destination } : {}),
            ...(payload.guests !== undefined ? { guests: payload.guests } : {}),
            ...(payload.guestPin !== undefined ? { guest_pin: payload.guestPin } : {}),
            ...(payload.guestName !== undefined ? { guest_name: payload.guestName } : {})
          }, { id: payload.id });
          break;
        }
        case "CONFIRM_BOOKING":
          await supa.update("bookings", { status: "confirmed" }, { id });
          break;
                case "ADD_PLACE": await supa.upsert("places", toDB.place(payload)); break;
        case "DEL_PLACE": await supa.delete("places", { id });
          {
            const pl = state.places.find(p => p.id === id);
            await logActivity("Deleted place", pl?.name || id);
          } break;
        case "ADD_REVIEW":
          await supa.insert("reviews", toDB.review(payload.placeId, payload.review));
          // Update overall rating
          const allRevs = await supa.get("reviews", "place_id=eq." + payload.placeId);
          const avg = allRevs.length ? Math.round(allRevs.reduce((a, r) => a + r.rating, 0) / allRevs.length) : 0;
          await supa.update("places", { overall_rating: avg }, { id: payload.placeId });
          break;
        // EQUIPMENT (shared van kit)
        case "SET_EQUIPMENT":
          if (!payload || payload.length === 0) break; // never wipe DB with empty array
          for (const e of payload) await supa.upsert("equipment", toDB.equip(e));
          // Delete any items removed (in DB but not in payload)
          {
            const ids = payload.map(e => e.id);
            const existing = await supa.get("equipment", "select=id");
            for (const row of (existing || [])) {
              if (!ids.includes(row.id)) await supa.delete("equipment", { id: row.id });
            }
          }
          break;
        // FAMILY PACKING (per-family)
        case "SET_FAMILY_PACKING":
          if (!payload || !payload.familyId) break; // guard against bad payload
          // Only delete+reinsert if we have items OR explicitly clearing
          await supa.delete("family_packing", { family_id: payload.familyId });
          if (payload.items && payload.items.length > 0) {
            for (const p of payload.items) await supa.upsert("family_packing", toDB.packing(payload.familyId, p));
          }
          break;
        // GUIDES
        case "ADD_GUIDE": await supa.upsert("guides", toDB.guide(payload)); break;
        case "UPDATE_GUIDE": await supa.upsert("guides", toDB.guide(payload)); break;
        case "DEL_GUIDE": await supa.delete("guides", { id });
          {
            const g = state.guides.find(g => g.id === id);
            await logActivity("Deleted guide", g?.title || id);
          } break;
                case "SET_RULES":
          for (const r of payload) await supa.upsert("rules", toDB.rule(r));
          break;
        case "ADD_ODO":
          await supa.upsert("odometer_log", {
            id: payload.id, family_id: payload.familyId, date: payload.date,
            start_km: payload.startKm, end_km: payload.endKm,
            tolls: payload.tolls || 0, paid: payload.paid || false,
            notes: payload.notes || "", booking_id: payload.bookingId || null
          });
          await logActivity("Logged odometer", `${payload.startKm} → ${payload.endKm} km (${payload.endKm - payload.startKm} km)`);
          break;
        case "DEL_ODO":
          await supa.delete("odometer_log", { id });
          await logActivity("Deleted odometer entry", `ID: ${id}`);
          break;
        case "MARK_ODO_PAID":
          {
            const entry = state.odoLog.find(e => e.id === id);
            await supa.update("odometer_log", { paid: !entry?.paid }, { id });
          } break;
        case "SET_ODO_RATE":
          await supa.update("van_settings", { odo_rate: payload }, { id: 1 });
          break;
        // ITINERARIES
        case "ADD_ITINERARY": await supa.upsert("itineraries", toDB.itin(payload)); break;
        case "UPDATE_ITINERARY": await supa.upsert("itineraries", toDB.itin(payload)); break;
        case "SET_ITINERARY": await supa.upsert("itineraries", toDB.itin(payload)); break;
        case "DEL_ITINERARY": await supa.delete("itineraries", { id });
          {
            const it = state.itineraries.find(i => i.id === id);
            await logActivity("Deleted trip", it?.title || id);
          } break;
        // FAMILIES
        case "ADD_FAMILY": await supa.upsert("families", toDB.family(payload)); break;
        case "UPDATE_FAMILY": await supa.upsert("families", toDB.family(payload)); break;
        case "DEL_FAMILY": await supa.delete("families", { id });
          {
            const f = state.families.find(f => f.id === id);
            await logActivity("Removed family", f?.name || id);
          } break;
        // VAN SETTINGS
        case "SET_VAN_NAME": await supa.update("van_settings", { van_name: payload }, { id: 1 }); break;
        case "SET_VAN_PHOTO": await supa.update("van_settings", { van_photo: payload }, { id: 1 }); break;
        case "SET_VAN_MANUAL": await supa.update("van_settings", { van_manual: payload }, { id: 1 }); break;
        default: break;
      }
    } catch (e) {
      console.error("Supabase write error:", type, e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addPlaceToItinerary = (bookingId, place, dayIndex = 0) => {
    const bk = state.bookings.find(b => b.id === bookingId); if (!bk) return;
    const days = (bk.days || []).map((d, i) => i === dayIndex ? { ...d, activities: [...(d.activities || []), { id: "a" + Date.now(), time: "", title: place.name, placeId: place.id, notes: "", location: place.name }] } : d);
    sbDispatch({ type: "UPD_BOOKING_DAYS", payload: { id: bookingId, days } });
  };


  useEffect(() => {
    try { sessionStorage.setItem("showBookingForm", showBook ? "1" : "0"); } catch (e) { }
  }, [showBook]);

  useEffect(() => {
    try { sessionStorage.setItem("currentTab", tab); } catch (e) { }
  }, [tab]);

  useEffect(() => {
    if (!currentFamily) return;

    const markActive = () => {
      try { sessionStorage.setItem("lastActive", String(Date.now())); } catch (e) { }
    };

    const checkTimeout = () => {
      try {
        const lastActive = parseInt(sessionStorage.getItem("lastActive") || "0", 10);
        if (Date.now() - lastActive > AUTO_LOGOUT_MS) {
          setCurrentFamily(null);
          setShowTimeoutPopup(true);
          sessionStorage.removeItem("currentFamily");
          sessionStorage.removeItem("lastActive");
        }
      } catch (e) { }
    };

    const events = ["click", "touchstart", "keydown"];
    events.forEach(ev => window.addEventListener(ev, markActive));

    const onVisible = () => { if (document.visibilityState === "visible") checkTimeout(); };
    document.addEventListener("visibilitychange", onVisible);

    const interval = setInterval(checkTimeout, 15000); // poll every 15s

    markActive();

    return () => {
      clearInterval(interval);
      events.forEach(ev => window.removeEventListener(ev, markActive));
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [currentFamily]);

  // Called from calendar: open Trips tab and edit a specific itinerary (or create one linked to a booking)
  const handleOpenItinerary = (bookingId) => {
    setOpenItinId(bookingId || null);
    setTab("trips");
  };

  if (loading) return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "Inter,Segoe UI,system-ui,sans-serif" }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🚐</div>
      <p style={{ color: T.primary, fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Adventure Hub</p>
      <p style={{ color: T.textDim, fontSize: 13 }}>{dbError ? "Cannot connect to database — check your connection" : "Loading..."}</p>
      {dbError && <button onClick={() => window.location.reload()} style={{ ...btn(T.primary, T.surface, { marginTop: 16 }) }}>Retry</button>}
    </div>
  );

  if (!currentFamily) return (
    <>
      <LoginScreen families={families} vanPhoto={state.vanPhoto} vanName={state.vanName} onLogin={handleLogin} />
      {showTimeoutPopup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(26,46,26,0.4)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 900, padding: 16 }}
          onClick={() => setShowTimeoutPopup(false)}>
          <div style={{ ...card({ padding: 24 }), width: 320, maxWidth: "92vw", boxShadow: T.shadowLg, textAlign: "center" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ width: 52, height: 52, borderRadius: 99, background: T.accent + "15", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 24 }}>⏱️</div>
            <p style={{ color: T.text, fontSize: 15, fontWeight: 700, margin: "0 0 6px" }}>Session timed out</p>
            <p style={{ color: T.textMuted, fontSize: 13, margin: "0 0 20px", lineHeight: 1.5 }}>
              You were signed out after {timeoutMinutes} minutes of inactivity. Please sign in again.
            </p>
            <button onClick={() => setShowTimeoutPopup(false)} style={{ ...btn(T.primary, T.surface, { width: "100%" }) }}>
              OK
            </button>
          </div>
        </div>
      )}
    </>
  );

  const fam = families.find(f => f.id === currentFamily);
  // Guest user — show restricted GuestApp
  if (currentFamily === "__guest__" && guestBooking) return (
    <GuestApp
      booking={guestBooking}
      places={state.places}
      equipment={state.equipment}
      guides={state.guides}
      rules={state.rules}
      packingByFamily={state.packingByFamily}
      vanName={state.vanName}
      dispatch={sbDispatch}
      onSignOut={() => { setCurrentFamily(null); setGuestBooking(null); try { sessionStorage.removeItem("currentFamily"); } catch(e){} }}
    />
  );
  // If families reloaded from DB and signed-in family not found, sign out
  if (!fam) { setCurrentFamily(null); return null; }

  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: "Inter,Segoe UI,system-ui,sans-serif", color: T.text }}>

      {/* HEADER — two rows so nothing overlaps on mobile */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, zIndex: 50, boxShadow: "0 1px 12px rgba(45,106,79,0.08)" }}>
        <div style={{ maxWidth: 860, margin: "0 auto", padding: "0 12px" }}>

          {/* Row 1: logo left · family pill + sign-out right */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 2.5, color: T.textDim, textTransform: "uppercase", marginBottom: 1 }}>Family Campervan</div>
              <h1 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: T.primary, letterSpacing: -0.3, lineHeight: 1 }}>🚐 {state.vanName}</h1>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ padding: "4px 12px", background: fam.color + "18", border: `1px solid ${fam.color}35`, borderRadius: 99, fontSize: 12, fontWeight: 700, color: fam.color, whiteSpace: "nowrap" }}>
                {fam.photo
                  ? <img src={fam.photo} alt={fam.name} style={{ width: 18, height: 18, borderRadius: "50%", objectFit: "cover", verticalAlign: "middle" }} />
                  : <span>{fam.emoji}</span>} {fam.name.replace("The ", "").trim()}
              </div>
              <button onClick={() => {
                setCurrentFamily(null);
                try {
                  sessionStorage.removeItem("currentFamily");
                  sessionStorage.removeItem("lastActive");
                } catch (e) { }
              }} title="Sign out"
                style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${T.border}`, borderRadius: T.radiusSm, cursor: "pointer", color: T.textMuted }}>
                <svg width="16" height="16" viewBox="0 0 512 512">
                  <g fill="none" fillRule="evenodd">
                    <g fill="currentColor" transform="translate(85.333333, 42.666667)">
                      <path d="M234.666667,-2.13162821e-14 L234.666667,85.3333333 L192.000667,85.333 L192,42.6666667 L42.6666667,42.6666667 L42.6666667,384 L192,384 L192.000667,341.333 L234.666667,341.333333 L234.666667,426.666667 L-4.26325641e-14,426.666667 L-4.26325641e-14,-2.13162821e-14 L234.666667,-2.13162821e-14 Z M292.418278,112.915055 L392.836556,213.333333 L292.418278,313.751611 L262.248389,283.581722 L311.163,234.666 L106.666667,234.666667 L106.666667,192 L311.163,192 L262.248389,143.084945 L292.418278,112.915055 Z" />
                    </g>
                  </g>
                </svg>
              </button>
            </div>
          </div>

          {/* Book button */}

        </div>
      </div>

      {/* CONTENT */}
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "14px 12px 100px" }}>
        {tab === "calendar" && (
          <>
            <div style={card({ padding: 14, marginBottom: 12 })}>
              <CalendarView bookings={state.bookings} families={families} onOpenItinerary={handleOpenItinerary} currentFamilyId={currentFamily} />
            </div>
            <CollapsibleBookings
              bookings={state.bookings} dispatch={sbDispatch} families={families}
              onOpenItinerary={handleOpenItinerary}
              currentFamilyId={currentFamily} odoLog={state.odoLog} odoRate={state.odoRate}
              onAddOdo={e => e._action === "MARK_PAID" ? sbDispatch({ type: "MARK_ODO_PAID", id: e.id }) : sbDispatch({ type: "ADD_ODO", payload: e })}
            />
          </>
        )}
        {tab === "trips" && <TripsPanel bookings={state.bookings} dispatch={sbDispatch} places={state.places} families={families} autoOpenItinId={openItinId} onAutoOpenHandled={() => setOpenItinId(null)} currentFamilyId={currentFamily} odoLog={state.odoLog} odoRate={state.odoRate} onAddOdo={e => e._action === "MARK_PAID" ? sbDispatch({ type: "MARK_ODO_PAID", id: e.id }) : sbDispatch({ type: "ADD_ODO", payload: e })} />}
        {tab === "places" && <PlacesPanel places={state.places} dispatch={sbDispatch} onPickItinerary={addPlaceToItinerary} families={families} currentFamilyId={currentFamily} itineraries={state.itineraries} />}
        {tab === "guides" && <GuidesPanel guides={state.guides} dispatch={sbDispatch} vanManual={state.vanManual} onSetManual={url => sbDispatch({ type: "SET_VAN_MANUAL", payload: url })} />}
        {tab === "kit" && <KitPanel equipment={state.equipment} dispatch={sbDispatch} currentFamilyId={currentFamily} packingByFamily={state.packingByFamily} />}
        {tab === "odo" && <OdometerPanel odoLog={state.odoLog} odoRate={state.odoRate} dispatch={sbDispatch} families={families} bookings={state.bookings} currentFamilyId={currentFamily} />}
        {tab === "rules" && <RulesPanel rules={state.rules} dispatch={sbDispatch} />}
        {tab === "settings" && <ErrorBoundary><SettingsPanel state={state} dispatch={sbDispatch} currentFamilyId={currentFamily} themeMode={themeMode} onToggleTheme={toggleTheme} /></ErrorBoundary>}

        {showBook && <BookingForm bookings={state.bookings} dispatch={sbDispatch} onClose={() => setShowBook(false)} currentFamilyId={currentFamily} families={families} />}

        {/* Safe zone fill — behind everything, same colour as bar */}
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, height: "env(safe-area-inset-bottom)", background: T.surface, zIndex: 499 }} />
        {/* Bottom tab bar — sits above safe zone */}
        <div style={{
          position: "fixed",
          bottom: "env(safe-area-inset-bottom)",
          left: 0, right: 0,
          zIndex: 500,
          background: T.surface,
          boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
          borderTop: `1px solid ${T.border}`,
        }}>
          {/* Icon grid */}
          <div style={{ paddingTop: 8, paddingBottom: 10, height: 94, display: "flex", alignItems: "flex-start" }}>
            {/* Left 2x2 grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "38px 38px", flex: 1, height: 76 }}>
              {TABS.slice(0, 4).map(t => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center",
                    justifyContent: "center", border: "none",
                    borderRadius: T.radiusSm,
                    background: tab === t.id ? T.primary + "25" : "transparent", cursor: "pointer",
                    color: tab === t.id ? T.primary : T.textDim,
                    margin: "2px 3px", padding: "2px 0",
                    boxShadow: tab === t.id ? `0 0 0 1px ${T.primary}35` : "none"
                  }}>
                  <span style={{ fontSize: 26, lineHeight: 1, display: "block" }}>{t.icon}</span>
                  <span style={{ fontSize: 8, fontWeight: tab === t.id ? 700 : 400, marginTop: -2, color: tab === t.id ? T.primary : T.textDim, letterSpacing: 0.2, display: "block" }}>{t.label}</span>
                </button>
              ))}
            </div>
            {/* Centre spacer — holds the layout space */}
            <div style={{ flexShrink: 0, width: 76 }} />
            {/* Right 2x2 grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "38px 38px", flex: 1, height: 76 }}>
              {TABS.slice(4, 8).map(t => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center",
                    justifyContent: "center", border: "none",
                    borderRadius: T.radiusSm,
                    background: tab === t.id ? T.primary + "25" : "transparent", cursor: "pointer",
                    color: tab === t.id ? T.primary : T.textDim,
                    margin: "2px 3px", padding: "2px 0",
                    boxShadow: tab === t.id ? `0 0 0 1px ${T.primary}35` : "none"
                  }}>
                  <span style={{ fontSize: 26, lineHeight: 1, display: "block" }}>{t.icon}</span>
                  <span style={{ fontSize: 8, fontWeight: tab === t.id ? 700 : 400, marginTop: -2, color: tab === t.id ? T.primary : T.textDim, letterSpacing: 0.2, display: "block" }}>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Centre BOOK button — fixed, breaks out of bar, ignores safe zone */}
          <button onClick={() => setShowBook(true)}
            style={{
              position: "fixed",
              left: "50%",
              transform: "translateX(-50%)",
              width: 64,
              bottom: "env(safe-area-inset-bottom)",
              top: "auto",
              height: `calc(84px + 18px + env(safe-area-inset-bottom))`,
              borderRadius: "18px 18px 0 0",
              background: `linear-gradient(160deg,${T.primary},#3a8a5f)`,
              border: "none",
              borderLeft: `1px solid ${T.primary}80`,
              borderRight: `1px solid ${T.primary}80`,
              borderTop: `1px solid ${T.primary}80`,
              cursor: "pointer",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "flex-start",
              paddingTop: 14, gap: 2,
              boxShadow: `-2px -4px 20px ${T.primary}40`,
              color: "white",
              zIndex: 501
            }}>
            <span style={{ fontSize: 30, lineHeight: 1, fontWeight: 300 }}>+</span>
            <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.5, opacity: 0.9 }}>BOOK</span>
          </button>
        </div>
      </div>
    </div>
  );
}
